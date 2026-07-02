#!/usr/bin/env node
// Maestro benchmark runner — the evidence engine.
//
// Runs every task in bench/tasks.jsonl through one or more execution modes and
// scores the results, so the core claim ("frontier-quality output at a fraction
// of frontier cost") is a measured number instead of an architecture diagram.
//
//   node bench/run.js                                    # maestro vs opus-only, all tasks
//   node bench/run.js --only c1,m1                       # subset by task id
//   node bench/run.js --category code --tier simple      # subset by facets
//   node bench/run.js --modes maestro,single:openai/gpt-5.1,single:anthropic/claude-opus-4.5
//   node bench/run.js --mock                             # pipeline smoke test, zero spend
//   node bench/run.js --list                             # show the task corpus
//
// Modes:
//   maestro           full pipeline: planner → parallel agents → verifier → synthesis
//   single:<model>    one agent node on <model> with the same tools, no verifier,
//                     no retries — what "just ask a frontier model" would get you
//
// Scoring (per task, from tasks.jsonl):
//   tests          the task's Python asserts run against the workspace → 10 or 0
//   exact          expected string must appear in the final answer → 10 or 0
//   judge          a judge model scores the answer 0–10 against the task
//   judge+checks   judge score gated by programmatic checks (artifacts exist,
//                  test commands pass, citation domains present)
//   exact-runtime  live-web research tasks — judged (no offline ground truth);
//                  flagged as such in the report
//
// Costs: `preferFree` is OFF in benchmarks by default so the economics are the
// real paid prices, not rate-limited $0 variants. Enable with --prefer-free.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as store from '../src/store.js';
import { chat } from '../src/openrouter.js';
import { getModel, ensureLivePricing } from '../src/models.js';
import { initSandbox } from '../src/tools.js';
import { createRun, executeRun, workspacePath } from '../src/orchestrator.js';
import { executeMockRun } from '../src/mock.js';
import { extractJson } from '../src/util.js';
import { DATA_ROOT } from '../src/paths.js';

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const TASKS_PATH = path.join(BENCH_DIR, 'tasks.jsonl');
const IMAGE_EXT = /\.(png|svg|jpe?g|gif|webp)$/i;

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = {
    modes: ['maestro', 'single:anthropic/claude-opus-4.5'],
    only: null,
    category: null,
    tier: null,
    judge: 'openai/gpt-5.1',
    timeout: 900,
    out: path.join(BENCH_DIR, 'results'),
    mock: false,
    preferFree: false,
    list: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--modes') args.modes = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--only') args.only = new Set(next().split(',').map((s) => s.trim()));
    else if (a === '--category') args.category = new Set(next().split(',').map((s) => s.trim()));
    else if (a === '--tier') args.tier = new Set(next().split(',').map((s) => s.trim()));
    else if (a === '--judge') args.judge = next();
    else if (a === '--timeout') args.timeout = Math.max(30, Number(next()) || 900);
    else if (a === '--out') args.out = path.resolve(next());
    else if (a === '--mock') args.mock = true;
    else if (a === '--prefer-free') args.preferFree = true;
    else if (a === '--list') args.list = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node bench/run.js [--modes m1,m2] [--only ids] [--category c] [--tier t] [--judge model] [--timeout s] [--mock] [--prefer-free] [--list]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a} (try --help)`);
      process.exit(1);
    }
  }
  return args;
}

async function loadTasks(args) {
  const raw = await fs.readFile(TASKS_PATH, 'utf8');
  const tasks = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  return tasks.filter(
    (t) =>
      (!args.only || args.only.has(t.id)) &&
      (!args.category || args.category.has(t.category)) &&
      (!args.tier || args.tier.has(t.tier))
  );
}

// ---------------------------------------------------------------- run execution

function baselinePlan(modelId) {
  const reasoning = getModel(modelId)?.reasoning ? 'medium' : 'none';
  return {
    analysis: 'Benchmark baseline: the entire task is handled by one model in a single agent node.',
    strategy: `Single-model baseline (${modelId}).`,
    synthesis: 'none',
    nodes: [
      {
        id: 'n1',
        title: 'Complete task (baseline)',
        objective: 'Complete the user task end-to-end.',
        model: modelId,
        reasoning,
        tools: ['web', 'code'],
        depends_on: [],
        uses_attachments: [],
        instructions:
          'Complete the original user task end-to-end in one pass. You have web and code tools — use them when the task needs live facts, executed code, or saved files. Save every requested file to the workspace. Deliver the complete final answer.',
        deliverables: ['The complete final answer to the user task, with any requested files saved to the workspace.'],
        verification: 'none',
      },
    ],
  };
}

async function executeOne(task, mode, args, baseSettings) {
  const settings = { ...baseSettings, approvePlans: false, mock: false, preferFree: args.preferFree };
  if (mode !== 'maestro') settings.maxRetries = 0;

  const conversation = { id: `bench_${task.id}`, title: `bench ${task.id}`, messages: [] };
  const run = createRun({ conversation, task: task.prompt, attachments: [], settings });
  if (mode.startsWith('single:')) run.presetPlan = baselinePlan(mode.slice('single:'.length));

  let snap = null;
  const watchdog = setTimeout(() => {
    if (!run.endedAt) {
      run.stopMessage = `Benchmark timeout after ${args.timeout}s.`;
      run.abort.abort();
    }
  }, args.timeout * 1000);

  const started = Date.now();
  try {
    const engine = args.mock ? executeMockRun : executeRun;
    await engine(run, conversation, { onFinished: async (s) => { snap = s; } });
  } finally {
    clearTimeout(watchdog);
  }
  return { run, snap, durationMs: Date.now() - started };
}

// ---------------------------------------------------------------- scoring

async function venvPython() {
  const p = path.join(DATA_ROOT, 'sandbox', 'venv', 'bin', 'python3');
  try {
    await fs.access(p);
    return p;
  } catch {
    return 'python3';
  }
}

function sh(cmd, cmdArgs, { cwd, timeout = 90_000 }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.slice(0, 4000) });
    });
  });
}

async function scoreTests(task, run) {
  const workspace = workspacePath(run.id);
  const testFile = path.join(workspace, `bench_test_${task.id}.py`);
  await fs.writeFile(testFile, task.tests + '\nprint("ALL TESTS PASSED")\n');
  const py = await venvPython();
  const r = await sh(py, [testFile], { cwd: workspace });
  const pass = r.code === 0 && r.out.includes('ALL TESTS PASSED');
  return { score: pass ? 10 : 0, pass, feedback: pass ? 'all asserts passed' : `tests failed: ${r.out.slice(-600)}` };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[,\s]+/g, ' ').trim();

function scoreExact(task, answer) {
  const pass = norm(answer).includes(norm(task.expected)) || norm(answer).replace(/\s/g, '').includes(norm(task.expected).replace(/\s/g, ''));
  return { score: pass ? 10 : 0, pass, feedback: pass ? `answer contains "${task.expected}"` : `expected "${task.expected}" not found in the final answer` };
}

function citedDomains(answer) {
  const domains = new Set();
  for (const m of String(answer).matchAll(/https?:\/\/([^\s)"'<\]]+)/g)) {
    try {
      const host = new URL(`https://${m[1]}`).hostname.replace(/^www\./, '');
      if (host && host !== 'example.invalid') domains.add(host);
    } catch {}
  }
  return domains;
}

