// The Maestro orchestration engine.
//
// Pipeline: plan (frontier model emits a task DAG) → optional plan review by
// the user (approve / reroute / delete nodes) → execute (topological, parallel
// where the graph allows, each node an agent loop with real tools) → verify
// each node's deliverables (the verifier executes code and checks citations,
// retry with feedback on failure) → adapt the graph when a node fails →
// synthesize the final answer.
//
// Every step emits events into run.events; the server relays them over SSE.

import fs from 'node:fs/promises';
import path from 'node:path';
import { chat } from './openrouter.js';
import { getModel, ensureLivePricing, availableModels, routeModel } from './models.js';
import { loadFile } from './store.js';
import { extractJson, rid, truncate, truncateMiddle } from './util.js';
import { toolDefs, execTool, summarizeArgs, listWorkspace } from './tools.js';
import { DATA_ROOT } from './paths.js';
import {
  plannerSystemPrompt,
  plannerUserPrompt,
  agentSystemPrompt,
  verifierSystemPrompt,
  verifierUserPrompt,
  replanSystemPrompt,
  replanUserPrompt,
  synthesisSystemPrompt,
  synthesisUserPrompt,
} from './prompts.js';

const MAX_NODES = 12;
const NODE_OUTPUT_CAP = 60_000; // chars of one node's output passed downstream
const TEXT_FILE_CAP = 60_000;
const DELTA_FLUSH_MS = 250;
const MAX_TOOL_ROUNDS = 12; // tool rounds per agent attempt
const HOSTED_TOOL_ROUNDS = 4;
const MAX_VERIFY_ROUNDS = 4; // tool rounds the verifier gets
const MAX_REPLANS = 2; // graph adaptations per run
const TOOL_RESULT_CAP = 1500; // chars of a tool result kept in the log/events
// The verifier re-reads its whole context every round — keep it on a diet:
// it judges against the rubric, it doesn't need the full 60k-char transcript.
const VERIFY_OUTPUT_CAP = 24_000; // chars of node output shown to the verifier (head+tail)
const VERIFY_TOOL_RESULT_CAP = 4_000; // chars of each tool result kept in the verifier's context

const EFFORT_MAX_TOKENS = { none: 8000, low: 10_000, medium: 14_000, high: 20_000 };
const HOSTED_EFFORT_MAX_TOKENS = { none: 4500, low: 5500, medium: 6500, high: 6500 };
const REASONING_LEVELS = ['none', 'low', 'medium', 'high'];
const TOOL_GROUPS = ['web', 'code'];

const WORKSPACES_ROOT = path.join(DATA_ROOT, 'workspaces');

export function workspacePath(runId) {
  return path.join(WORKSPACES_ROOT, runId);
}

export function createRun({ conversation, task, attachments, settings }) {
  const id = rid('r_');
  return {
    id,
    conversationId: conversation.id,
    task,
    attachments, // array of file metas
    settings,
    status: 'planning',
    startedAt: Date.now(),
    endedAt: null,
    plan: null,
    nodes: {}, // nodeId -> state
    totals: { cost: 0, tokensIn: 0, tokensOut: 0, calls: 0 },
    answer: '',
    artifacts: [],
    adaptations: [],
    replansUsed: 0,
    adapting: false,
    approval: null, // {resolve} while awaiting plan review
    workspace: workspacePath(id),
    events: [],
    subscribers: new Set(),
    abort: new AbortController(),
    stopMessage: null,
  };
}

export function emit(run, type, data) {
  const ev = { type, data };
  const idx = run.events.push(ev) - 1;
  for (const res of run.subscribers) {
    try {
      res.write(`id: ${idx}\ndata: ${JSON.stringify(compactEventForStream(ev))}\n\n`);
    } catch {
      run.subscribers.delete(res);
    }
  }
}

export function compactEventForStream(ev) {
  if (ev.type === 'node_result') {
    const { output, ...data } = ev.data || {};
    return { ...ev, data };
  }
  if (ev.type === 'done') {
    const d = ev.data || {};
    return {
      ...ev,
      data: {
        id: d.id,
        status: d.status,
        startedAt: d.startedAt,
        endedAt: d.endedAt,
        totals: d.totals,
        artifacts: d.artifacts || [],
        adaptations: d.adaptations || [],
        stopMessage: d.stopMessage || null,
      },
    };
  }
  return ev;
}

function addUsage(run, usage) {
  run.totals.cost += usage.cost || 0;
  run.totals.tokensIn += usage.tokensIn || 0;
  run.totals.tokensOut += usage.tokensOut || 0;
  run.totals.calls += 1;
  emit(run, 'usage', { ...run.totals });
}

function conversationContext(conversation) {
  const turns = conversation.messages.slice(-8);
  if (!turns.length) return '';
  return turns
    .map((m) => `${m.role === 'user' ? 'User' : 'Maestro'}: ${truncate(m.content || '', 3000)}`)
    .join('\n\n');
}

function newNodeState() {
  return { status: 'pending', attempt: 0, output: '', cost: 0, tokensIn: 0, tokensOut: 0, ms: 0, toolLog: [] };
}

// --- main entry ---------------------------------------------------------------

