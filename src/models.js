// The curated model fleet available to the orchestrator.
//
// Prices are USD per 1M tokens and act as a static fallback — live prices are
// merged from the public OpenRouter catalog at startup when reachable, and
// models that no longer exist on OpenRouter are marked unavailable so the
// planner never routes to a dead slug.
//
// Edit freely: the orchestrator reads `strengths` / `weaknesses` verbatim when
// deciding routing, so keep them honest and comparative.

export const CATALOG = [
  {
    id: 'anthropic/claude-opus-4.5',
    name: 'Claude Opus 4.5',
    tier: 'frontier',
    priceIn: 5.0,
    priceOut: 25.0,
    context: 200_000,
    vision: true,
    reasoning: true,
    strengths: 'Best-in-class coding, agentic planning, long-horizon reasoning, nuanced writing and judgment calls.',
    weaknesses: 'Most expensive model in the fleet. Wasteful for extraction, formatting or bulk transforms.',
  },
  {
    id: 'anthropic/claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    tier: 'frontier',
    priceIn: 3.0,
    priceOut: 15.0,
    context: 200_000,
    vision: true,
    reasoning: true,
    strengths: 'Excellent coding agent, very strong instruction-following, reliable structured output, good writing.',
    weaknesses: 'Mid-high cost; on the very hardest reasoning Opus or GPT-5.1 (high) are stronger.',
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    tier: 'mid',
    priceIn: 1.0,
    priceOut: 5.0,
    context: 200_000,
    vision: true,
    reasoning: true,
    strengths: 'Fast, near-Sonnet quality at a third of the price. Great for sub-tasks that need speed plus judgment.',
    weaknesses: 'Shallower on genuinely hard multi-step reasoning and subtle debugging.',
  },
  {
    id: 'openai/gpt-5.1',
    name: 'GPT-5.1',
    tier: 'frontier',
    priceIn: 1.25,
    priceOut: 10.0,
    context: 400_000,
    vision: true,
    reasoning: true,
    strengths: 'Top-tier general reasoning and math, strong code review, adjustable thinking effort, cheap input tokens.',
    weaknesses: 'High-effort mode is slow; can be verbose. Output tokens add up on long generations.',
  },
  {
    id: 'openai/gpt-5-mini',
    name: 'GPT-5 Mini',
    tier: 'mid',
    priceIn: 0.25,
    priceOut: 2.0,
    context: 400_000,
    vision: true,
    reasoning: true,
    strengths: 'Outstanding cost/quality ratio for summarization, verification, structured JSON, medium-difficulty writing.',
    weaknesses: 'Weaker on deep domain reasoning and hard code; keep tasks well-specified.',
  },
  {
    id: 'openai/gpt-5-nano',
    name: 'GPT-5 Nano',
    tier: 'budget',
    priceIn: 0.05,
    priceOut: 0.4,
    context: 400_000,
    vision: true,
    reasoning: true,
    strengths: 'Nearly free. Classification, routing, tagging, simple extraction, bulk transforms at scale.',
    weaknesses: 'Shallow reasoning; drops constraints on complex tasks. Never use for final user-facing prose.',
  },
  {
    id: 'google/gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro (preview)',
    tier: 'frontier',
    priceIn: 2.0,
    priceOut: 12.0,
    context: 1_000_000,
    vision: true,
    reasoning: true,
    strengths: 'Frontier multimodal reasoning, huge 1M context, strong math and agentic work, excellent on video/images/PDFs.',
    weaknesses: 'Preview stability varies; occasionally overconfident. Long-context pricing tiers up past 200k tokens.',
  },
  {
    id: 'google/gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    tier: 'mid',
    priceIn: 0.3,
    priceOut: 2.5,
    context: 1_000_000,
    vision: true,
    reasoning: true,
    strengths: 'Best price/performance multimodal workhorse. OCR, document/table extraction, long-doc summarization, fast drafts.',
    weaknesses: 'Mid-level coding; less precise instruction-following than Claude/GPT on fiddly formats.',
  },
  {
    id: 'google/gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite',
    tier: 'budget',
    priceIn: 0.1,
    priceOut: 0.4,
    context: 1_000_000,
    vision: true,
    reasoning: false,
    strengths: 'Cheapest vision in the fleet. High-volume OCR, image captioning, trivial transforms over long inputs.',
    weaknesses: 'Real quality floor — only give it simple, mechanical tasks.',
  },
  {
    id: 'z-ai/glm-5.2',
    name: 'GLM 5.2',
    tier: 'frontier',
    priceIn: 0.93,
    priceOut: 3.0,
    context: 1_048_576,
    vision: false,
    reasoning: true,
    strengths: 'Frontier-class open model at a fraction of Claude/GPT prices: long-horizon agent workflows, project-level software engineering, strong tool use, huge 1M context.',
    weaknesses: 'Text only — no vision. A notch below Opus/GPT-5.1 on the very hardest reasoning; can be verbose.',
  },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b',
    name: 'Nemotron 3 Ultra',
    tier: 'frontier',
    priceIn: 0.5,
    priceOut: 2.2,
    context: 1_000_000,
    vision: false,
    reasoning: true,
    strengths: 'Open frontier reasoning/orchestration MoE (550B, 55B active): excellent coding and agentic tool use, 1M context, remarkably cheap for its class. Often has a $0 :free variant.',
    weaknesses: 'Text only — no vision. Less battle-tested instruction adherence on strict output formats than Claude/GPT.',
  },
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek V3',
    tier: 'budget',
    priceIn: 0.27,
    priceOut: 1.1,
    context: 128_000,
    vision: false,
    reasoning: false,
    strengths: 'Very cheap yet strong generalist; solid everyday code and analysis. Great default for text-only mid tasks.',
    weaknesses: 'No vision. Looser instruction adherence on strict output formats.',
  },
  {
    id: 'deepseek/deepseek-r1',
    name: 'DeepSeek R1',
    tier: 'mid',
    priceIn: 0.5,
    priceOut: 2.15,
    context: 128_000,
    vision: false,
    reasoning: false,
    strengths: 'Cheap deep reasoning — math, logic puzzles, proof-style derivations. Always thinks (built-in CoT).',
    weaknesses: 'Slow, rambly. No vision. Overkill and over-verbose for simple tasks.',
  },
  {
    id: 'qwen/qwen3-coder',
    name: 'Qwen3 Coder',
    tier: 'budget',
    priceIn: 0.2,
    priceOut: 0.8,
    context: 262_000,
    vision: false,
    reasoning: false,
    strengths: 'Cheap coding specialist: boilerplate, refactors, test generation, straightforward implementation from a clear spec.',
    weaknesses: 'Weak outside code; no vision. Give it a precise spec, not an open design problem.',
  },
  {
    id: 'moonshotai/kimi-k2',
    name: 'Kimi K2',
    tier: 'mid',
    priceIn: 0.55,
    priceOut: 2.2,
    context: 262_000,
    vision: false,
    reasoning: false,
    strengths: 'Strong agentic task execution and creative/long-form writing with personality. Long context.',
    weaknesses: 'No vision; occasional formatting drift on strict schemas.',
  },
  {
    id: 'x-ai/grok-4.3',
    name: 'Grok 4.3',
    tier: 'mid',
    priceIn: 1.25,
    priceOut: 2.5,
    context: 1_000_000,
    vision: true,
    reasoning: true,
    strengths: 'Fast frontier-class generalist with unusually cheap output tokens and 1M context — good for long generations, iterative coding loops, agentic work.',
    weaknesses: 'Less proven instruction adherence on strict formats than Claude/GPT; verify critical outputs.',
  },
  {
    id: 'mistralai/mistral-small-3.2-24b-instruct',
    name: 'Mistral Small 3.2',
    tier: 'budget',
    priceIn: 0.06,
    priceOut: 0.18,
    context: 128_000,
    vision: true,
    reasoning: false,
    strengths: 'Dirt cheap with basic vision. Simple rewrites, translations, tagging, light extraction.',
    weaknesses: 'Limited reasoning depth; keep sub-tasks small and unambiguous.',
  },
];