async function runChecks(task, run, answer) {
  const checks = task.checks || {};
  const details = [];
  let pass = true;
  const artifacts = (run.artifacts || []).map((f) => f.path);

  for (const name of checks.artifacts || []) {
    const ok = artifacts.some((p) => p === name || p.endsWith(`/${name}`));
    details.push(`artifact ${name}: ${ok ? 'ok' : 'MISSING'}`);
    if (!ok) pass = false;
  }
  if (checks.min_image_artifacts) {
    const n = artifacts.filter((p) => IMAGE_EXT.test(p)).length;
    const ok = n >= checks.min_image_artifacts;
    details.push(`image artifacts ${n}/${checks.min_image_artifacts}: ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) pass = false;
  }
  if (checks.min_distinct_cited_domains) {
    const n = citedDomains(answer).size;
    const ok = n >= checks.min_distinct_cited_domains;
    details.push(`cited domains ${n}/${checks.min_distinct_cited_domains}: ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) pass = false;
  }
  if (checks.must_cite_domain) {
    const ok = [...citedDomains(answer)].some((d) => d.endsWith(checks.must_cite_domain));
    details.push(`cites ${checks.must_cite_domain}: ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) pass = false;
  }
  if (checks.tests_cmd) {
    const r = await sh('bash', ['-c', checks.tests_cmd], { cwd: workspacePath(run.id), timeout: 120_000 });
    const ok = r.code === 0;
    details.push(`tests_cmd exit ${r.code}: ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) pass = false;
  }
  return { pass, details };
}