export async function executeRun(run, conversation, { onFinished }) {
  const date = new Date().toISOString().slice(0, 10);
  const ctx = conversationContext(conversation);
  try {
    await ensureLivePricing();
    await prepareWorkspace(run);
    if (run.settings.hostedDirect) createHostedDirectPlan(run);
    else await planPhase(run, ctx, date);
    await approvalGate(run);
    await executeGraph(run);
    await autoSaveCode(run).catch(() => {});
    await collectArtifacts(run);
    await synthesisPhase(run, ctx, date);
    run.status = 'done';
    run.endedAt = Date.now();
    emit(run, 'phase', { phase: 'done' });
  } catch (err) {
    run.status = run.abort.signal.aborted ? 'stopped' : 'error';
    run.endedAt = Date.now();
    const message = run.abort.signal.aborted ? run.stopMessage || 'Run stopped by user.' : err.message;
    emit(run, 'error', { message, status: run.status });
    emit(run, 'phase', { phase: run.status });
    if (!run.answer) run.answer = run.abort.signal.aborted ? (run.stopMessage ? `**Run stopped:** ${message}` : '*Run stopped.*') : `**The run failed:** ${message}`;
  }
  emit(run, 'done', snapshot(run));
  await onFinished(snapshot(run));
}

export function snapshot(run) {
  const nodes = {};
  for (const [id, n] of Object.entries(run.nodes)) {
    nodes[id] = {
      status: n.status,
      attempt: n.attempt,
      output: truncate(n.output || '', NODE_OUTPUT_CAP),
      verify: n.verify || null,
      toolLog: (n.toolLog || []).slice(-80),
      cost: n.cost,
      tokensIn: n.tokensIn,
      tokensOut: n.tokensOut,
      ms: n.ms,
      error: n.error || null,
    };
  }
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    plan: run.plan,
    nodes,
    totals: run.totals,
    answer: run.answer,
    artifacts: run.artifacts,
    adaptations: run.adaptations,
    stopMessage: run.stopMessage || null,
    planLog: run.planLog
      ? { thinking: truncate(run.planLog.thinking, 20_000), json: truncate(run.planLog.json, 20_000) }
      : null,
  };
}

// --- workspace ------------------------------------------------------------------

async function prepareWorkspace(run) {
  await fs.mkdir(path.join(run.workspace, '.tmp'), { recursive: true });
  const used = new Set();
  for (const meta of run.attachments) {
    const file = await loadFile(meta.id);
    if (!file) continue;
    const base = (meta.name || 'file').replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '_') || 'file';
    let name = base;
    let k = 1;
    while (used.has(name)) {
      const ext = path.extname(base);
      name = `${path.basename(base, ext)}_${k++}${ext}`;
    }
    used.add(name);
    await fs.writeFile(path.join(run.workspace, name), file.buffer);
    meta.workspaceName = name;
  }
}

// Standalone code that an agent wrote only in its answer text still belongs in
// the sandbox: save each substantial fenced block as a workspace file so it is
// immediately runnable, testable, and downloadable. Blocks already saved via
// write_file are recognized by content and skipped.
const CODE_EXT = {
  python: 'py', py: 'py', javascript: 'js', js: 'js', node: 'js', typescript: 'ts', ts: 'ts',
  bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', ruby: 'rb', perl: 'pl', java: 'java',
  swift: 'swift', c: 'c', cpp: 'cpp', 'c++': 'cpp', go: 'go', rust: 'rs', rs: 'rs',
  html: 'html', css: 'css', sql: 'sql', r: 'r',
};

const normCode = (s) => s.replace(/\s+/g, ' ').trim();

