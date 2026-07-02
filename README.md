# ✦ Maestro

Local multi-model agent orchestration with a Claude-style browser UI, powered by [OpenRouter](https://openrouter.ai). **Zero dependencies** — plain Node.js, no build step, no `npm install`.

Give it a task. A frontier orchestrator model plans it as a task graph and routes every node to the cheapest model that can do it well — automatically preferring **$0 `:free` variants** on OpenRouter when they exist, with silent fallback to the paid slug. You review and steer the plan before launch. Agents then run in parallel **with real tools** — live web search, and a real code sandbox (9 languages, a Python venv with numpy/pandas/matplotlib/sympy, `pip_install`) — and every deliverable is verified by a model that *actually tests it*: re-running the code, resolving the citations. When a node fails, the orchestrator revises the graph mid-run. Finally one polished answer is synthesized — with **LaTeX formulas and mermaid diagrams rendered natively, charts displayed inline, and HTML apps/games playable right in the chat** (fullscreen button included). Files the agents produce are downloadable artifacts, and the whole run renders live as an animated DAG with per-node costs.

## Quick start

```bash
node server.js          # → http://localhost:4646
```

Open the URL, click the gear icon, paste your OpenRouter API key (from [openrouter.ai/keys](https://openrouter.ai/keys)), and assign a task.

No key yet? Try the UI with a simulated run:

```bash
MOCK=1 node server.js
```

Requires Node ≥ 18.17 (plus `python3` on PATH for agents' Python execution). The `OPENROUTER_API_KEY` environment variable overrides the stored key.

## How a run works

```
task ──► ORCHESTRATOR (plans JSON task graph, knows the fleet's prices & strengths)
              │
              ▼
        PLAN REVIEW (you) — reroute models, toggle tools, edit briefs,
              │             delete nodes, then launch (optional gate)
              ▼
        ┌─ n1 research [web] ────┐          nodes without mutual
        ├─ n2 research [web] ────┤◄─────────dependencies run in
        └─ n3 extract ───────────┘          parallel (pool of 4)
              │ deliverables
              ▼
          n4 build & test [code]   ◄── agent loop: model ↔ tools until done
              │
              ▼
        VERIFIER (gpt-5-mini + tools) re-runs code, spot-checks citations
              │ fail → retry node once with feedback
              │ node failed for good → ORCHESTRATOR adapts the graph
              ▼                        (recovery nodes, reroutes, drops)
        SYNTHESIS (orchestrator) ──► final answer + downloadable artifacts
```

- **Planning** — the orchestrator (default: Claude Opus 4.5) receives the task, conversation history, attachment metadata, and a briefing on the whole fleet (live prices, strengths, weaknesses). It emits a task graph: 1–2 nodes for easy tasks, up to 12 for complex ones. Each node declares its model, reasoning effort, **tool groups**, dependencies, a fully standalone instruction brief, concrete deliverables, and a verification rubric.
- **Plan review** — with "Review plans" on (default), the run pauses so you can steer: click any node to change its model, reasoning effort, tools, or instructions, or remove it entirely (dependents rewire to its upstreams). The DAG is the steering wheel, not just a visualization.
- **Tools** — each node can be granted `web` (search + fetch pages, with sources cited) and/or `code`: a real sandbox that runs whatever your machine has (python/node/bash always; ruby, perl, java, swift, C, C++, go, rust auto-detected — compiled languages are compiled automatically). Python executes in a dedicated venv (`data/sandbox/venv`, created at first start) with numpy, pandas, matplotlib (headless), sympy and openpyxl preinstalled; agents extend it with `pip_install`. Every run gets an isolated workspace under `data/workspaces/<runId>`; attachments are staged into it, and files agents write become downloadable artifacts. Standalone code an agent only wrote in its answer is auto-saved into the workspace too, so it's always runnable. Tool calls stream live into the node's **Activity** tab.
- **Rich output** — answers render LaTeX math (KaTeX) and \`\`\`mermaid diagrams; chart images (matplotlib PNGs/SVGs) display inline in the answer and as a gallery; HTML artifacts (games, mini-apps, interactive visualizations) embed as live sandboxed previews with a fullscreen button.
- **Free-variant routing** — models with a `:free` sibling on OpenRouter (detected live at startup) are called through the free slug first and transparently fall back to the paid one on rate-limits or provider failures. Toggle in Settings.
- **Verification with teeth** — the verifier inherits the node's tools: for code nodes it re-runs the code/tests itself; for web nodes it fetches the load-bearing citations and checks they say what the agent claims. Failures get one retry with the verifier's feedback attached; a second failure marks the node "done with warnings" rather than sinking the run.
- **Adaptive replanning** — when a node fails outright, the orchestrator sees the current graph state and can add recovery nodes, reroute pending nodes to different models, or drop doomed ones (max 2 adaptations per run, pending nodes only). The revised graph animates into the DAG with the reason shown.
- **Cost tracking** — real cost per call from OpenRouter's usage accounting (not estimates), rolled up per node, per run, and per conversation in the sidebar.

## The fleet

Curated in [`src/models.js`](src/models.js) — 17 models spanning frontier (Opus 4.5, GPT-5.1, Gemini 3.1 Pro, **GLM 5.2**, **Nemotron 3 Ultra**), mid-tier (Sonnet, Haiku, GPT-5 Mini, Grok 4.3, Kimi K2, R1) and budget (Gemini Flash/Lite, DeepSeek V3, Qwen3 Coder, GPT-5 Nano, Mistral Small). At startup Maestro merges **live pricing** from the OpenRouter catalog, detects `:free` variants, and silently drops any model whose slug no longer exists, so the planner never routes to a dead model.

Edit the file to change the fleet — the `strengths`/`weaknesses` strings are read verbatim by the orchestrator when routing, so keep them honest and comparative.

## Layout

```
server.js            zero-dep HTTP server: API routes, SSE relay, plan approval,
                     artifact downloads, static files
src/
  orchestrator.js    plan → review gate → tool-loop agents → verify/retry
                     → adaptive replanning → synthesize
  tools.js           the agent tool layer: web_search, fetch_url, run_code,
                     workspace file I/O (sandboxed per run)
  prompts.js         all system prompts (tune behavior here)
  models.js          the curated fleet + live pricing merge
  openrouter.js      streaming SSE client with tool-call support and retry
  store.js           flat-file persistence (conversations, settings, uploads)
  mock.js            simulated runs for demoing the UI
public/              the Claude-style UI (vanilla JS, no build)
data/                created at runtime: settings.json (incl. your API key),
                     chats, uploads, per-run workspaces
```

## Settings (gear icon)

| Setting | Default | Notes |
|---|---|---|
| Orchestrator model | `anthropic/claude-opus-4.5` | plans, adapts, synthesizes |
| Verifier model | `openai/gpt-5-mini` | keep it cheap — it runs per node, with tools |
| Brave Search API key | — | optional; sharper `web_search` than the DuckDuckGo fallback ([free tier](https://brave.com/search/api/)) |
| Review plans before launch | on | the steerable-graph gate; toggle off for fully autonomous runs |
| Prefer :free variants | on | try $0 free slugs first, fall back to paid automatically |
| Max parallel agents | 4 | concurrency pool |
| Max retries per node | 1 | retries include verifier feedback |
| Mock mode | off | simulate runs without API calls |

## Privacy, safety & cost notes

- Everything is stored locally in `data/` (git-ignored). Your key never leaves your machine except to call OpenRouter.
- Task content is sent to whichever providers the plan routes to — check OpenRouter's per-provider data policies if that matters for your documents.
- `run_code` executes agent-written code **on your machine** (scoped to the run's workspace directory, secrets stripped from its environment, 120 s timeout — but not a container). Don't point Maestro at hostile inputs, and read the plan before approving if that concerns you.
- `fetch_url` refuses local/private network addresses.
- A typical multi-agent run costs a few cents; the header shows live cost while it runs, and you can hit **Stop** at any time.