const TEXT_ARTIFACT = /\.(csv|md|txt|json|py|js|html?)$/i;

async function judgeContext(task, run, answer) {
  const parts = [`## The task given to the system\n${task.prompt}`];
  if (task.notes) parts.push(`## Scoring notes\n${task.notes}`);
  const artifacts = run.artifacts || [];
  if (artifacts.length) {
    parts.push(`## Files the system saved (workspace artifacts)\n${artifacts.map((f) => `- ${f.path} (${f.size} bytes)`).join('\n')}`);
    const texts = artifacts.filter((f) => TEXT_ARTIFACT.test(f.path)).slice(0, 3);
    for (const f of texts) {
      const content = await fs.readFile(path.join(workspacePath(run.id), f.path), 'utf8').catch(() => null);
      if (content) parts.push(`## Content of artifact ${f.path} (first 4000 chars)\n\`\`\`\n${content.slice(0, 4000)}\n\`\`\``);
    }
  }
  parts.push(`## The system's final answer\n${String(answer || '(no answer)').slice(0, 30_000)}`);
  return parts.join('\n\n');
}

async function scoreJudge(task, run, answer, args, apiKey, scoringUsage) {
  const res = await chat({
    apiKey,
    model: args.judge,
    maxTokens: 1500,
    reasoning: getModel(args.judge)?.reasoning ? { effort: 'low' } : undefined,
    messages: [
      {
        role: 'system',
        content: `You are a strict, impartial evaluator of AI task outputs. Score how completely and correctly the final answer (plus its saved files) fulfils the task, on a 0-10 scale:
- 10-9: every requirement met, correct, well-executed
- 8-7: requirements met with minor gaps or rough edges
- 6-5: mostly done but a real requirement is weak or partially missing
- 4-3: substantial requirements missing or wrong
- 2-0: barely addresses the task or is substantially wrong
Judge substance, not style. If the task demands citations, uncited factual claims are a real gap. If the task demands files/charts, missing artifacts are a real gap. Respond with JSON only: {"score": 0-10, "feedback": "max 60 words"}`,
      },
      { role: 'user', content: await judgeContext(task, run, answer) },
    ],
  });
  scoringUsage.cost += res.cost || 0;
  scoringUsage.calls += 1;
  const verdict = extractJson(res.content);
  const score = Math.max(0, Math.min(10, Number(verdict.score) || 0));
  return { score, feedback: String(verdict.feedback || '') };
}

async function scoreResult(task, run, snap, args, apiKey, scoringUsage) {
  if (args.mock) return { score: null, pass: null, feedback: 'mock run — not scored', checks: null };
  const answer = snap?.answer || '';
  if (snap?.status !== 'done') {
    return { score: 0, pass: false, feedback: `run ${snap?.status || 'crashed'}: ${snap?.stopMessage || ''}`.trim(), checks: null };
  }

  if (task.scoring === 'tests') return { ...(await scoreTests(task, run)), checks: null };
  if (task.scoring === 'exact') return { ...scoreExact(task, answer), checks: null };

  // judge / judge+checks / exact-runtime (judged — no offline ground truth)
  let checks = null;
  if (task.scoring === 'judge+checks') checks = await runChecks(task, run, answer);
  let judged;
  try {
    judged = await scoreJudge(task, run, answer, args, apiKey, scoringUsage);
  } catch (err) {
    return { score: null, pass: null, feedback: `judge unavailable: ${err.message}`, checks: checks?.details || null };
  }
  let score = judged.score;
  let feedback = judged.feedback;
  if (checks && !checks.pass) {
    score = Math.min(score, 4);
    feedback = `checks failed (${checks.details.filter((d) => /FAIL|MISSING/.test(d)).join('; ')}) — ${feedback}`;
  }
  return { score, pass: score >= 6 && (!checks || checks.pass), feedback, checks: checks?.details || null };
}