async function autoSaveCode(run) {
  const existing = new Set();
  for (const f of await listWorkspace(run.workspace).catch(() => [])) {
    if (f.size > 300_000) continue;
    const text = await fs.readFile(path.join(run.workspace, f.path), 'utf8').catch(() => null);
    if (text != null) existing.add(normCode(text));
  }

  const root = path.resolve(run.workspace);
  for (const node of run.plan.nodes) {
    const st = run.nodes[node.id];
    if (!['done', 'warn'].includes(st.status) || !st.output) continue;
    let idx = 0;
    for (const m of st.output.matchAll(/```(\w[\w+#-]*)?[ \t]*([^\n`]*)\n([\s\S]*?)```/g)) {
      const ext = CODE_EXT[(m[1] || '').toLowerCase()];
      const info = (m[2] || '').trim();
      const code = m[3];
      if (!ext || code.split('\n').length < 5 || code.length < 120) continue;
      if (existing.has(normCode(code))) continue;
      const hinted = /^[\w.\-\/]+\.\w{1,8}$/.test(info) ? info : null;
      const rel = hinted || `code/${node.id}_${++idx}.${ext}`;
      const full = path.resolve(root, rel);
      if (full !== root && !full.startsWith(root + path.sep)) continue;
      try {
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, code, { flag: 'wx' }); // never clobber an agent-written file
        existing.add(normCode(code));
      } catch {}
    }
  }
}

// Everything in the workspace except unchanged staged attachments is an artifact.
async function collectArtifacts(run) {
  const files = await listWorkspace(run.workspace).catch(() => []);
  const staged = new Map(run.attachments.filter((a) => a.workspaceName).map((a) => [a.workspaceName, a.size]));
  run.artifacts = files.filter((f) => staged.get(f.path) !== f.size);
  if (run.artifacts.length) emit(run, 'artifacts', { files: run.artifacts });
}

// --- phase 1: planning --------------------------------------------------------

// Throttled relay of the orchestrator's own live output (reasoning + the JSON
// it is writing) so the user can watch it plan/replan instead of a spinner.
function planStreamEmitter(run) {
  const buf = { thinking: '', json: '' };
  let last = 0;
  const flush = () => {
    for (const kind of ['thinking', 'json']) {
      if (buf[kind]) {
        emit(run, 'plan_delta', { kind, text: buf[kind] });
        buf[kind] = '';
      }
    }
    last = Date.now();
  };
  return {
    push(kind, text) {
      buf[kind] += text;
      if (Date.now() - last > DELTA_FLUSH_MS) flush();
    },
    reset() {
      buf.thinking = '';
      buf.json = '';
      emit(run, 'plan_stream_reset', {});
    },
    flush,
  };
}

async function planPhase(run, ctx, date) {
  emit(run, 'phase', { phase: 'planning' });
  const s = run.settings;
  const stream = planStreamEmitter(run);
  const res = await chat({
    apiKey: s.apiKey,
    ...routeModel(s.orchestratorModel, { preferFree: s.preferFree }),
    reasoning: getModel(s.orchestratorModel)?.reasoning ? { effort: 'medium' } : undefined,
    maxTokens: 14_000,
    signal: run.abort.signal,
    onDelta: (t) => stream.push('json', t),
    onReasoning: (t) => stream.push('thinking', t),
    onRestart: () => stream.reset(),
    messages: [
      { role: 'system', content: plannerSystemPrompt() },
      {
        role: 'user',
        content: plannerUserPrompt({ task: run.task, attachments: run.attachments, conversationContext: ctx, date }),
      },
    ],
  });
  stream.flush();
  run.planLog = { thinking: res.reasoning || '', json: res.content || '' };
  addUsage(run, res);

  const plan = validatePlan(extractJson(res.content), run.settings);
  run.plan = plan;
  for (const node of plan.nodes) {
    run.nodes[node.id] = newNodeState();
  }
  emit(run, 'plan', plan);
}

function createHostedDirectPlan(run) {
  emit(run, 'phase', { phase: 'planning' });
  const tools = hostedDirectTools(run);
  const model = availableModels().some((m) => m.id === run.settings.orchestratorModel)
    ? run.settings.orchestratorModel
    : run.settings.fallbackModel;
  const reasoning = getModel(model)?.reasoning ? 'low' : 'none';
  const attachmentIds = run.attachments.map((a) => a.id);
  const node = {
    id: 'n1',
    title: 'Complete request',
    objective: 'Complete the user request end-to-end in one focused hosted run.',
    model,
    reasoning,
    tools,
    depends_on: [],
    uses_attachments: attachmentIds,
    instructions: hostedDirectInstructions(run, tools),
    deliverables: ['A complete final answer to the user request, with any requested files saved to the workspace.'],
    verification: 'none',
  };
  run.plan = {
    analysis: 'Hosted Vercel mode uses one focused agent so the request can finish inside the platform time limit.',
    strategy: 'One focused hosted agent completes the request directly.',
    synthesis: 'none',
    synthesis_instructions: '',
    nodes: [node],
  };
  run.nodes[node.id] = newNodeState();
  emit(run, 'plan', run.plan);
}

function hostedDirectTools(run) {
  const task = run.task.toLowerCase();
  const hasAttachments = run.attachments.length > 0;
  const needsWeb = /\b(latest|current|today|news|price|prices|weather|stock|exchange rate|recent|release|version|docs?|source|sources|cite|citation|search|browse|look up|lookup|web|url|http|github|vercel|aktuell|heute|neueste|nachrichten|preis|preise|quelle|quellen|suche|such)\b/i.test(task);
  const needsCode = hasAttachments || /\b(code|script|program|app|website|html|css|javascript|typescript|python|csv|json|excel|spreadsheet|chart|plot|graph|file|data|analy[sz]e|build|implement|debug|fix|deploy|repo|repository|vercel|programm|datei|daten|diagramm|tabelle|baue|mach|reparier|korrigier)\b/i.test(task);
  return [needsWeb && 'web', needsCode && 'code'].filter(Boolean);
}

function hostedDirectInstructions(run, tools) {
  const toolLine = tools.length
    ? `Use the available ${tools.join(' + ')} tools only when they are necessary for the final answer.`
    : 'No tools are needed unless the task explicitly requires external files or live facts.';
  return `Complete the original user request end-to-end in one pass.

You are running on the hosted Vercel deployment, which has a strict 300-second function limit. Prioritize finishing the concrete deliverable over broad exploration.

${toolLine}

Hosted execution rules:
- Keep tool calls minimal and decisive; stop gathering context once you can answer correctly.
- If live/current facts are required and you have web tools, cite the URLs you actually fetched.
- If code or files are requested and you have code tools, save the requested deliverable files to the workspace and mention their filenames.
- Do not ask follow-up questions. Make reasonable assumptions and list them briefly only if they affect the result.
- Keep the final answer complete but compact enough to finish within the hosted limit.`;
}

function normTools(raw) {
  return Array.isArray(raw) ? raw.filter((t) => TOOL_GROUPS.includes(t)) : [];
}

function normalizeNode(n, i, available, settings) {
  const id = typeof n.id === 'string' && n.id.trim() ? n.id.trim() : `n${i + 1}`;
  return {
    id,
    title: String(n.title || `Step ${i + 1}`).slice(0, 80),
    objective: String(n.objective || n.title || ''),
    model: available.has(n.model) ? n.model : settings.fallbackModel,
    reasoning: REASONING_LEVELS.includes(n.reasoning) ? n.reasoning : 'none',
    tools: normTools(n.tools),
    depends_on: Array.isArray(n.depends_on) ? n.depends_on.map(String) : [],
    uses_attachments: Array.isArray(n.uses_attachments) ? n.uses_attachments.map(String) : [],
    instructions: String(n.instructions || n.objective || ''),
    deliverables: Array.isArray(n.deliverables) && n.deliverables.length ? n.deliverables.map(String) : ['The completed result of the objective.'],
    verification: String(n.verification || 'none'),
  };
}

function validatePlan(raw, settings) {
  if (!raw || !Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new Error('Planner returned no task nodes.');
  }
  const available = new Set(availableModels().map((m) => m.id));
  const nodes = raw.nodes.slice(0, MAX_NODES).map((n, i) => normalizeNode(n, i, available, settings));

  // De-duplicate ids, drop dangling deps, reject cycles.
  const seen = new Set();
  for (const n of nodes) {
    while (seen.has(n.id)) n.id = `${n.id}x`;
    seen.add(n.id);
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    n.depends_on = n.depends_on.filter((d) => ids.has(d) && d !== n.id);
  }
  assertAcyclic(nodes);

  return {
    analysis: String(raw.analysis || ''),
    strategy: String(raw.strategy || ''),
    synthesis: raw.synthesis === 'none' && nodes.length === 1 ? 'none' : 'full',
    synthesis_instructions: String(raw.synthesis_instructions || ''),
    nodes,
  };
}

function assertAcyclic(nodes) {
  const indeg = new Map(nodes.map((n) => [n.id, n.depends_on.length]));
  const dependents = new Map(nodes.map((n) => [n.id, []]));
  for (const n of nodes) for (const d of n.depends_on) dependents.get(d)?.push(n.id);
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited++;
    for (const dep of dependents.get(id)) {
      indeg.set(dep, indeg.get(dep) - 1);
      if (indeg.get(dep) === 0) queue.push(dep);
    }
  }
  if (visited !== nodes.length) throw new Error('Planner produced a cyclic task graph.');
}

// --- phase 1b: plan review gate -------------------------------------------------

// When settings.approvePlans is on, the run pauses here until the user approves
// (optionally with per-node edits) or cancels via POST /api/runs/:id/plan.
function approvalGate(run) {
  if (!run.settings.approvePlans) return;
  run.status = 'awaiting';
  emit(run, 'phase', { phase: 'awaiting_approval' });
  return new Promise((resolve, reject) => {
    run.approval = { resolve };
    run.abort.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }).then((edits) => {
    run.approval = null;
    if (edits && Object.keys(edits).length) applyPlanEdits(run, edits);
    run.status = 'running';
    emit(run, 'plan', run.plan);
  });
}

// Called by the server route. action: 'approve' (with edits) or 'cancel'.
export function resolveApproval(run, { action, edits }) {
  if (!run.approval) throw new Error('Run is not awaiting plan approval.');
  if (action === 'cancel') {
    run.abort.abort();
    return;
  }
  run.approval.resolve(edits || {});
}

// edits: { [nodeId]: { deleted?, model?, reasoning?, tools?, instructions? } }
function applyPlanEdits(run, edits) {
  const plan = run.plan;
  const available = new Set(availableModels().map((m) => m.id));

  const deleted = new Set(
    Object.entries(edits)
      .filter(([id, e]) => e?.deleted && plan.nodes.some((n) => n.id === id))
      .map(([id]) => id)
  );
  if (deleted.size >= plan.nodes.length) throw new Error('Plan review removed every node — run cancelled.');

  // Dependents of a deleted node inherit its dependencies.
  for (const n of plan.nodes) {
    if (deleted.has(n.id)) continue;
    const next = [];
    for (const d of n.depends_on) {
      if (!deleted.has(d)) {
        next.push(d);
      } else {
        const gone = plan.nodes.find((x) => x.id === d);
        for (const gd of gone?.depends_on || []) if (!deleted.has(gd)) next.push(gd);
      }
    }
    n.depends_on = [...new Set(next)].filter((d) => d !== n.id);
  }
  plan.nodes = plan.nodes.filter((n) => !deleted.has(n.id));
  for (const id of deleted) delete run.nodes[id];

  for (const [id, e] of Object.entries(edits)) {
    if (!e || e.deleted) continue;
    const n = plan.nodes.find((x) => x.id === id);
    if (!n) continue;
    if (e.model && available.has(e.model)) n.model = e.model;
    if (REASONING_LEVELS.includes(e.reasoning)) n.reasoning = e.reasoning;
    if (Array.isArray(e.tools)) n.tools = normTools(e.tools);
    if (typeof e.instructions === 'string' && e.instructions.trim()) n.instructions = e.instructions.trim();
  }
  assertAcyclic(plan.nodes);
}

// --- phase 2: parallel graph execution -----------------------------------------

const SETTLED = ['done', 'warn', 'failed', 'skipped', 'dropped'];
const POISONED = ['failed', 'skipped', 'dropped'];

async function executeGraph(run) {
  emit(run, 'phase', { phase: 'running' });
  const { settings } = run;
  let active = 0;

  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const pump = () => {
      if (settled) return;
      if (run.abort.signal.aborted) return fail(new Error('aborted'));
      // While the orchestrator is revising the graph, hold all scheduling and
      // skip-propagation — the failed node's dependents may yet be rescued.
      if (run.adapting) return;

      let changed = true;
      while (changed) {
        changed = false;
        for (const node of run.plan.nodes) {
          const st = run.nodes[node.id];
          if (st.status !== 'pending') continue;

          const deps = node.depends_on.map((d) => run.nodes[d]);
          // A failed/skipped/dropped upstream poisons the node — skip it.
          if (deps.some((d) => !d || POISONED.includes(d.status))) {
            st.status = 'skipped';
            emit(run, 'node_status', { id: node.id, status: 'skipped' });
            changed = true;
            continue;
          }
          if (!deps.every((d) => d.status === 'done' || d.status === 'warn')) continue;
          if (active >= settings.maxParallel) continue;

          active++;
          st.status = 'running';
          changed = true;
          runNode(run, node)
            .catch(async (err) => {
              st.status = 'failed';
              st.error = err.message;
              emit(run, 'node_status', { id: node.id, status: 'failed', error: err.message });
              await maybeAdapt(run, node, err.message);
            })
            .finally(() => {
              active--;
              pump();
            });
        }
      }

      const allSettled = run.plan.nodes.every((n) => SETTLED.includes(run.nodes[n.id].status));
      if (allSettled && !settled) {
        settled = true;
        resolve();
      }
    };
    pump();
  });
}

// --- adaptive replanning ---------------------------------------------------------

async function maybeAdapt(run, failedNode, reason) {
  if (run.abort.signal.aborted) return;
  if (run.settings.hostedDirect) return;
  if (run.adapting) return; // another failure is already being handled
  if (run.replansUsed >= MAX_REPLANS) return;
  run.replansUsed++;
  run.adapting = true;
  emit(run, 'adapting', { failed: failedNode.id });

  try {
    const s = run.settings;
    const nodeStates = {};
    for (const n of run.plan.nodes) {
      const st = run.nodes[n.id];
      nodeStates[n.id] = { status: st.status, output: st.output || '' };
    }
    const stream = planStreamEmitter(run);
    const res = await chat({
      apiKey: s.apiKey,
      ...routeModel(s.orchestratorModel, { preferFree: s.preferFree }),
      reasoning: getModel(s.orchestratorModel)?.reasoning ? { effort: 'low' } : undefined,
      maxTokens: 10_000,
      signal: run.abort.signal,
      onDelta: (t) => stream.push('json', t),
      onReasoning: (t) => stream.push('thinking', t),
      onRestart: () => stream.reset(),
      messages: [
        { role: 'system', content: replanSystemPrompt() },
        {
          role: 'user',
          content: replanUserPrompt({
            task: run.task,
            plan: run.plan,
            nodeStates,
            failedNode,
            failureReason: reason,
            date: new Date().toISOString().slice(0, 10),
          }),
        },
      ],
    });
    stream.flush();
    addUsage(run, res);
    const patch = extractJson(res.content);
    const why = String(patch.reason || '').slice(0, 300);

    if (patch.action === 'revise' && applyAdaptation(run, patch)) {
      run.adaptations.push(why || `Plan revised after "${failedNode.title}" failed.`);
      emit(run, 'plan_updated', { plan: run.plan, reason: why, failed: failedNode.id });
    } else {
      run.adaptations.push(why || `Proceeding despite "${failedNode.title}" failing.`);
      emit(run, 'adapt_decision', { action: 'proceed', reason: why, failed: failedNode.id });
    }
  } catch {
    // Adaptation is strictly best-effort — a broken replanner never sinks the run.
  } finally {
    run.adapting = false;
  }
}

// Apply a replan patch to pending nodes only. Validates on a copy first so a
// bad patch (cycle, garbage) leaves the live plan untouched.
function applyAdaptation(run, patch) {
  const available = new Set(availableModels().map((m) => m.id));
  const nodes = run.plan.nodes.map((n) => ({ ...n, depends_on: [...n.depends_on] }));
  const stateOf = (id) => run.nodes[id]?.status;
  const droppedIds = [];
  const newNodes = [];
  let changed = false;

  for (const id of (patch.drop_nodes || []).map(String)) {
    if (stateOf(id) === 'pending') {
      droppedIds.push(id);
      changed = true;
    }
  }

  for (const u of patch.update_nodes || []) {
    const n = nodes.find((x) => x.id === u?.id);
    if (!n || stateOf(n.id) !== 'pending' || droppedIds.includes(n.id)) continue;
    if (u.model && available.has(u.model)) n.model = u.model;
    if (REASONING_LEVELS.includes(u.reasoning)) n.reasoning = u.reasoning;
    if (Array.isArray(u.tools)) n.tools = normTools(u.tools);
    if (typeof u.instructions === 'string' && u.instructions.trim()) n.instructions = u.instructions.trim();
    if (Array.isArray(u.deliverables) && u.deliverables.length) n.deliverables = u.deliverables.map(String);
    if (typeof u.verification === 'string' && u.verification.trim()) n.verification = u.verification.trim();
    if (Array.isArray(u.depends_on)) n.depends_on = u.depends_on.map(String);
    changed = true;
  }

  const ids = new Set(nodes.map((n) => n.id));
  for (const raw of (patch.add_nodes || []).slice(0, Math.max(0, MAX_NODES + 4 - nodes.length))) {
    const node = normalizeNode(raw, nodes.length, available, run.settings);
    while (ids.has(node.id)) node.id = `${node.id}x`;
    ids.add(node.id);
    nodes.push(node);
    newNodes.push(node.id);
    changed = true;
  }
  if (!changed) return false;

  for (const n of nodes) {
    n.depends_on = n.depends_on.filter((d) => ids.has(d) && d !== n.id);
  }
  try {
    assertAcyclic(nodes);
  } catch {
    return false; // bad patch — keep the current plan
  }

  // Commit.
  run.plan.nodes = nodes;
  for (const id of newNodes) run.nodes[id] = newNodeState();
  for (const id of droppedIds) {
    run.nodes[id].status = 'dropped';
    emit(run, 'node_status', { id, status: 'dropped' });
  }
  return true;
}

// --- node execution: the agent loop ---------------------------------------------

async function runNode(run, node) {
  const st = run.nodes[node.id];
  const settings = run.settings;
  const started = Date.now();
  const model = getModel(node.model);
  const defs = toolDefs(node.tools);

  const messages = [
    { role: 'system', content: agentSystemPrompt(node) },
    { role: 'user', content: await buildNodeInput(run, node, model) },
  ];

  const maxAttempts = 1 + settings.maxRetries;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    st.attempt = attempt;
    st.status = 'running';
    st.output = '';
    emit(run, 'node_status', { id: node.id, status: 'running', attempt });

    const content = await agentLoop(run, node, st, messages, { defs, model });
    st.output = content;

    // Verify the deliverables unless the planner waived it.
    if (node.verification && node.verification !== 'none') {
      st.status = 'verifying';
      emit(run, 'node_status', { id: node.id, status: 'verifying', attempt });
      const verdict = await verifyNode(run, node, content);
      st.verify = verdict;
      emit(run, 'verify_result', { id: node.id, ...verdict });

      if (!verdict.pass && attempt < maxAttempts) {
        emit(run, 'node_status', { id: node.id, status: 'retry', attempt, feedback: verdict.feedback });
        messages.push({ role: 'assistant', content });
        messages.push({
          role: 'user',
          content: `The verifier rejected your output with this feedback:\n\n${verdict.feedback}\n\nFix the problems and return the FULL corrected deliverables (not a diff). You may use your tools again.`,
        });
        continue;
      }
      st.status = verdict.pass ? 'done' : 'warn';
    } else {
      st.status = 'done';
    }

    st.ms = Date.now() - started;
    emit(run, 'node_result', {
      id: node.id,
      status: st.status,
      output: st.output,
      cost: st.cost,
      tokensIn: st.tokensIn,
      tokensOut: st.tokensOut,
      ms: st.ms,
      attempt: st.attempt,
    });
    return;
  }
}

// One attempt: loop model ↔ tools until the model answers without tool calls.
async function agentLoop(run, node, st, messages, { defs, model }) {
  const settings = run.settings;
  const maxToolRounds = settings.hostedDirect ? HOSTED_TOOL_ROUNDS : MAX_TOOL_ROUNDS;

  for (let round = 0; round <= maxToolRounds; round++) {
    const forceFinal = Boolean(defs) && round === maxToolRounds;
    if (forceFinal) {
      messages.push({
        role: 'user',
        content: 'Tool budget exhausted — write your complete final deliverables now, without further tool calls.',
      });
    }

    // Stream the round's output, flushing deltas at most every DELTA_FLUSH_MS.
    let pendingDelta = '';
    let lastFlush = 0;
    const flush = () => {
      if (!pendingDelta) return;
      emit(run, 'node_delta', { id: node.id, text: pendingDelta });
      pendingDelta = '';
      lastFlush = Date.now();
    };

    st.output = '';
    const res = await chat({
      apiKey: settings.apiKey,
      ...routeModel(node.model, { preferFree: settings.preferFree, needTools: Boolean(defs) }),
      reasoning: model?.reasoning && node.reasoning !== 'none' ? { effort: node.reasoning } : undefined,
      maxTokens: maxTokensForNode(settings, node),
      signal: run.abort.signal,
      plugins: nodePdfPlugin(run, node),
      tools: defs || undefined,
      toolChoice: forceFinal ? 'none' : undefined,
      messages,
      onDelta: (text) => {
        st.output += text;
        pendingDelta += text;
        if (Date.now() - lastFlush > DELTA_FLUSH_MS) flush();
      },
      onRestart: () => {
        // A partially-streamed response is being retried (e.g. :free variant
        // died mid-stream) — wipe what the UI already showed.
        pendingDelta = '';
        st.output = '';
        emit(run, 'node_reset', { id: node.id });
      },
    });
    flush();
    st.cost += res.cost;
    st.tokensIn += res.tokensIn;
    st.tokensOut += res.tokensOut;
    addUsage(run, res);

    // Some providers (notably :free endpoints) leak tool calls as plain text
    // markup instead of structured API calls — parse and execute them anyway.
    if (!res.toolCalls.length && defs && !forceFinal) {
      const textCalls = parseTextToolCalls(res.content);
      if (textCalls.length) {
        messages.push({ role: 'assistant', content: res.content });
        st.output = '';
        emit(run, 'node_reset', { id: node.id });
        const note = 'Tool calls arrived as plain text (provider quirk) — executed them anyway.';
        st.toolLog.push({ note, by: 'agent' });
        emit(run, 'node_note', { id: node.id, text: note, by: 'agent' });
        const results = [];
        for (const [i, c] of textCalls.slice(0, textToolCallLimit(run)).entries()) {
          const call = { id: `textcall_${round}_${i}`, function: { name: c.name, arguments: JSON.stringify(c.args) } };
          const result = await execToolCall(run, node.id, st, call, 'agent');
          results.push(`### Result of ${c.name}\n${truncate(result, 4000)}`);
        }
        messages.push({
          role: 'user',
          content: `You wrote your tool calls as plain text markup instead of using the tool-call API. They were executed for you — results:\n\n${results.join('\n\n')}\n\nContinue using REAL API tool calls. When finished, your final message must be plain markdown deliverables with NO tool markup.`,
        });
        continue;
      }
    }

    if (!res.toolCalls.length || forceFinal) {
      return defs ? await scrubLeakedToolMarkup(run, node, st, res.content) : res.content;
    }

    // Tool round: whatever text streamed was working commentary, not the
    // deliverable — move it to the activity log and clear the output pane.
    messages.push({ role: 'assistant', content: res.content || '', tool_calls: res.toolCalls });
    const note = (res.content || '').trim();
    if (note) {
      st.toolLog.push({ note: truncate(note, 500), by: 'agent' });
      emit(run, 'node_note', { id: node.id, text: truncate(note, 500), by: 'agent' });
    }
    st.output = '';
    emit(run, 'node_reset', { id: node.id });

    for (const call of res.toolCalls) {
      const result = await execToolCall(run, node.id, st, call, 'agent');
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
}