const byId = new Map(CATALOG.map((m) => [m.id, m]));
let livePricingLoaded = false;

export function getModel(id) {
  return byId.get(id);
}

export function shortName(id) {
  const m = byId.get(id);
  if (m) return m.name;
  return (id || '').split('/').pop();
}

// Merge live pricing/availability from the public OpenRouter catalog.
// Safe to call repeatedly; only the first successful fetch does work.
export async function ensureLivePricing() {
  if (livePricingLoaded) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const json = await res.json();
    const live = new Map((json.data || []).map((m) => [m.id, m]));
    for (const model of CATALOG) {
      const hit = live.get(model.id);
      if (!hit) {
        model.available = false;
        continue;
      }
      model.available = true;
      const pin = parseFloat(hit.pricing?.prompt);
      const pout = parseFloat(hit.pricing?.completion);
      if (Number.isFinite(pin) && pin > 0) model.priceIn = pin * 1e6;
      if (Number.isFinite(pout) && pout > 0) model.priceOut = pout * 1e6;
      if (hit.context_length) model.context = hit.context_length;
      // A ":free" sibling means OpenRouter serves this model at $0 (rate-limited).
      const free = live.get(`${model.id}:free`);
      model.freeVariant = free ? `${model.id}:free` : null;
      model.freeTools = Boolean(free && (free.supported_parameters || []).includes('tools'));
    }
    livePricingLoaded = true;
  } catch {
    // Offline or OpenRouter unreachable — static catalog stands.
  }
}