// ---------------------------------------------------------------- reporting

const fmt$ = (v) => (v >= 0.995 ? `$${v.toFixed(2)}` : `$${(v || 0).toFixed(3)}`);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

function aggregate(rows) {
  const byMode = new Map();
  for (const r of rows) {
    const g = byMode.get(r.mode) || { mode: r.mode, n: 0, scored: 0, passed: 0, scoreSum: 0, cost: 0, ms: 0 };
    g.n++;
    if (r.score != null) {
      g.scored++;
      g.scoreSum += r.score;
      if (r.pass) g.passed++;
    }
    g.cost += r.cost || 0;
    g.ms += r.durationMs || 0;
    byMode.set(r.mode, g);
  }
  return [...byMode.values()];
}

function summaryTable(groups) {
  const lines = [
    '| Mode | Tasks | Pass rate | Avg score | Total cost | Avg time |',
    '|---|---|---|---|---|---|',
  ];
  for (const g of groups) {
    lines.push(
      `| ${g.mode} | ${g.n} | ${pct(g.passed, g.scored)} (${g.passed}/${g.scored}) | ${g.scored ? (g.scoreSum / g.scored).toFixed(1) : '—'} | ${fmt$(g.cost)} | ${(g.ms / g.n / 1000).toFixed(0)}s |`
    );
  }
  return lines.join('\n');
}

function headline(groups) {
  const maestro = groups.find((g) => g.mode === 'maestro');
  const singles = groups.filter((g) => g.mode !== 'maestro');
  if (!maestro || !singles.length || !maestro.scored) return '';
  const lines = [];
  for (const s of singles) {
    if (!s.scored) continue;
    const costRatio = maestro.cost > 0 ? (s.cost / maestro.cost).toFixed(1) : '—';
    lines.push(
      `**Maestro: ${pct(maestro.passed, maestro.scored)} pass at ${fmt$(maestro.cost)} vs ${s.mode}: ${pct(s.passed, s.scored)} pass at ${fmt$(s.cost)}** (${costRatio}× Maestro's cost).`
    );
  }
  return lines.join('\n');
}