// Recover tool calls that a model emitted as text markup. Handles the Qwen
// XML-ish style (<function=name><parameter=key>value</parameter></function>)
// and the Hermes JSON style (<tool_call>{"name": …, "arguments": {…}}</tool_call>).
function parseTextToolCalls(content) {
  const calls = [];
  if (!content || !/<(tool_call|function=)/.test(content)) return calls;
  for (const m of content.matchAll(/<function=([\w-]+)>([\s\S]*?)<\/function>/g)) {
    const args = {};
    for (const p of m[2].matchAll(/<parameter=([\w-]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) args[p[1]] = p[2].trim();
    if (Object.keys(args).length) calls.push({ name: m[1], args });
  }
  if (!calls.length) {
    for (const m of content.matchAll(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g)) {
      try {
        const obj = JSON.parse(m[1]);
        if (obj.name) calls.push({ name: obj.name, args: obj.arguments || obj.parameters || {} });
      } catch {}
    }
  }
  return calls;
}

function maxTokensForNode(settings, node) {
  const table = settings.hostedDirect ? HOSTED_EFFORT_MAX_TOKENS : EFFORT_MAX_TOKENS;
  return table[node.reasoning] || table.none;
}

function textToolCallLimit(run) {
  return run.settings.hostedDirect ? 4 : 8;
}

// Last line of defense: a FINAL answer still containing tool markup. Execute
// the leaked calls so no work is lost, then strip the markup from the text.
async function scrubLeakedToolMarkup(run, node, st, content) {
  const textCalls = parseTextToolCalls(content);
  if (!textCalls.length) return content;
  const saved = [];
  for (const [i, c] of textCalls.slice(0, textToolCallLimit(run)).entries()) {
    const call = { id: `finaltext_${i}`, function: { name: c.name, arguments: JSON.stringify(c.args) } };
    await execToolCall(run, node.id, st, call, 'agent');
    if (c.name === 'write_file' && c.args.path) saved.push(String(c.args.path).trim());
  }
  let cleaned = content
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '')
    .replace(/<function=[\s\S]*?(?:<\/function>|$)/g, '')
    .trim();
  if (saved.length) {
    cleaned += `${cleaned ? '\n\n' : ''}**Files saved to the workspace:** ${saved.map((p) => `\`${p}\``).join(', ')} — available as artifacts below.`;
  }
  return cleaned || content;
}

async function execToolCall(run, nodeId, st, call, by) {
  let args = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {}
  const name = call.function.name;
  const summary = summarizeArgs(name, args);
  const entry = { callId: call.id, name, summary, status: 'running', result: '', ms: 0, by };
  st.toolLog.push(entry);
  emit(run, 'tool_call', { id: nodeId, callId: call.id, name, summary, by });

  const t0 = Date.now();
  let result;
  let ok = true;
  try {
    result = String(await execTool(name, args, { workspace: run.workspace, signal: run.abort.signal, settings: run.settings }));
  } catch (err) {
    if (run.abort.signal.aborted) throw err;
    ok = false;
    result = `TOOL ERROR: ${err.message}`;
  }
  entry.status = ok ? 'ok' : 'error';
  entry.ms = Date.now() - t0;
  entry.result = truncate(result, TOOL_RESULT_CAP);
  emit(run, 'tool_result', { id: nodeId, callId: call.id, ok, result: entry.result, ms: entry.ms });
  return result;
}

// --- verification with teeth ------------------------------------------------------

async function verifyNode(run, node, output) {
  const groups = node.tools || [];
  // The verifier can read and execute, but not write over the agent's files.
  const defs = toolDefs(groups)?.filter((d) => d.function.name !== 'write_file') || null;
  const st = run.nodes[node.id];

  try {
    const messages = [
      { role: 'system', content: verifierSystemPrompt(groups) },
      { role: 'user', content: verifierUserPrompt(node, truncateMiddle(output, VERIFY_OUTPUT_CAP)) },
    ];

    for (let round = 0; round <= MAX_VERIFY_ROUNDS; round++) {
      const forceFinal = !defs || round === MAX_VERIFY_ROUNDS;
      const res = await chat({
        apiKey: run.settings.apiKey,
        ...routeModel(run.settings.verifierModel, { preferFree: run.settings.preferFree, needTools: Boolean(defs) }),
        onRestart: () => {},
        maxTokens: 3000,
        signal: run.abort.signal,
        tools: defs || undefined,
        toolChoice: defs && forceFinal ? 'none' : undefined,
        messages,
      });
      addUsage(run, res);

      if (res.toolCalls.length && !forceFinal) {
        messages.push({ role: 'assistant', content: res.content || '', tool_calls: res.toolCalls });
        for (const call of res.toolCalls) {
          const result = await execToolCall(run, node.id, st, call, 'verifier');
          // Full results go to the log; the verifier's context gets a digest —
          // it re-reads everything each round, so every extra char is paid N times.
          messages.push({ role: 'tool', tool_call_id: call.id, content: truncate(result, VERIFY_TOOL_RESULT_CAP) });
        }
        continue;
      }

      const verdict = extractJson(res.content);
      const score = typeof verdict.score === 'number' ? verdict.score : null;
      return {
        pass: score != null ? score >= 5 : verdict.pass !== false,
        score,
        feedback: String(verdict.feedback || ''),
        checked: st.toolLog.some((e) => e.by === 'verifier'),
      };
    }
  } catch (err) {
    if (run.abort.signal.aborted) throw err;
    // A broken verifier should never sink a good run.
    return { pass: true, score: null, feedback: `(verifier unavailable: ${err.message})`, checked: false };
  }
}

// Build the user message for a node: task + upstream outputs + attachments.
async function buildNodeInput(run, node, model) {
  const sections = [`# Original task from the user\n${run.task}`];

  if (node.depends_on.length) {
    const upstream = node.depends_on
      .map((depId) => {
        const dep = run.plan.nodes.find((n) => n.id === depId);
        const st = run.nodes[depId];
        return `## Output of "${dep?.title || depId}" (${depId})\n${truncate(st.output || '(no output)', NODE_OUTPUT_CAP)}`;
      })
      .join('\n\n');
    sections.push(`# Inputs from upstream agents\n${upstream}`);
  }

  const hasCode = (node.tools || []).includes('code');
  if (hasCode) {
    const staged = run.attachments.filter((a) => a.workspaceName);
    if (staged.length) {
      sections.push(
        `# Files staged in your workspace\n${staged.map((a) => `- ${a.workspaceName} (${a.kind}, ${a.size} bytes)`).join('\n')}`
      );
    }
  }

  const parts = [];
  const wanted = run.attachments.filter((a) => node.uses_attachments.includes(a.id));
  for (const meta of wanted) {
    const file = await loadFile(meta.id);
    if (!file) continue;
    if (meta.kind === 'text') {
      sections.push(`# Attached file: ${meta.name}\n\`\`\`\n${truncate(file.buffer.toString('utf8'), TEXT_FILE_CAP)}\n\`\`\``);
    } else if (meta.kind === 'image') {
      if (model?.vision) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${meta.mime};base64,${file.buffer.toString('base64')}` },
        });
      } else {
        sections.push(`# Attached file: ${meta.name}\n[Image omitted — this model has no vision. Note this under Blockers if it matters.]`);
      }
    } else if (meta.kind === 'pdf') {
      parts.push({
        type: 'file',
        file: { filename: meta.name, file_data: `data:application/pdf;base64,${file.buffer.toString('base64')}` },
      });
    } else {
      const hint = hasCode && meta.workspaceName ? ` It is staged in your workspace as "${meta.workspaceName}" — use your tools to inspect it.` : '';
      sections.push(`# Attached file: ${meta.name}\n[Binary file (${meta.mime}, ${meta.size} bytes) — content not inlined.${hint}]`);
    }
  }

  const text = sections.join('\n\n');
  if (!parts.length) return text;
  return [{ type: 'text', text }, ...parts];
}

