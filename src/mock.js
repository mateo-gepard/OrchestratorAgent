// Mock orchestration — simulates a full run without touching OpenRouter.
// Enable via Settings → Mock mode, or `MOCK=1 node server.js`.
// Exercises every UI state: parallel roots, dependencies, a verification
// retry, streaming deltas, per-node cost, synthesis streaming.

import { emit, snapshot } from './orchestrator.js';
import { sleep } from './util.js';

const MOCK_PLAN = {
  analysis:
    'The task needs two independent research angles that can run in parallel, a drafting step that depends on both, and a cheap final fact-check pass.',
  strategy: 'Parallel budget research → frontier draft → cheap verification pass.',
  synthesis: 'full',
  synthesis_instructions: 'Merge the draft with fact-check corrections into one polished answer.',
  nodes: [
    {
      id: 'n1',
      title: 'Research: market landscape',
      objective: 'Collect the key facts on the market landscape.',
      model: 'google/gemini-2.5-flash',
      reasoning: 'none',
      depends_on: [],
      uses_attachments: [],
      instructions: 'Gather the ten most relevant facts with sources.',
      deliverables: ['A bullet list of 10 facts', 'One-line source note per fact'],
      verification: 'All 10 facts present, each with a source note.',
    },
    {
      id: 'n2',
      title: 'Research: technical constraints',
      objective: 'Enumerate the technical constraints that shape the solution.',
      model: 'deepseek/deepseek-chat',
      reasoning: 'none',
      depends_on: [],
      uses_attachments: [],
      instructions: 'List every technical constraint with a short rationale.',
      deliverables: ['A table of constraints with rationale'],
      verification: 'Table present with at least 5 constraints.',
    },
    {
      id: 'n3',
      title: 'Draft the recommendation',
      objective: 'Write the full recommendation using both research inputs.',
      model: 'anthropic/claude-sonnet-4.5',
      reasoning: 'medium',
      depends_on: ['n1', 'n2'],
      uses_attachments: [],
      instructions: 'Weave both inputs into a structured recommendation.',
      deliverables: ['A complete recommendation with an executive summary'],
      verification: 'Executive summary present; recommendation references both research inputs.',
    },
    {
      id: 'n4',
      title: 'Fact-check the draft',
      objective: 'Check every claim in the draft against the research.',
      model: 'openai/gpt-5-mini',
      reasoning: 'low',
      depends_on: ['n3'],
      uses_attachments: [],
      instructions: 'Flag and correct unsupported claims.',
      deliverables: ['List of corrections (or "no issues found")'],
      verification: 'none',
    },
  ],
};

const LOREM =
  'Here is the simulated deliverable content for this sub-agent. Each sentence streams in like a real model response would. The mock run exists so the interface can be exercised without spending a cent on API calls. Costs, tokens, verification verdicts and retries below are all synthetic but structurally identical to a live run. '.repeat(3);

const MOCK_ANSWER = `## Recommendation (mock)

This is a **simulated final answer** produced by the mock orchestrator, so you can see exactly how a live run renders — the task graph above executed two research agents in parallel, funneled their outputs into a drafting agent, and fact-checked the result.

### What a real run gives you
1. A task graph planned by the orchestrator model
2. Cost-optimized routing across ${MOCK_PLAN.nodes.length} sub-agents
3. Deliverable verification with automatic retry
4. A synthesized, stand-alone answer — this text

> Add your OpenRouter API key in **Settings** and disable mock mode to run this for real.`;

async function streamText(run, text, emitFn, cps = 900) {
  const chunkSize = 24;
  for (let i = 0; i < text.length; i += chunkSize) {
    if (run.abort.signal.aborted) throw new Error('aborted');
    emitFn(text.slice(i, i + chunkSize));
    await sleep((chunkSize / cps) * 1000);
  }
}