export function availableModels() {
  return CATALOG.filter((m) => m.available !== false);
}

// Resolve which slug(s) to call for a model. With preferFree on and a usable
// :free variant, the free slug goes first and the paid one becomes the
// fallback (free endpoints are heavily rate-limited and often reject requests).
export function routeModel(id, { preferFree, needTools } = {}) {
  const m = byId.get(id);
  if (!preferFree || !m?.freeVariant || (needTools && !m.freeTools)) {
    return { model: id, fallbackModel: null };
  }
  return { model: m.freeVariant, fallbackModel: id };
}

// "Cheap first, escalate on proof of failure": when a node fails verification,
// the retry moves one capability tier up instead of re-rolling the same dice.
// This is what makes routing safe — the quality floor is the top of the ladder.
const ESCALATION = {
  budget: 'anthropic/claude-haiku-4.5',
  mid: 'anthropic/claude-sonnet-4.5',
  frontier: 'anthropic/claude-opus-4.5',
};

export function escalationModel(currentId) {
  const cur = byId.get(currentId);
  if (!cur) return null;
  const target = ESCALATION[cur.tier];
  if (!target || target === currentId) return null;
  const t = byId.get(target);
  if (!t || t.available === false) return null;
  // Never "escalate" to something cheaper than what just failed.
  if (t.priceOut <= cur.priceOut) return null;
  return target;
}

export function estimateCost(modelId, tokensIn, tokensOut) {
  const m = byId.get(modelId);
  if (!m) return 0;
  return (tokensIn / 1e6) * m.priceIn + (tokensOut / 1e6) * m.priceOut;
}

// Render the fleet as a briefing block for the planner prompt.
export function catalogForPrompt() {
  const fmt = (p) => (p < 1 ? `$${p.toFixed(2)}` : `$${p.toFixed(2)}`);
  const lines = availableModels().map((m) => {
    const mods = m.vision ? 'text+vision' : 'text only';
    const reas = m.reasoning ? 'adjustable reasoning effort' : 'no reasoning control';
    const free = m.freeVariant ? ' · has a $0 :free variant (auto-used when enabled — treat this model as near-free)' : '';
    return [
      `- \`${m.id}\` (${m.name}) — ${fmt(m.priceIn)} in / ${fmt(m.priceOut)} out per 1M tokens · ${Math.round(m.context / 1000)}k context · ${mods} · ${reas} · tier: ${m.tier}${free}`,
      `  Strengths: ${m.strengths}`,
      `  Watch out: ${m.weaknesses}`,
    ].join('\n');
  });
  return lines.join('\n');
}