function detailTable(rows) {
  const lines = [
    '| Task | Cat | Tier | Mode | Score | Pass | Cost | Time | Feedback |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.task} | ${r.category} | ${r.tier} | ${r.mode} | ${r.score ?? '—'} | ${r.pass == null ? '—' : r.pass ? '✅' : '❌'} | ${fmt$(r.cost || 0)} | ${Math.round((r.durationMs || 0) / 1000)}s | ${String(r.feedback || '').replace(/\|/g, '/').slice(0, 140)} |`
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = await loadTasks(args);

  if (args.list) {
    for (const t of tasks) console.log(`${t.id}\t${t.category}/${t.tier}\t${t.scoring}\t${t.prompt.slice(0, 90).replace(/\n/g, ' ')}…`);
    console.log(`\n${tasks.length} tasks`);
    return;
  }
  if (!tasks.length) {
    console.error('No tasks match the given filters.');
    process.exit(1);
  }

  await store.init();
  const baseSettings = await store.loadSettings();
  baseSettings.apiKey = process.env.OPENROUTER_API_KEY || baseSettings.apiKey;
  if (!args.mock && !baseSettings.apiKey) {
    console.error('No OpenRouter API key: set OPENROUTER_API_KEY or add one in the app settings. (Or use --mock.)');
    process.exit(1);
  }
  await ensureLivePricing();
  await initSandbox().catch(() => {});

  const modes = args.mock ? ['maestro'] : args.modes;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(args.out, stamp);
  await fs.mkdir(outDir, { recursive: true });
  const resultsPath = path.join(outDir, 'results.jsonl');

  console.log(`\n  ✦ Maestro bench — ${tasks.length} tasks × ${modes.length} mode(s)${args.mock ? ' [MOCK]' : ''}`);
  console.log(`    modes: ${modes.join(', ')}`);
  console.log(`    judge: ${args.judge} · preferFree: ${args.preferFree} · timeout: ${args.timeout}s`);
  console.log(`    results → ${path.relative(process.cwd(), outDir)}\n`);

  const rows = [];
  const scoringUsage = { cost: 0, calls: 0 };
  let interrupted = false;
  process.on('SIGINT', () => {
    console.log('\n  interrupted — writing partial report…');
    interrupted = true;
  });

  for (const task of tasks) {
    for (const mode of modes) {
      if (interrupted) break;
      process.stdout.write(`  ${task.id} [${mode}] … `);
      let row = { ts: Date.now(), task: task.id, category: task.category, tier: task.tier, scoring: task.scoring, mode };
      try {
        const { run, snap, durationMs } = await executeOne(task, mode, args, baseSettings);
        const s = await scoreResult(task, run, snap, args, baseSettings.apiKey, scoringUsage);
        row = {
          ...row,
          runId: run.id,
          status: snap?.status || 'unknown',
          pass: s.pass,
          score: s.score,
          feedback: s.feedback,
          checks: s.checks,
          cost: snap?.totals?.cost || 0,
          baselineCost: snap?.totals?.baselineCost || 0,
          tokensIn: snap?.totals?.tokensIn || 0,
          tokensOut: snap?.totals?.tokensOut || 0,
          calls: snap?.totals?.calls || 0,
          durationMs,
          artifacts: (snap?.artifacts || []).map((f) => f.path),
        };
        console.log(`${s.pass == null ? 'done' : s.pass ? 'PASS' : 'FAIL'} · score ${s.score ?? '—'} · ${fmt$(row.cost)} · ${Math.round(durationMs / 1000)}s`);
      } catch (err) {
        row = { ...row, status: 'crashed', pass: false, score: 0, feedback: err.message, cost: 0, durationMs: 0 };
        console.log(`CRASH · ${err.message}`);
      }
      rows.push(row);
      await fs.appendFile(resultsPath, JSON.stringify(row) + '\n');
    }
    if (interrupted) break;
  }

  const groups = aggregate(rows);
  const judgedNote = rows.some((r) => r.scoring === 'exact-runtime')
    ? '\n> Research (`exact-runtime`) tasks are scored by the judge model, not verified against live ground truth — spot-check them manually.\n'
    : '';
  const report = `# Maestro benchmark report

- Date: ${new Date().toISOString()}
- Tasks: ${tasks.length} (${[...new Set(tasks.map((t) => t.category))].join(', ')})
- Modes: ${modes.join(', ')}
- Judge: ${args.judge} · preferFree: ${args.preferFree}${args.mock ? '\n- **MOCK RUN — no model calls, scores are null**' : ''}

${headline(groups)}

## Summary

${summaryTable(groups)}

Scoring overhead (judge calls): ${fmt$(scoringUsage.cost)} across ${scoringUsage.calls} calls (not included in mode costs).
${judgedNote}
## Per-task results

${detailTable(rows)}
`;
  await fs.writeFile(path.join(outDir, 'report.md'), report);

  console.log(`\n${summaryTable(groups).replace(/\|/g, ' ')}\n`);
  const head = headline(groups);
  if (head) console.log(`  ${head.replace(/\*\*/g, '')}\n`);
  console.log(`  ✦ full report: ${path.relative(process.cwd(), path.join(outDir, 'report.md'))}\n`);
}

main().catch((err) => {
  console.error('bench runner failed:', err);
  process.exit(1);
});