export async function executeMockRun(run, conversation, { onFinished }) {
  try {
    emit(run, 'phase', { phase: 'planning' });
    await sleep(1800);

    run.plan = MOCK_PLAN;
    for (const n of MOCK_PLAN.nodes) {
      run.nodes[n.id] = { status: 'pending', attempt: 0, output: '', cost: 0, tokensIn: 0, tokensOut: 0, ms: 0 };
    }
    emit(run, 'plan', MOCK_PLAN);
    addMockUsage(run, 0.021, 2100, 900);

    // Honor the plan-review gate so the approval UI can be exercised in mock
    // mode too (edits are accepted but not applied to the canned plan).
    if (run.settings?.approvePlans) {
      run.status = 'awaiting';
      emit(run, 'phase', { phase: 'awaiting_approval' });
      await new Promise((resolve, reject) => {
        run.approval = { resolve };
        run.abort.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      run.approval = null;
      run.status = 'running';
      emit(run, 'plan', run.plan);
    }

    emit(run, 'phase', { phase: 'running' });

    // n1 + n2 in parallel; n3 gets one failed verification then a retry.
    await Promise.all([
      mockNode(run, 'n1', { cost: 0.004, delay: 300 }),
      mockNode(run, 'n2', { cost: 0.002, delay: 900 }),
    ]);
    await mockNode(run, 'n3', { cost: 0.058, delay: 200, failFirst: true });
    await mockNode(run, 'n4', { cost: 0.003, delay: 100, skipVerify: true });

    emit(run, 'phase', { phase: 'synthesis' });
    await sleep(600);
    await streamText(run, MOCK_ANSWER, (t) => emit(run, 'answer_delta', { text: t }));
    run.answer = MOCK_ANSWER;
    addMockUsage(run, 0.031, 4200, 1300);
    emit(run, 'answer_done', {});

    run.status = 'done';
    run.endedAt = Date.now();
    emit(run, 'phase', { phase: 'done' });
  } catch {
    run.status = 'stopped';
    run.endedAt = Date.now();
    if (!run.answer) run.answer = '*Run stopped.*';
    emit(run, 'error', { message: 'Run stopped by user.' });
    emit(run, 'phase', { phase: 'stopped' });
  }
  emit(run, 'done', snapshot(run));
  await onFinished(snapshot(run));
}

function addMockUsage(run, cost, tin, tout) {
  run.totals.cost += cost;
  run.totals.tokensIn += tin;
  run.totals.tokensOut += tout;
  run.totals.calls += 1;
  emit(run, 'usage', { ...run.totals });
}

async function mockNode(run, id, { cost, delay, failFirst = false, skipVerify = false }) {
  const st = run.nodes[id];
  const started = Date.now();
  await sleep(delay);

  const attempts = failFirst ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    st.attempt = attempt;
    st.status = 'running';
    st.output = '';
    emit(run, 'node_status', { id, status: 'running', attempt });

    await streamText(run, LOREM, (t) => {
      st.output += t;
      emit(run, 'node_delta', { id, text: t });
    }, 2400);

    if (!skipVerify) {
      st.status = 'verifying';
      emit(run, 'node_status', { id, status: 'verifying', attempt });
      await sleep(1200);
      const pass = !(failFirst && attempt === 1);
      const verdict = pass
        ? { pass: true, score: 9, feedback: 'All deliverables present and consistent.' }
        : { pass: false, score: 4, feedback: 'The executive summary is missing. Add it and reference both research inputs explicitly.' };
      st.verify = verdict;
      emit(run, 'verify_result', { id, ...verdict });
      addMockUsage(run, 0.0008, 900, 60);
      if (!pass) {
        emit(run, 'node_status', { id, status: 'retry', attempt, feedback: verdict.feedback });
        continue;
      }
    }

    st.status = 'done';
    st.cost = cost;
    st.tokensIn = Math.round(cost * 40000);
    st.tokensOut = Math.round(cost * 18000);
    st.ms = Date.now() - started;
    addMockUsage(run, cost, st.tokensIn, st.tokensOut);
    emit(run, 'node_result', {
      id,
      status: 'done',
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