function nodePdfPlugin(run, node) {
  const hasPdf = run.attachments.some((a) => node.uses_attachments.includes(a.id) && a.kind === 'pdf');
  // The free pdf-text engine covers digital PDFs; models with native PDF
  // support bypass the parser anyway.
  return hasPdf ? [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }] : undefined;
}

// --- phase 3: synthesis ---------------------------------------------------------

async function synthesisPhase(run, ctx, date) {
  const { plan, settings } = run;
  const usable = plan.nodes.filter((n) => ['done', 'warn'].includes(run.nodes[n.id].status));

  if (!usable.length) {
    const reason = plan.nodes.map((n) => run.nodes[n.id]?.error).find(Boolean);
    throw new Error(reason ? `All agents failed: ${reason}` : 'All agents failed — nothing to synthesize.');
  }

  // Single-node runs can skip synthesis entirely: the node output IS the answer.
  if (plan.synthesis === 'none' && plan.nodes.length === 1 && usable.length === 1) {
    run.answer = run.nodes[usable[0].id].output;
    emit(run, 'phase', { phase: 'synthesis' });
    for (let i = 0; i < run.answer.length; i += 2000) {
      emit(run, 'answer_delta', { text: run.answer.slice(i, i + 2000) });
    }
    emit(run, 'answer_done', {});
    return;
  }

  emit(run, 'phase', { phase: 'synthesis' });
  const nodeOutputs = plan.nodes
    .map((n) => {
      const st = run.nodes[n.id];
      if (st.status === 'failed') return `## [${n.id}] ${n.title}\n(FAILED: ${st.error})`;
      if (st.status === 'skipped') return `## [${n.id}] ${n.title}\n(SKIPPED — upstream failure)`;
      if (st.status === 'dropped') return `## [${n.id}] ${n.title}\n(DROPPED during plan adaptation)`;
      const warn = st.status === 'warn' ? `\n(Verifier warning: ${st.verify?.feedback})` : '';
      return `## [${n.id}] ${n.title}${warn}\n${truncate(st.output, NODE_OUTPUT_CAP)}`;
    })
    .join('\n\n');

  const res = await chat({
    apiKey: settings.apiKey,
    ...routeModel(settings.orchestratorModel, { preferFree: settings.preferFree }),
    reasoning: getModel(settings.orchestratorModel)?.reasoning ? { effort: 'low' } : undefined,
    maxTokens: 16_000,
    signal: run.abort.signal,
    messages: [
      { role: 'system', content: synthesisSystemPrompt() },
      {
        role: 'user',
        content: synthesisUserPrompt({ task: run.task, conversationContext: ctx, plan, nodeOutputs, artifacts: run.artifacts, date }),
      },
    ],
    onDelta: (text) => emit(run, 'answer_delta', { text }),
    onRestart: () => emit(run, 'answer_reset', {}),
  });
  addUsage(run, res);
  run.answer = res.content;
  emit(run, 'answer_done', {});
}
