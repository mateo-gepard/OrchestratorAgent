// Minimal streaming client for the OpenRouter chat completions API.
// Zero dependencies — parses the SSE stream by hand.

import { estimateCost } from './models.js';
import { sleep } from './util.js';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Run one chat completion, streaming.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model        OpenRouter model slug
 * @param {Array}  opts.messages     chat messages (string or content-part arrays)
 * @param {object} [opts.reasoning]  e.g. { effort: 'high' }
 * @param {number} [opts.maxTokens]
 * @param {Array}  [opts.plugins]    e.g. the PDF file-parser plugin
 * @param {Array}  [opts.tools]      OpenAI-style tool definitions
 * @param {string} [opts.toolChoice] e.g. 'none' to force a final text answer
 * @param {string} [opts.fallbackModel]  paid slug to fall back to when opts.model (a :free variant) fails
 * @param {AbortSignal} [opts.signal]
 * @param {(text: string) => void} [opts.onDelta]  called with each content chunk
 * @param {(text: string) => void} [opts.onReasoning]  called with each reasoning ("thinking") chunk
 * @param {() => void} [opts.onRestart]  called when a partially-streamed response is discarded for a retry
 * @returns {Promise<{content: string, reasoning: string, toolCalls: Array, tokensIn: number, tokensOut: number, cost: number, model: string}>}
 */
export async function chat(opts) {
  const { apiKey, model } = opts;
  if (!apiKey) throw new Error('No OpenRouter API key configured. Open Settings and add one.');

  const body = {
    model,
    messages: opts.messages,
    stream: true,
    usage: { include: true },
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.reasoning) body.reasoning = opts.reasoning;
  if (opts.plugins) body.plugins = opts.plugins;
  if (opts.tools) body.tools = opts.tools;
  if (opts.toolChoice) body.tool_choice = opts.toolChoice;

  // Free variants get one shot; the reliable (paid) slug gets the retry budget.
  const routes = opts.fallbackModel && opts.fallbackModel !== model
    ? [{ model, attempts: 1, giveUpFast: true }, { model: opts.fallbackModel, attempts: 3 }]
    : [{ model, attempts: 3 }];

  let lastError;
  for (const route of routes) {
    body.model = route.model;
    for (let attempt = 0; attempt < route.attempts; attempt++) {
      if (attempt > 0) await sleep(attempt * 1500);
      try {
        const res = await streamOnce(body, apiKey, opts);
        res.model = route.model;
        return res;
      } catch (err) {
        if (err.name === 'AbortError' || opts.signal?.aborted) throw err;
        lastError = err;
        // A partially-streamed response can only be retried if the caller can
        // discard what it already rendered.
        if (err.streamed && !opts.onRestart) throw err;
        if (!err.retryable && !route.giveUpFast) throw err;
        if (err.streamed) opts.onRestart();
      }
    }
  }
  throw lastError;
}

async function streamOnce(body, apiKey, opts) {
  const res = await fetch(API_URL, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost',
      'X-Title': 'Maestro Orchestrator',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = `OpenRouter HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed.error?.message) message += `: ${parsed.error.message}`;
    } catch {
      if (text) message += `: ${text.slice(0, 300)}`;
    }
    const err = new Error(message);
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let streamed = false;
  const toolCalls = []; // accumulated by stream index

  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }
        if (obj.error) {
          const err = new Error(`OpenRouter mid-stream error: ${obj.error.message || JSON.stringify(obj.error)}`);
          err.streamed = streamed;
          err.retryable = true; // usually a transient provider failure
          throw err;
        }
        const delta = obj.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          streamed = true;
          opts.onDelta?.(delta.content);
        }
        if (delta?.reasoning) {
          reasoning += delta.reasoning;
          opts.onReasoning?.(delta.reasoning);
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            toolCalls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
          }
        }
        if (obj.usage) usage = obj.usage;
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  const tokensIn = usage?.prompt_tokens ?? 0;
  const tokensOut = usage?.completion_tokens ?? 0;
  const cost = typeof usage?.cost === 'number' ? usage.cost : estimateCost(body.model, tokensIn, tokensOut);

  const calls = toolCalls.filter((c) => c && c.function.name);
  // Some providers stream tool calls without ids — synthesize them.
  calls.forEach((c, i) => { if (!c.id) c.id = `call_${i}_${Date.now()}`; });

  if (!content && !reasoning && !calls.length) {
    const err = new Error(`Model ${body.model} returned an empty response`);
    err.retryable = true;
    throw err;
  }
  return { content, reasoning, toolCalls: calls, tokensIn, tokensOut, cost };
}
