/* Maestro — frontend. No frameworks, no build step. */

'use strict';

// ---------------------------------------------------------------- state

const state = {
  settings: null,
  models: [],
  convos: [],
  activeId: null,
  messages: [],
  attachments: [], // pending composer attachments
  live: null, // live run state while streaming
  es: null,
  streamAbort: null,
  timer: null,
};

// per-run UI state (collapse, selected node, active tab, plan-review edits)
const cardUi = new Map();
function uiFor(runId) {
  if (!cardUi.has(runId)) cardUi.set(runId, { collapsed: false, selected: null, tab: 'output', edits: {}, openTools: new Set() });
  const ui = cardUi.get(runId);
  ui.edits ||= {};
  ui.openTools ||= new Set();
  return ui;
}

const $ = (sel) => document.querySelector(sel);
const chatEl = $('#chat');
const mainEl = $('#main');
const inputEl = $('#input');
const sendBtn = $('#sendBtn');
const HOSTED_SETTINGS_KEY = 'maestro-hosted-settings';
const STREAM_INTERRUPTED_MESSAGE =
  'The hosted stream disconnected before the final completion event. Partial output was preserved. For very long jobs, run the app locally instead of through Vercel.';

// ---------------------------------------------------------------- helpers

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtCost(c) {
  if (!c) return '$0.00';
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

function fmtTokens(n) {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${bytes} B`;
}

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function modelShort(id) {
  return (id || '').split('/').pop();
}

function toast(msg, ms = 3800) {
  document.getElementById('toast')?.remove();
  const el = document.createElement('div');
  el.id = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function loadHostedSettings() {
  try {
    return JSON.parse(localStorage.getItem(HOSTED_SETTINGS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveHostedSettings(patch) {
  const current = loadHostedSettings();
  const next = { ...current };
  for (const key of ['userName', 'orchestratorModel', 'verifierModel', 'maxParallel', 'maxRetries', 'maxRunCost', 'preferFree', 'mock', 'memoryEnabled']) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (patch.apiKey) next.apiKey = patch.apiKey;
  if (patch.braveApiKey) next.braveApiKey = patch.braveApiKey;
  localStorage.setItem(HOSTED_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

function maskSecret(value) {
  return value ? `…${String(value).slice(-4)}` : '';
}

function mergeHostedSettings(serverSettings) {
  if (!serverSettings?.hosted) return serverSettings;
  const local = loadHostedSettings();
  const merged = { ...serverSettings, ...local, hosted: true, approvePlans: false };
  merged.hasApiKey = Boolean(serverSettings.hasApiKey || local.apiKey);
  merged.apiKey = serverSettings.hasApiKey ? serverSettings.apiKey : maskSecret(local.apiKey);
  merged.hasBraveKey = Boolean(serverSettings.hasBraveKey || local.braveApiKey);
  merged.braveApiKey = serverSettings.hasBraveKey ? serverSettings.braveApiKey : maskSecret(local.braveApiKey);
  return merged;
}

function hostedRunSettings() {
  if (!state.settings?.hosted) return undefined;
  const local = loadHostedSettings();
  return {
    ...local,
    userName: state.settings.userName,
    orchestratorModel: state.settings.orchestratorModel,
    verifierModel: state.settings.verifierModel,
    maxParallel: state.settings.maxParallel,
    maxRetries: state.settings.maxRetries,
    maxRunCost: state.settings.maxRunCost,
    preferFree: state.settings.preferFree,
    mock: state.settings.mock,
    memoryEnabled: state.settings.memoryEnabled,
  };
}

// --- diagnostics -------------------------------------------------------------
// A rolling log of recent API calls so any failure (a 404 on a chat, a bad
// cloud round-trip) can be inspected after the fact. Open DevTools and run
// maestroDebug() for a copy-pasteable report to hand over for debugging.
const apiLog = [];
function recordApiCall(entry) {
  apiLog.push(entry);
  if (apiLog.length > 80) apiLog.shift();
}

async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    const entry = { at: new Date().toISOString(), method, path, status: 'NETWORK_ERROR', ms: Math.round(performance.now() - t0), error: String(err && err.message || err) };
    recordApiCall(entry);
    console.error(`[maestro] ${method} ${path} → network error`, entry);
    throw new Error(`Network error reaching ${path}: ${entry.error}`);
  }
  const ms = Math.round(performance.now() - t0);
  const ctype = res.headers.get('content-type') || '';
  // Read the body as text first so a non-JSON error (e.g. a platform HTML 404
  // page, which means the request never reached Maestro's handler) is still
  // captured and distinguishable from our own JSON {error} responses.
  const raw = await res.text().catch(() => '');
  let json = {};
  if (raw) {
    try { json = JSON.parse(raw); } catch { json = { _nonJson: true, _bodySnippet: raw.slice(0, 300) }; }
  }
  const entry = { at: new Date().toISOString(), method, path, status: res.status, ms, ctype };
  if (!res.ok) {
    entry.error = json.error || `HTTP ${res.status}`;
    if (json._nonJson) {
      entry.origin = 'platform/non-JSON (request may not have reached the app)';
      entry.bodySnippet = json._bodySnippet;
    } else {
      entry.origin = 'maestro handler';
    }
    console.error(`[maestro] ${method} ${path} → ${res.status} (${entry.origin}) in ${ms}ms`, json.error ? json.error : json);
  }
  recordApiCall(entry);
  if (res.status === 401) {
    // Protected deployment (MAESTRO_ACCESS_CODE) — collect the code once,
    // store it as a cookie (EventSource/artifact requests send it too), reload.
    const code = prompt('This Maestro deployment is protected.\nEnter the access code:');
    if (code && code.trim()) {
      document.cookie = `maestro_access=${encodeURIComponent(code.trim())}; path=/; max-age=31536000; SameSite=Lax`;
      location.reload();
    }
    throw new Error(json.error || 'Access code required');
  }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// Copy-pasteable diagnostics report. Run maestroDebug() in the browser
// console and share the output; it captures client state, the resolved cloud
// status, and the recent API-call log (including what a 404 actually returned).
async function maestroDebug() {
  const s = state.settings || {};
  const report = {
    when: new Date().toISOString(),
    url: location.href,
    userAgent: navigator.userAgent,
    client: {
      activeId: state.activeId,
      lastConvo: localStorage.getItem('maestro-last-convo'),
      sidebarConvos: (state.convos || []).map((c) => c.id),
      memoriesLoaded: (state.memories || []).length,
      liveRun: Boolean(state.live),
    },
    settings: {
      hosted: s.hosted,
      cloudConfigured: s.cloudConfigured,
      cloudConnected: s.cloudConnected,
      cloudEnvVar: s.cloudEnvVar,
      cloudEnvCandidates: s.cloudEnvCandidates,
      tursoFromEnv: s.tursoFromEnv,
      hasApiKey: s.hasApiKey,
      mock: s.mock,
    },
  };
  try {
    const boot = await api('/api/bootstrap');
    report.bootstrapLive = {
      cloudConnected: boot.settings.cloudConnected,
      cloudEnvVar: boot.settings.cloudEnvVar,
      conversations: (boot.conversations || []).length,
      memories: (boot.memories || []).length,
    };
    const last = localStorage.getItem('maestro-last-convo');
    if (last) {
      try {
        await api(`/api/conversation/${last}`);
        report.lastConvoFetch = 'OK (200)';
      } catch (e) {
        report.lastConvoFetch = `FAILED: ${e.message}`;
      }
    }
  } catch (e) {
    report.bootstrapError = e.message;
  }
  report.recentApiCalls = apiLog.slice(-30);
  console.log('%c[maestro] diagnostics — copy everything below', 'font-weight:bold;color:#c96442');
  console.log(JSON.stringify(report, null, 2));
  return report;
}
window.maestroDebug = maestroDebug;
console.info('[maestro] debugging: run maestroDebug() in this console for a copy-pasteable report.');

// ---------------------------------------------------------------- markdown

function renderMarkdown(src, ctx = {}) {
  if (!src) return '';
  const fences = [];
  let text = String(src).replace(/```(\w*)[^\S\n]*\n?([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
    fences.push({ lang, code });
    return ` F${fences.length - 1} `;
  });

  // LaTeX math → placeholders (NUL-delimited like the fences; esc() leaves
  // them untouched). $$…$$ and \[…\] are display math; \(…\) and heuristic
  // single-$ are inline.
  const maths = [];
  const mathToken = (tex, display) => {
    maths.push({ tex, display });
    return ` M${maths.length - 1} `;
  };
  text = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => mathToken(tex.trim(), true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => mathToken(tex.trim(), true))
    .replace(/\\\((.+?)\\\)/g, (m, tex) => mathToken(tex.trim(), false))
    .replace(/\$([^$\n]+?)\$(?!\d)/g, (m, tex) => {
      // Avoid prices ("$5 and $10"): require tight delimiters plus either math
      // syntax or a single spaceless expression.
      if (/^\s|\s$/.test(tex)) return m;
      if (/\s/.test(tex) && !/[\\^_={}]/.test(tex)) return m;
      return mathToken(tex, false);
    });

  text = esc(text);

  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join('<br>'))}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^ F(\d+) \s*$/);

    if (fence) {
      flushPara();
      const { lang, code } = fences[Number(fence[1])];
      if (lang.toLowerCase() === 'mermaid') {
        // enhanceRendered() swaps this for the rendered diagram once mermaid
        // parses it (partial streams stay visible as code).
        out.push(`<pre class="mermaid-src"><div class="code-head"><span>mermaid</span><button class="code-copy">Copy</button></div><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
      } else {
        out.push(
          `<pre><div class="code-head"><span>${esc(lang) || 'code'}</span><button class="code-copy">Copy</button></div><code>${esc(code.replace(/\n$/, ''))}</code></pre>`
        );
      }
      i++;
    } else if (/^#{1,4}\s/.test(line)) {
      flushPara();
      const m = line.match(/^(#{1,4})\s+(.*)/);
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      i++;
    } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushPara();
      out.push('<hr>');
      i++;
    } else if (/^\s*&gt;\s?/.test(line)) {
      flushPara();
      const quote = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*&gt;\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(quote.join('\n').replace(/ F(\d+) /g, (m, n) => `\`${esc(fences[Number(n)].code.slice(0, 80))}\``))}</blockquote>`);
    } else if (line.includes('|') && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || '') && (lines[i + 1] || '').includes('-')) {
      flushPara();
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      let t = `<table><thead><tr>${header.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>`;
      for (const r of rows) t += `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`;
      out.push(t + '</tbody></table>');
    } else if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushPara();
      const [html, next] = parseList(lines, i, indentOf(line));
      out.push(html);
      i = next;
    } else if (!line.trim()) {
      flushPara();
      i++;
    } else {
      para.push(line);
      i++;
    }
  }
  flushPara();
  return out.join('\n');

  function indentOf(l) {
    return (l.match(/^(\s*)/)[1] || '').length;
  }

  function parseList(lines, start, baseIndent) {
    const ordered = /^\s*\d+\./.test(lines[start]);
    let html = ordered ? '<ol>' : '<ul>';
    let i = start;
    while (i < lines.length) {
      const l = lines[i];
      const m = l.match(/^(\s*)([-*+]|\d+\.)\s+(.*)/);
      if (!m) break;
      const ind = m[1].length;
      if (ind < baseIndent) break;
      if (ind > baseIndent) {
        const [sub, next] = parseList(lines, i, ind);
        html = html.replace(/<\/li>$/, sub + '</li>');
        i = next;
        continue;
      }
      html += `<li>${inline(m[3])}</li>`;
      i++;
    }
    return [html + (ordered ? '</ol>' : '</ul>'), i];
  }

  function splitRow(row) {
    return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  }

  function inline(t) {
    const codes = [];
    t = t.replace(/`([^`]+)`/g, (m, c) => {
      codes.push(c);
      return ` C${codes.length - 1} `;
    });
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) => {
      // Bare paths resolve to this run's workspace artifacts (charts, figures).
      const url = /^https?:\/\//.test(src) ? src : ctx.runId ? artifactHref(ctx.runId, src) : null;
      return url ? `<img class="md-img" src="${url}" alt="${alt}" loading="lazy">` : m;
    });
    t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/ M(\d+) /g, (m, n) => {
      const { tex, display } = maths[Number(n)];
      return `<span class="math${display ? ' math-block' : ''}" data-display="${display ? 1 : 0}">${esc(tex)}</span>`;
    });
    t = t.replace(/ C(\d+) /g, (m, n) => `<code>${codes[Number(n)]}</code>`);
    t = t.replace(/ F(\d+) /g, (m, n) => `<code>${esc(fences[Number(n)].code.slice(0, 120))}</code>`);
    return t;
  }
}

// copy buttons (event delegation)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.code-copy');
  if (!btn) return;
  const code = btn.closest('pre')?.querySelector('code')?.textContent || '';
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = 'Copy'), 1500);
  });
});

function artifactHref(runId, p) {
  return `/api/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(p).replace(/%2F/gi, '/')}`;
}

// ------------------------------------------------- KaTeX + Mermaid post-pass

// Upgrade freshly-rendered markdown in place: math spans become KaTeX, mermaid
// code blocks become diagrams. Idempotent and safe when the CDN libs are absent.
function enhanceRendered(root = chatEl) {
  if (!root) return;
  if (window.katex) {
    for (const el of root.querySelectorAll('.math:not(.math-done)')) {
      el.classList.add('math-done');
      try {
        el.innerHTML = katex.renderToString(el.textContent, { displayMode: el.dataset.display === '1', throwOnError: false });
      } catch {}
    }
  }
  if (window.mermaid) renderMermaidBlocks(root);
}

const mermaidCache = new Map(); // code → svg | null (null = failed parse)
let mermaidSeq = 0;
let mermaidReady = false;

async function renderMermaidBlocks(root) {
  const blocks = root.querySelectorAll('pre.mermaid-src:not(.mm-tried)');
  if (!blocks.length) return;
  if (!mermaidReady) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'neutral',
    });
    mermaid.parseError = () => {}; // partial streams fail parse constantly — stay quiet
    mermaidReady = true;
  }
  for (const pre of blocks) {
    pre.classList.add('mm-tried');
    const code = pre.querySelector('code')?.textContent?.trim();
    if (!code) continue;
    let svg = mermaidCache.get(code);
    if (svg === undefined) {
      const id = `mm_${++mermaidSeq}`;
      try {
        ({ svg } = await mermaid.render(id, code));
      } catch {
        svg = null;
        document.getElementById(id)?.remove(); // mermaid can leave its temp node behind
      }
      mermaidCache.set(code, svg);
    }
    if (svg && pre.isConnected) {
      const div = document.createElement('div');
      div.className = 'mermaid-diagram';
      div.innerHTML = svg;
      pre.replaceWith(div);
    }
  }
}

// ---------------------------------------------------------------- icons

const ICON = {
  check: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="var(--green)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  cross: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--red)" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  warn: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="var(--amber)" stroke-width="2.2" stroke-linecap="round"><path d="M12 7v6M12 17h.01"/><circle cx="12" cy="12" r="9.2"/></svg>`,
  circle: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="var(--text-faint)" stroke-width="2"><circle cx="12" cy="12" r="8.5"/></svg>`,
  skip: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--text-faint)" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M6 18 18 6"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>`,
  chevron: `<svg class="run-chevron" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
  file: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`,
};

function statusIcon(status) {
  switch (status) {
    case 'running':
    case 'retry':
      return `<span class="status-icon"><span class="spinner"></span></span>`;
    case 'verifying':
      return `<span class="status-icon"><span class="spinner violet"></span></span>`;
    case 'done':
      return `<span class="status-icon">${ICON.check}</span>`;
    case 'warn':
      return `<span class="status-icon">${ICON.warn}</span>`;
    case 'failed':
      return `<span class="status-icon">${ICON.cross}</span>`;
    case 'skipped':
    case 'dropped':
      return `<span class="status-icon">${ICON.skip}</span>`;
    default:
      return `<span class="status-icon">${ICON.circle}</span>`;
  }
}

const STATUS_LABEL = {
  pending: 'Pending',
  running: 'Running',
  verifying: 'Verifying deliverables',
  retry: 'Retrying with feedback',
  done: 'Done',
  warn: 'Done with warnings',
  failed: 'Failed',
  skipped: 'Skipped (upstream failed)',
  dropped: 'Dropped during replanning',
};

const TOOL_LABEL = { web_search: 'Searched the web', fetch_url: 'Fetched', run_code: 'Ran', pip_install: 'Installed', write_file: 'Wrote', read_file: 'Read', list_files: 'Listed files' };

// ---------------------------------------------------------------- DAG

const DAG = { W: 208, H: 92, GX: 56, GY: 18 };

function layoutDag(nodes) {
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const level = {};
  const compute = (id) => {
    if (level[id] != null) return level[id];
    const deps = byId[id]?.depends_on || [];
    level[id] = deps.length ? Math.max(...deps.map(compute)) + 1 : 0;
    return level[id];
  };
  nodes.forEach((n) => compute(n.id));

  const cols = [];
  nodes.forEach((n) => (cols[level[n.id]] ||= []).push(n));
  const maxRows = Math.max(...cols.map((c) => c.length));
  const height = maxRows * DAG.H + (maxRows - 1) * DAG.GY;
  const pos = {};
  cols.forEach((col, ci) => {
    const colH = col.length * DAG.H + (col.length - 1) * DAG.GY;
    col.forEach((n, ri) => {
      pos[n.id] = { x: ci * (DAG.W + DAG.GX), y: (height - colH) / 2 + ri * (DAG.H + DAG.GY) };
    });
  });
  return { pos, width: cols.length * (DAG.W + DAG.GX) - DAG.GX, height };
}

function renderDag(run, ui) {
  const nodes = run.plan.nodes;
  const { pos, width, height } = layoutDag(nodes);

  let edges = '';
  for (const n of nodes) {
    for (const d of n.depends_on) {
      const a = pos[d];
      const b = pos[n.id];
      if (!a || !b) continue;
      const x1 = a.x + DAG.W;
      const y1 = a.y + DAG.H / 2;
      const x2 = b.x;
      const y2 = b.y + DAG.H / 2;
      const mx = (x1 + x2) / 2;
      const st = run.nodes[n.id]?.status;
      const active = st === 'running' || st === 'verifying' || st === 'retry';
      edges += `<path class="${active ? 'active' : ''}" d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}"/>`;
    }
  }

  const reviewing = run.phase === 'awaiting_approval';
  let cards = '';
  for (const n of nodes) {
    const st = run.nodes[n.id] || { status: 'pending' };
    const p = pos[n.id];
    const edit = reviewing ? ui.edits[n.id] || {} : {};
    const model = edit.model || n.model;
    const reasoning = edit.reasoning || n.reasoning;
    const tools = edit.tools || n.tools || [];
    const effort = reasoning && reasoning !== 'none' ? `<span class="effort-chip">${esc(reasoning)}</span>` : '';
    const toolChips = tools.map((t) => `<span class="tool-chip">${esc(t)}</span>`).join('');
    const calls = (st.toolLog || []).filter((e) => e.callId).length;
    const activity = calls ? `<span class="tool-count" title="${calls} tool calls">⚙${calls}</span>` : '';
    const cost = st.cost ? `<span class="node-cost">${fmtCost(st.cost)}</span>` : '';
    cards += `<div class="dag-node ${esc(st.status)} ${ui.selected === n.id ? 'selected' : ''} ${edit.deleted ? 'edit-deleted' : ''}" data-node="${esc(n.id)}" style="left:${p.x}px;top:${p.y}px;height:${DAG.H}px" title="${esc(edit.deleted ? 'Removed in review' : STATUS_LABEL[st.status] || st.status)}">
      <div class="node-top"><div class="node-title">${esc(n.title)}</div><span class="node-status">${statusIcon(st.status)}</span></div>
      <div class="node-meta"><span class="model-chip">${esc(modelShort(model))}</span>${effort}${toolChips}${activity}${cost}</div>
    </div>`;
  }

  return `<div class="dag-wrap"><div class="dag" style="width:${width}px;height:${height}px">
    <svg class="edges" width="${width}" height="${height}">${edges}</svg>${cards}
  </div></div>`;
}

// ---------------------------------------------------------------- run card

function runHeader(run) {
  const n = run.plan?.nodes?.length || 0;
  const doneCount = run.plan ? run.plan.nodes.filter((x) => ['done', 'warn'].includes(run.nodes[x.id]?.status)).length : 0;
  const running = !['done', 'error', 'stopped'].includes(run.phase);
  const elapsed = fmtDuration((run.endedAt || Date.now()) - run.startedAt);

  let title, sub = '';
  switch (run.phase) {
    case 'planning':
      title = 'Planning the run';
      sub = modelShort(state.settings?.orchestratorModel || '');
      break;
    case 'awaiting_approval':
      title = 'Plan ready — review it';
      sub = `${n} agent${n === 1 ? '' : 's'} proposed`;
      break;
    case 'running':
      title = 'Running agents';
      sub = `${doneCount} of ${n} done`;
      break;
    case 'synthesis':
      title = 'Synthesizing final answer';
      break;
    case 'error':
      title = 'Run failed';
      break;
    case 'stopped':
      title = 'Run stopped';
      break;
    default:
      title = `Orchestrated ${n} agent${n === 1 ? '' : 's'}`;
      sub = elapsed;
  }

  const spark = running ? '<span class="spark spin">✦</span>' : '<span class="spark">✦</span>';
  const stop = running && state.live?.id === run.id ? `<button class="run-stop" data-stop="${esc(run.id)}">Stop</button>` : '';
  const cost = `<span class="run-cost">${running ? elapsed + ' · ' : ''}${fmtCost(run.totals?.cost)} · ${fmtTokens((run.totals?.tokensIn || 0) + (run.totals?.tokensOut || 0))} tok</span>`;
  return `<div class="run-head" data-toggle="${esc(run.id)}">${spark}<span class="run-title">${title}<span class="sub">${esc(sub)}</span></span>${stop}${cost}${ICON.chevron}</div>`;
}

function renderRunCard(run) {
  const ui = uiFor(run.id);
  let body = '';

  if (!run.plan) {
    const terminal = ['done', 'error', 'stopped'].includes(run.phase);
    body =
      (terminal ? '' : `<div class="planning-shimmer"><span class="shimmer-dot"></span>Reading the task, sizing the graph, choosing the fleet…</div>`) +
      renderRunWarnings(run) +
      orchStreamHtml(run);
  } else {
    const strategy = run.plan.strategy
      ? `<div class="run-strategy"><b>Strategy:</b> ${esc(run.plan.strategy)}</div>`
      : '';
    body =
      strategy +
      renderApprovalBar(run) +
      renderAdaptNotes(run) +
      renderRunWarnings(run) +
      (run.adaptingNode ? orchStreamHtml(run) : '') +
      renderDag(run, ui) +
      renderNodeDetail(run, ui) +
      renderArtifacts(run) +
      renderOrchLog(run, ui) +
      runFooter(run);
  }
  if (run.error) body += `<div class="run-error">${esc(run.error)}</div>`;

  return `<div class="run-card ${ui.collapsed ? 'collapsed' : ''}" data-run="${esc(run.id)}">${runHeader(run)}<div class="run-body">${body}</div></div>`;
}

// The orchestrator's own live output: its reasoning plus the JSON it is
// currently writing (plan or replan patch). Shown while planning/adapting.
function orchStreamHtml(run) {
  const ps = run.planStream;
  if (!ps || (!ps.thinking && !ps.json)) return '';
  const think = ps.thinking ? `<div class="orch-think">${esc(ps.thinking)}</div>` : '';
  const json = ps.json ? `<pre class="orch-json">${esc(ps.json)}</pre>` : '';
  return `<div class="orch-stream">${think}${json}</div>`;
}

// After planning, the full orchestrator output stays available, collapsed.
function renderOrchLog(run, ui) {
  if (run.adaptingNode) return '';
  const log = run.planLog || (run.planStream?.thinking || run.planStream?.json ? run.planStream : null);
  if (!log || (!log.thinking && !log.json)) return '';
  return `<details class="orch-log" ${ui.orchOpen ? 'open' : ''}>
    <summary>Orchestrator output — how this plan was made</summary>
    ${log.thinking ? `<div class="orch-think">${esc(log.thinking)}</div>` : ''}
    ${log.json ? `<pre class="orch-json">${esc(log.json)}</pre>` : ''}
  </details>`;
}

function renderApprovalBar(run) {
  if (run.phase !== 'awaiting_approval') return '';
  const ui = uiFor(run.id);
  const removed = Object.values(ui.edits).filter((e) => e?.deleted).length;
  const launching = run.plan.nodes.length - removed;
  return `<div class="approve-bar">
    <div class="approve-text"><b>Review the plan</b><span>Click a node to reroute its model, adjust tools, edit the brief, or remove it.</span></div>
    <label class="auto-approve"><input type="checkbox" data-auto-approve /> Skip review from now on</label>
    <button class="btn" data-plan-cancel="${esc(run.id)}">Cancel</button>
    <button class="btn primary" data-plan-approve="${esc(run.id)}" ${launching < 1 ? 'disabled' : ''}>Launch ${launching} agent${launching === 1 ? '' : 's'}</button>
  </div>`;
}

function renderAdaptNotes(run) {
  let html = (run.adaptations || [])
    .map((r) => `<div class="adapt-note"><span class="adapt-mark">✦</span>Plan adapted: ${esc(r)}</div>`)
    .join('');
  if (run.adaptingNode) {
    html += `<div class="adapt-note live"><span class="spinner"></span>"${esc(
      run.plan?.nodes?.find((n) => n.id === run.adaptingNode)?.title || run.adaptingNode
    )}" failed — the orchestrator is revising the graph…</div>`;
  }
  return html;
}

function renderRunWarnings(run) {
  const notes = [];
  if (run.streamInterrupted) notes.push(run.streamInterrupted);
  if (run.stopMessage && run.phase === 'stopped' && !notes.includes(run.stopMessage)) notes.push(run.stopMessage);
  return notes
    .map((note) => `<div class="adapt-note live">${ICON.warn}<span>${esc(note)}</span></div>`)
    .join('');
}

const IMG_ARTIFACT = /\.(png|jpe?g|gif|webp|svg)$/i;

function renderArtifacts(run) {
  if (!run.artifacts?.length) return '';
  const files = run.artifacts
    .map((f) => {
      const href = artifactHref(run.id, f.path);
      return `<a class="artifact" href="${href}" target="_blank" rel="noopener">${ICON.file}<span class="artifact-name">${esc(f.path)}</span><span class="artifact-size">${fmtSize(f.size)}</span></a>`;
    })
    .join('');
  // Charts and figures get an inline preview gallery above the download chips.
  const images = run.artifacts.filter((f) => IMG_ARTIFACT.test(f.path));
  const gallery = images.length
    ? `<div class="artifact-gallery">${images
        .map((f) => {
          const href = artifactHref(run.id, f.path);
          return `<a class="artifact-img" href="${href}" target="_blank" rel="noopener" title="${esc(f.path)}"><img src="${href}" alt="${esc(f.path)}" loading="lazy"></a>`;
        })
        .join('')}</div>`
    : '';
  // HTML artifacts are live, playable apps — embed them in a sandboxed iframe
  // once the run is finished (mid-run re-renders would keep resetting them).
  const finished = ['done', 'error', 'stopped'].includes(run.phase);
  const apps = finished
    ? run.artifacts
        .filter((f) => /\.html?$/i.test(f.path))
        .map((f) => {
          const href = artifactHref(run.id, f.path);
          return `<div class="artifact-app">
            <div class="app-bar">${ICON.file}<span class="artifact-name">${esc(f.path)}</span>
              <button class="btn app-btn" data-fs title="Play fullscreen">⛶ Fullscreen</button>
              <a class="btn app-btn" href="${href}" target="_blank" rel="noopener">Open in tab</a>
            </div>
            <iframe class="app-frame" src="${href}" sandbox="allow-scripts allow-pointer-lock" allowfullscreen loading="lazy" title="${esc(f.path)}"></iframe>
          </div>`;
        })
        .join('')
    : '';
  return `<div class="artifacts"><div class="artifacts-label">Files created in this run</div>${gallery}${apps}<div class="artifact-list">${files}</div></div>`;
}

function runFooter(run) {
  const t = run.totals || {};
  // Routing savings: what the same calls would have cost on the frontier
  // orchestrator model alone. Only shown when the delta is meaningful.
  let saved = '';
  if (t.baselineCost && t.baselineCost > (t.cost || 0) * 1.05) {
    const delta = t.baselineCost - (t.cost || 0);
    const pct = Math.round((delta / t.baselineCost) * 100);
    const base = modelShort(t.baselineModel) || 'frontier model';
    saved = `<span class="run-save" title="Estimate: these ${t.calls || 0} calls (${fmtTokens((t.tokensIn || 0))} in / ${fmtTokens(t.tokensOut || 0)} out tokens) priced at ${esc(base)} rates would cost ${fmtCost(t.baselineCost)}. Smart routing across the fleet cost ${fmtCost(t.cost)}.">saved ${fmtCost(delta)} (${pct}%) vs ${esc(base)}-only</span>`;
  }
  return `<div class="run-foot">
    <span>${t.calls || 0} model calls</span>
    <span>in ${fmtTokens(t.tokensIn)} tok</span>
    <span>out ${fmtTokens(t.tokensOut)} tok</span>
    <span>total ${fmtCost(t.cost)}</span>
    ${saved}
  </div>`;
}

function renderNodeDetail(run, ui) {
  if (!ui.selected) return '';
  const node = run.plan.nodes.find((n) => n.id === ui.selected);
  const st = run.nodes[ui.selected];
  if (!node || !st) return '';

  if (run.phase === 'awaiting_approval') return renderNodeEditor(run, ui, node);

  const tabNames = ['output'];
  if ((st.toolLog || []).length || (node.tools || []).length) tabNames.push('activity');
  tabNames.push('brief', 'verification');
  if (!tabNames.includes(ui.tab)) ui.tab = 'output';

  const tabs = tabNames
    .map((t) => `<button class="detail-tab ${ui.tab === t ? 'active' : ''}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`)
    .join('');

  let body = '';
  if (ui.tab === 'activity') {
    body = renderActivity(run, ui, st);
  } else if (ui.tab === 'output') {
    body = st.output
      ? `<div class="md">${renderMarkdown(st.output, { runId: run.id })}</div>`
      : `<span style="color:var(--text-faint)">No output yet.</span>`;
    if (st.error) body += `<div class="run-error" style="margin:10px 0 0">${esc(st.error)}</div>`;
  } else if (ui.tab === 'brief') {
    body = `
      <div class="brief-label">Objective</div><div>${esc(node.objective)}</div>
      <div class="brief-label">Instructions</div><div style="white-space:pre-wrap">${esc(node.instructions)}</div>
      <div class="brief-label">Required deliverables</div>
      <ol class="deliv-list">${node.deliverables.map((d) => `<li>${esc(d)}</li>`).join('')}</ol>`;
  } else {
    if (node.verification === 'none') {
      body = `<span style="color:var(--text-faint)">Verification waived by the orchestrator for this node.</span>`;
    } else if (!st.verify) {
      body = `<span style="color:var(--text-faint)">Not verified yet.</span>
        <div class="brief-label" style="margin-top:12px">Rubric</div><div>${esc(node.verification)}</div>`;
    } else {
      const v = st.verify;
      body = `<div class="verdict ${v.pass ? 'pass' : 'fail'}">
          ${v.pass ? ICON.check : ICON.warn}
          <div><b>${v.pass ? 'Deliverables verified' : 'Verifier rejected'}${v.score != null ? ` · ${v.score}/10` : ''}</b>
          <div class="verdict-feedback">${esc(v.feedback)}</div></div>
        </div>
        <div class="brief-label" style="margin-top:12px">Rubric</div><div>${esc(node.verification)}</div>`;
    }
  }

  const toolCalls = (st.toolLog || []).filter((e) => e.callId).length;
  const stats = `<div class="detail-stats">
    <span>${esc(STATUS_LABEL[st.status] || st.status)}</span>
    ${st.attempt > 1 ? `<span>attempt ${st.attempt}</span>` : ''}
    ${toolCalls ? `<span>${toolCalls} tool calls</span>` : ''}
    ${st.cost ? `<span>${fmtCost(st.cost)}</span>` : ''}
    ${st.tokensIn ? `<span>in ${fmtTokens(st.tokensIn)} / out ${fmtTokens(st.tokensOut)} tok</span>` : ''}
    ${st.ms ? `<span>${fmtDuration(st.ms)}</span>` : ''}
  </div>`;

  return `<div class="node-detail">
    <div class="detail-head"><span class="detail-title">${esc(node.title)}</span><span class="model-chip">${esc(modelShort(node.model))}</span></div>
    <div class="detail-tabs">${tabs}</div>
    <div class="detail-body">${body}${stats}</div>
  </div>`;
}

// The live tool transcript of a node: agent notes, tool calls with results,
// and the verifier's checks (badged).
function renderActivity(run, ui, st) {
  const entries = st.toolLog || [];
  if (!entries.length) {
    return `<span style="color:var(--text-faint)">No tool activity yet — this agent has web/code tools and will log every call here.</span>`;
  }
  return entries
    .map((e, i) => {
      if (e.note) {
        return `<div class="tl-note">${esc(e.note)}</div>`;
      }
      const cls = e.status === 'error' ? 'error' : e.status === 'running' ? 'running' : 'ok';
      const badge = e.by === 'verifier' ? `<span class="tl-badge">verifier</span>` : '';
      const key = e.callId || `i${i}`;
      const open = ui.openTools.has(key) ? 'open' : '';
      const status = e.status === 'running' ? `<span class="spinner"></span>` : e.status === 'error' ? ICON.cross : ICON.check;
      return `<details class="tl-entry ${cls}" data-tl="${esc(key)}" ${open}>
        <summary><span class="tl-status">${status}</span><b>${esc(TOOL_LABEL[e.name] || e.name)}</b><span class="tl-sum">${esc(e.summary || '')}</span>${badge}${e.ms ? `<span class="tl-ms">${fmtDuration(e.ms)}</span>` : ''}</summary>
        <pre class="tl-result">${esc(e.result || '…')}</pre>
      </details>`;
    })
    .join('');
}

// Plan-review editor: shown instead of the tabs while the run awaits approval.
function renderNodeEditor(run, ui, node) {
  const e = ui.edits[node.id] || {};
  const model = e.model || node.model;
  const reasoning = e.reasoning || node.reasoning;
  const tools = e.tools || node.tools || [];
  const instructions = e.instructions ?? node.instructions;

  if (e.deleted) {
    return `<div class="node-detail editor">
      <div class="detail-head"><span class="detail-title">${esc(node.title)}</span><span class="removed-chip">removed</span></div>
      <div class="detail-body">
        <p style="color:var(--text-secondary)">This node will not run. Its dependents will connect to its upstream nodes instead.</p>
        <button class="btn" data-ed-restore>Restore node</button>
      </div>
    </div>`;
  }

  const modelOpts = state.models
    .filter((m) => m.available !== false)
    .map((m) => `<option value="${esc(m.id)}" ${m.id === model ? 'selected' : ''}>${esc(m.name)} — $${m.priceIn}/$${m.priceOut}${m.freeVariant ? ' · FREE' : ''}</option>`)
    .join('');
  const reasonOpts = ['none', 'low', 'medium', 'high']
    .map((r) => `<option value="${r}" ${r === reasoning ? 'selected' : ''}>${r}</option>`)
    .join('');

  return `<div class="node-detail editor">
    <div class="detail-head"><span class="detail-title">${esc(node.title)}</span><span class="model-chip">${esc(modelShort(model))}</span></div>
    <div class="detail-body">
      <div class="ed-row">
        <label class="ed-field">Model<select data-ed="model">${modelOpts}</select></label>
        <label class="ed-field ed-narrow">Reasoning<select data-ed="reasoning">${reasonOpts}</select></label>
        <div class="ed-field ed-narrow">Tools
          <div class="ed-tools">
            <label><input type="checkbox" data-ed-tool="web" ${tools.includes('web') ? 'checked' : ''}/>web</label>
            <label><input type="checkbox" data-ed-tool="code" ${tools.includes('code') ? 'checked' : ''}/>code</label>
          </div>
        </div>
      </div>
      <label class="ed-field">Instructions to the agent<textarea data-ed="instructions" rows="5">${esc(instructions)}</textarea></label>
      <div class="brief-label">Deliverables</div>
      <ol class="deliv-list">${node.deliverables.map((d) => `<li>${esc(d)}</li>`).join('')}</ol>
      <div class="ed-actions"><button class="btn danger" data-ed-delete>Remove this node</button></div>
    </div>
  </div>`;
}

// run-card interactions (delegated)
document.addEventListener('click', (e) => {
  const fsBtn = e.target.closest('[data-fs]');
  if (fsBtn) {
    fsBtn.closest('.artifact-app')?.querySelector('.app-frame')?.requestFullscreen?.();
    e.stopPropagation();
    return;
  }
  const stopBtn = e.target.closest('[data-stop]');
  if (stopBtn) {
    if (state.streamAbort) {
      state.streamAbort.abort();
      finishLiveRun({ ...state.live, status: 'stopped', endedAt: Date.now(), answer: state.live?.answer || '*Run stopped.*' });
    } else {
      api(`/api/runs/${stopBtn.dataset.stop}/stop`, { method: 'POST' }).catch(() => {});
    }
    e.stopPropagation();
    return;
  }
  const approveBtn = e.target.closest('[data-plan-approve]');
  if (approveBtn) {
    const runId = approveBtn.dataset.planApprove;
    const ui = uiFor(runId);
    const auto = approveBtn.closest('.approve-bar')?.querySelector('[data-auto-approve]')?.checked;
    approveBtn.disabled = true;
    approveBtn.textContent = 'Launching…';
    api(`/api/runs/${runId}/plan`, { method: 'POST', body: { action: 'approve', edits: ui.edits } })
      .then(() => {
        if (!auto) return;
        return api('/api/settings', { method: 'POST', body: { approvePlans: false } }).then((r) => {
          state.settings = r.settings;
        });
      })
      .catch((err) => {
        toast(err.message);
        rerenderCard(runId);
      });
    return;
  }
  const cancelBtn = e.target.closest('[data-plan-cancel]');
  if (cancelBtn) {
    api(`/api/runs/${cancelBtn.dataset.planCancel}/plan`, { method: 'POST', body: { action: 'cancel' } }).catch(() => {});
    return;
  }
  const edDelete = e.target.closest('[data-ed-delete]');
  const edRestore = e.target.closest('[data-ed-restore]');
  if (edDelete || edRestore) {
    const card = (edDelete || edRestore).closest('.run-card');
    const ui = uiFor(card.dataset.run);
    if (ui.selected) {
      (ui.edits[ui.selected] ||= {}).deleted = Boolean(edDelete);
      rerenderCard(card.dataset.run);
    }
    return;
  }
  if (e.target.closest('.auto-approve') || e.target.closest('.ed-field') || e.target.closest('.ed-tools')) {
    return; // form interactions inside the card shouldn't toggle/select anything
  }
  const head = e.target.closest('[data-toggle]');
  if (head) {
    const ui = uiFor(head.dataset.toggle);
    ui.collapsed = !ui.collapsed;
    head.closest('.run-card').classList.toggle('collapsed', ui.collapsed);
    return;
  }
  const nodeEl = e.target.closest('.dag-node');
  if (nodeEl) {
    const card = nodeEl.closest('.run-card');
    const ui = uiFor(card.dataset.run);
    ui.selected = ui.selected === nodeEl.dataset.node ? null : nodeEl.dataset.node;
    rerenderCard(card.dataset.run);
    return;
  }
  const tab = e.target.closest('.detail-tab');
  if (tab) {
    const card = tab.closest('.run-card');
    uiFor(card.dataset.run).tab = tab.dataset.tab;
    rerenderCard(card.dataset.run);
  }
});

// plan-review editor inputs (delegated)
document.addEventListener('change', (e) => {
  const card = e.target.closest('.run-card');
  if (!card) return;
  const ui = uiFor(card.dataset.run);
  if (!ui.selected) return;
  if (e.target.matches('select[data-ed]')) {
    (ui.edits[ui.selected] ||= {})[e.target.dataset.ed] = e.target.value;
    rerenderCard(card.dataset.run);
  } else if (e.target.matches('[data-ed-tool]')) {
    const ed = (ui.edits[ui.selected] ||= {});
    const run = findRunState(card.dataset.run);
    const node = run?.plan?.nodes?.find((n) => n.id === ui.selected);
    const current = new Set(ed.tools || node?.tools || []);
    if (e.target.checked) current.add(e.target.dataset.edTool);
    else current.delete(e.target.dataset.edTool);
    ed.tools = [...current];
    rerenderCard(card.dataset.run);
  }
});

document.addEventListener('input', (e) => {
  if (!e.target.matches?.('textarea[data-ed]')) return;
  const card = e.target.closest('.run-card');
  if (!card) return;
  const ui = uiFor(card.dataset.run);
  if (ui.selected) (ui.edits[ui.selected] ||= {})[e.target.dataset.ed] = e.target.value;
});

// keep tool-log <details> open across live re-renders ('toggle' doesn't bubble)
document.addEventListener(
  'toggle',
  (e) => {
    const det = e.target;
    const card = det.closest?.('.run-card');
    if (!card) return;
    const ui = uiFor(card.dataset.run);
    if (det.matches?.('.orch-log')) {
      ui.orchOpen = det.open;
      return;
    }
    if (!det.matches?.('.tl-entry')) return;
    if (det.open) ui.openTools.add(det.dataset.tl);
    else ui.openTools.delete(det.dataset.tl);
  },
  true
);

function findRunState(runId) {
  if (state.live?.id === runId) return state.live;
  for (const m of state.messages) {
    if (m.run?.id === runId) return normalizeSnapshot(m.run);
  }
  return null;
}

function rerenderCard(runId) {
  const run = findRunState(runId);
  const el = document.querySelector(`.run-card[data-run="${CSS.escape(runId)}"]`);
  if (run && el) {
    el.outerHTML = renderRunCard(run);
    enhanceRendered(document.querySelector(`.run-card[data-run="${CSS.escape(runId)}"]`));
  }
}

// stored snapshots have phase implied by status
function normalizeSnapshot(snap) {
  return { ...snap, phase: snap.status === 'done' ? 'done' : snap.status, totals: snap.totals || {} };
}

// ---------------------------------------------------------------- chat rendering

function renderChat() {
  mainEl.classList.toggle('empty', !state.messages.length && !state.live);
  let html = '';
  for (const m of state.messages) {
    if (m.role === 'user') {
      const files = m.attachments?.length
        ? `<div class="msg-attachments">${m.attachments.map((a) => `<span class="file-chip">${ICON.file}${esc(a.name)}</span>`).join('')}</div>`
        : '';
      html += `<div class="msg msg-user"><div><div class="bubble">${esc(m.content)}</div>${files}</div></div>`;
    } else {
      // Runs loaded from disk start collapsed; runs finished live stay open.
      if (m.run && !cardUi.has(m.run.id)) cardUi.set(m.run.id, { collapsed: true, selected: null, tab: 'output' });
      const card = m.run ? renderRunCard(normalizeSnapshot(m.run)) : '';
      html += `<div class="msg msg-assistant">${card}<div class="answer md">${renderMarkdown(m.content, { runId: m.run?.id })}</div></div>`;
    }
  }
  if (state.live) {
    html += `<div class="msg msg-assistant" id="liveMsg">${renderRunCard(state.live)}<div class="answer md" id="liveAnswer">${renderMarkdown(state.live.answer, { runId: state.live.id })}</div></div>`;
  }
  chatEl.innerHTML = html;
  enhanceRendered(chatEl);
}

let renderQueued = false;
function scheduleLiveRender() {
  if (renderQueued) return;
  renderQueued = true;
  // rAF never fires in hidden tabs — without the fallback, the first queued
  // render blocks all further ones and the UI freezes until the tab returns.
  const paint = document.hidden ? (fn) => setTimeout(fn, 120) : requestAnimationFrame;
  paint(() => {
    renderQueued = false;
    if (!state.live) return;
    const msg = document.getElementById('liveMsg');
    if (!msg) return renderChat();
    const nearBottom = isNearBottom();
    const card = msg.querySelector('.run-card');
    // While the plan-review editor is in use (open model dropdown, focused
    // textarea), replacing the card's DOM would instantly close/blur it.
    const editingPlan = state.live.phase === 'awaiting_approval' && card?.contains(document.activeElement);
    if (card && !editingPlan) card.outerHTML = renderRunCard(state.live);
    const ans = document.getElementById('liveAnswer');
    if (ans) ans.innerHTML = renderMarkdown(state.live.answer, { runId: state.live.id });
    enhanceRendered(msg);
    // keep a streaming node-output panel pinned to its bottom
    const detail = msg.querySelector('.detail-body');
    if (detail && ['running', 'retry'].includes(state.live.nodes[uiFor(state.live.id).selected]?.status)) {
      detail.scrollTop = detail.scrollHeight;
    }
    // same for the orchestrator's live planning stream
    const orch = msg.querySelector('.orch-stream');
    if (orch) orch.scrollTop = orch.scrollHeight;
    if (nearBottom) scrollToBottom();
  });
}

function isNearBottom() {
  const sc = $('#chatScroll');
  return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160;
}
function scrollToBottom() {
  const sc = $('#chatScroll');
  sc.scrollTop = sc.scrollHeight;
}

// ---------------------------------------------------------------- live run / events

function newLiveRun(runId) {
  return {
    id: runId,
    phase: 'planning',
    startedAt: Date.now(),
    endedAt: null,
    plan: null,
    nodes: {},
    totals: { cost: 0, tokensIn: 0, tokensOut: 0, calls: 0, baselineCost: 0, baselineModel: null },
    answer: '',
    artifacts: [],
    adaptations: [],
    adaptingNode: null,
    planStream: { thinking: '', json: '' },
    planLog: null,
    error: null,
  };
}

function newNodeState() {
  return { status: 'pending', attempt: 0, output: '', cost: 0, tokensIn: 0, tokensOut: 0, ms: 0, toolLog: [] };
}

function subscribe(runId) {
  state.es?.close();
  const es = new EventSource(`/api/events/${runId}`);
  state.es = es;

  es.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    handleEvent(ev);
  };
  es.onerror = () => {
    // EventSource reconnects automatically; if run finished, close for good.
    if (state.live && ['done', 'error', 'stopped'].includes(state.live.phase)) es.close();
  };

  startRunTimer();
}

function startRunTimer() {
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (!state.live || ['done', 'error', 'stopped'].includes(state.live.phase)) return clearInterval(state.timer);
    // The review gate is static — a ticking re-render would only fight the
    // user's dropdowns and edits.
    if (state.live.phase === 'awaiting_approval') return;
    scheduleLiveRender();
  }, 1000);
}

function handleEvent(ev) {
  const run = state.live;
  if (!run) return;
  const d = ev.data || {};
  switch (ev.type) {
    case 'phase':
      run.phase = d.phase;
      // Leaving the review gate: the (possibly edited) plan re-arrives via a
      // fresh 'plan' event — clear the local edit buffer.
      if (d.phase === 'running') uiFor(run.id).edits = {};
      break;
    case 'plan': {
      run.plan = d;
      const keep = new Set(d.nodes.map((n) => n.id));
      for (const id of Object.keys(run.nodes)) if (!keep.has(id)) delete run.nodes[id];
      for (const n of d.nodes) run.nodes[n.id] ||= newNodeState();
      const ui = uiFor(run.id);
      if (ui.selected && !keep.has(ui.selected)) ui.selected = null;
      break;
    }
    case 'plan_updated': {
      run.plan = d.plan;
      for (const n of d.plan.nodes) run.nodes[n.id] ||= newNodeState();
      if (d.reason) run.adaptations.push(d.reason);
      run.adaptingNode = null;
      break;
    }
    case 'adapting':
      run.adaptingNode = d.failed;
      run.planStream = { thinking: '', json: '' }; // fresh stream for the replan
      break;
    case 'plan_delta': {
      const ps = (run.planStream ||= { thinking: '', json: '' });
      ps[d.kind === 'thinking' ? 'thinking' : 'json'] += d.text;
      break;
    }
    case 'plan_stream_reset':
      run.planStream = { thinking: '', json: '' };
      break;
    case 'adapt_decision':
      if (d.reason) run.adaptations.push(d.reason);
      run.adaptingNode = null;
      break;
    case 'artifacts':
      run.artifacts = d.files || [];
      break;
    case 'tool_call': {
      const st = run.nodes[d.id];
      if (!st) break;
      (st.toolLog ||= []).push({ callId: d.callId, name: d.name, summary: d.summary, status: 'running', result: '', ms: 0, by: d.by });
      break;
    }
    case 'tool_result': {
      const st = run.nodes[d.id];
      const entry = st?.toolLog?.find((x) => x.callId === d.callId && x.status === 'running');
      if (entry) {
        entry.status = d.ok ? 'ok' : 'error';
        entry.result = d.result;
        entry.ms = d.ms;
      }
      break;
    }
    case 'node_note': {
      const st = run.nodes[d.id];
      if (st) (st.toolLog ||= []).push({ note: d.text, by: d.by });
      break;
    }
    case 'node_reset': {
      const st = run.nodes[d.id];
      if (st) st.output = '';
      break;
    }
    case 'node_status': {
      const st = run.nodes[d.id];
      if (!st) break;
      st.status = d.status;
      if (d.attempt) st.attempt = d.attempt;
      if (d.status === 'running' && d.attempt > 1) st.output = '';
      if (d.error) st.error = d.error;
      break;
    }
    case 'node_delta': {
      const st = run.nodes[d.id];
      if (st) st.output += d.text;
      break;
    }
    case 'node_result': {
      const st = run.nodes[d.id];
      if (!st) break;
      Object.assign(st, {
        status: d.status, cost: d.cost,
        tokensIn: d.tokensIn, tokensOut: d.tokensOut, ms: d.ms, attempt: d.attempt,
      });
      if (d.output != null) st.output = d.output;
      break;
    }
    case 'verify_result': {
      const st = run.nodes[d.id];
      if (st) st.verify = { pass: d.pass, score: d.score, feedback: d.feedback };
      break;
    }
    case 'usage':
      run.totals = d;
      break;
    case 'memory_updated':
      toast(`✦ Memory updated (${d.added ? `+${d.added}` : ''}${d.added && d.removed ? ', ' : ''}${d.removed ? `−${d.removed}` : ''})`);
      break;
    case 'answer_delta':
      run.answer += d.text;
      break;
    case 'answer_reset':
      run.answer = '';
      break;
    case 'answer_done':
      break;
    case 'error':
      if (d.status === 'stopped') {
        run.stopMessage = d.message;
        run.answer ||= `**Run stopped:** ${d.message}`;
      } else {
        run.error = d.message;
      }
      break;
    case 'done':
      finishLiveRun({
        ...run,
        ...d,
        status: d.status || run.phase || 'done',
        endedAt: d.endedAt || Date.now(),
        totals: d.totals || run.totals,
        artifacts: d.artifacts || run.artifacts,
        adaptations: d.adaptations || run.adaptations,
        plan: d.plan || run.plan,
        nodes: d.nodes || run.nodes,
        answer: d.answer ?? run.answer,
        stopMessage: d.stopMessage || run.stopMessage || null,
      });
      return;
  }
  scheduleLiveRender();
}

function finishLiveRun(snap) {
  state.es?.close();
  state.es = null;
  state.streamAbort = null;
  clearInterval(state.timer);
  // Freeze the live run into a stored message.
  state.messages.push({ role: 'assistant', content: snap.answer, run: snap });
  state.live = null;
  renderChat();
  scrollToBottom();
  setComposerBusy(false);
  refreshConvos();
}

async function refreshConvos() {
  try {
    const boot = await api('/api/bootstrap');
    state.convos = boot.conversations;
    renderSidebar();
  } catch {}
}

// ---------------------------------------------------------------- sending

async function send() {
  const text = inputEl.value.trim();
  if (!text || state.live) return;

  const attachmentIds = state.attachments.map((a) => a.id);
  const userMsg = { role: 'user', content: text, attachments: state.attachments.map((a) => ({ id: a.id, name: a.name })) };

  setComposerBusy(true);
  inputEl.value = '';
  autosize();
  state.attachments = [];
  renderAttachChips();

  try {
    if (state.settings?.hosted) {
      await sendStreamed(text, userMsg, attachmentIds);
      return;
    }

    const res = await api('/api/run', {
      method: 'POST',
      body: { conversationId: state.activeId, message: text, attachments: attachmentIds },
    });
    state.messages.push(userMsg);
    if (!state.activeId) {
      state.activeId = res.conversationId;
      state.convos.unshift({ id: res.conversationId, title: res.title, updatedAt: Date.now(), cost: 0 });
      renderSidebar();
    }
    localStorage.setItem('maestro-last-convo', state.activeId);
    state.live = newLiveRun(res.runId);
    renderChat();
    scrollToBottom();
    subscribe(res.runId);
  } catch (err) {
    setComposerBusy(false);
    inputEl.value = text;
    autosize();
    toast(err.message);
  }
}

async function sendStreamed(text, userMsg, attachmentIds) {
  const controller = new AbortController();
  state.streamAbort = controller;
  let metaSeen = false;

  try {
    const res = await fetch('/api/run-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: state.activeId, message: text, attachments: attachmentIds, settings: hostedRunSettings() }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error || `HTTP ${res.status}`);
    }

    await readSseStream(res, (ev) => {
      if (ev.type === 'meta') {
        const d = ev.data;
        metaSeen = true;
        state.messages.push(userMsg);
        if (!state.activeId) {
          state.activeId = d.conversationId;
          state.convos.unshift({ id: d.conversationId, title: d.title, updatedAt: Date.now(), cost: 0 });
          renderSidebar();
        }
        localStorage.setItem('maestro-last-convo', state.activeId);
        state.live = newLiveRun(d.runId);
        renderChat();
        scrollToBottom();
        startRunTimer();
        return;
      }
      handleEvent(ev);
    });

    await settleStreamClosure(STREAM_INTERRUPTED_MESSAGE);
  } catch (err) {
    if (controller.signal.aborted) return;
    if (metaSeen && state.live) {
      await settleStreamClosure(err.message || STREAM_INTERRUPTED_MESSAGE);
      return;
    }
    throw err;
  } finally {
    if (state.streamAbort === controller) state.streamAbort = null;
  }
}

async function settleStreamClosure(message) {
  const run = state.live;
  if (!run) return;

  if (run.phase === 'done') {
    finishLiveRun({ ...run, status: 'done', endedAt: Date.now() });
    return;
  }
  if (run.phase === 'error') {
    finishLiveRun({ ...run, status: 'error', endedAt: Date.now(), answer: run.answer || `**The run failed:** ${run.error || message}` });
    return;
  }
  if (run.phase === 'stopped') {
    finishLiveRun({ ...run, status: 'stopped', endedAt: Date.now(), answer: run.answer || '*Run stopped.*' });
    return;
  }

  const recovered = await recoverFinishedRun(run.id).catch(() => null);
  if (recovered) {
    finishLiveRun(recovered);
    return;
  }

  finishInterruptedStream(message || STREAM_INTERRUPTED_MESSAGE);
}

async function recoverFinishedRun(runId) {
  if (!state.activeId || !runId) return null;
  await delay(1200);
  const { conversation } = await api(`/api/conversation/${encodeURIComponent(state.activeId)}`);
  const saved = [...(conversation.messages || [])].reverse().find((m) => m.run?.id === runId);
  return saved?.run || null;
}

function finishInterruptedStream(message) {
  const run = state.live;
  if (!run) return;
  const note = message || STREAM_INTERRUPTED_MESSAGE;
  const answer = run.answer?.trim()
    ? `${run.answer.trim()}\n\n---\n**Stream interrupted:** ${note}`
    : `**Stream interrupted:** ${note}`;
  finishLiveRun({
    ...run,
    status: 'stopped',
    phase: 'stopped',
    endedAt: Date.now(),
    answer,
    stopMessage: note,
    streamInterrupted: note,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSseStream(res, onEvent) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Streaming is not supported by this browser.');
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, '\n');
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      parseSseEvent(raw, onEvent);
    }
  }
  parseSseEvent(buf, onEvent);
}

function parseSseEvent(raw, onEvent) {
  const data = raw
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return;
  try {
    onEvent(JSON.parse(data));
  } catch {}
}

function setComposerBusy(busy) {
  inputEl.disabled = busy;
  inputEl.placeholder = busy ? 'Maestro is orchestrating…' : 'Assign a task to the fleet…';
  updateSendBtn();
}

function updateSendBtn() {
  sendBtn.disabled = !inputEl.value.trim() || !!state.live || inputEl.disabled;
}

function autosize() {
  inputEl.style.height = 'auto';
  // Empty input keeps its natural one-row height — a stale scrollHeight
  // otherwise freezes the composer tall after sending a long message.
  if (inputEl.value) inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + 'px';
}

inputEl.addEventListener('input', () => {
  autosize();
  updateSendBtn();
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) send();
  }
});
sendBtn.addEventListener('click', send);

// ---------------------------------------------------------------- attachments

$('#attachBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    if (file.size > 20 * 1024 * 1024) {
      toast(`${file.name} is over the 20MB limit`);
      continue;
    }
    try {
      const dataBase64 = await fileToBase64(file);
      const meta = await api('/api/upload', {
        method: 'POST',
        body: { name: file.name, mime: file.type, dataBase64 },
      });
      state.attachments.push(meta);
      renderAttachChips();
    } catch (err) {
      toast(`Upload failed: ${err.message}`);
    }
  }
  e.target.value = '';
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function renderAttachChips() {
  $('#attachChips').innerHTML = state.attachments
    .map((a, i) => `<span class="file-chip">${ICON.file}${esc(a.name)}<button data-rm="${i}" title="Remove">✕</button></span>`)
    .join('');
}
$('#attachChips').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (rm) {
    state.attachments.splice(Number(rm.dataset.rm), 1);
    renderAttachChips();
  }
});

// ---------------------------------------------------------------- sidebar

function renderSidebar() {
  $('#convoList').innerHTML = state.convos
    .map(
      (c) => `<div class="convo-item ${c.id === state.activeId ? 'active' : ''}" data-convo="${esc(c.id)}">
        <span class="convo-title">${esc(c.title)}</span>
        ${c.cost ? `<span class="convo-cost">${fmtCost(c.cost)}</span>` : ''}
        <button class="convo-del" data-del="${esc(c.id)}" title="Delete">${ICON.trash}</button>
      </div>`
    )
    .join('');
  // Lifetime savings — the running proof of the routing thesis.
  const saved = state.convos.reduce((a, c) => a + (c.saved || 0), 0);
  const el = $('#sbSaved');
  if (el) {
    el.hidden = saved < 0.01;
    el.textContent = `✦ ${fmtCost(saved)} saved vs frontier-only`;
  }
}

$('#convoList').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (!confirm('Delete this chat?')) return;
    await api(`/api/conversation/${del.dataset.del}`, { method: 'DELETE' });
    state.convos = state.convos.filter((c) => c.id !== del.dataset.del);
    if (state.activeId === del.dataset.del) newChat();
    renderSidebar();
    return;
  }
  const item = e.target.closest('[data-convo]');
  if (item) openConversation(item.dataset.convo);
});

$('#newChatBtn').addEventListener('click', newChat);

function newChat() {
  if (state.live) return toast('A run is in progress — stop it first.');
  localStorage.removeItem('maestro-last-convo');
  state.activeId = null;
  state.messages = [];
  state.live = null;
  state.es?.close();
  renderSidebar();
  renderChat();
  inputEl.focus();
}

async function openConversation(id) {
  if (state.live) return toast('A run is in progress — stop it first.');
  try {
    const { conversation, activeRunId } = await api(`/api/conversation/${id}`);
    state.activeId = id;
    localStorage.setItem('maestro-last-convo', id);
    state.messages = conversation.messages;
    state.live = null;
    renderSidebar();
    if (activeRunId) {
      // A run is still executing server-side — reattach and replay its events.
      state.live = newLiveRun(activeRunId);
      renderChat();
      subscribe(activeRunId);
    } else {
      renderChat();
    }
    scrollToBottom();
  } catch (err) {
    toast(err.message);
  }
}

// ---------------------------------------------------------------- settings

$('#settingsBtn').addEventListener('click', openSettings);

async function openSettings() {
  // Settings can change server-side (another tab, API) — always show the
  // server's live truth, never this page's stale boot copy.
  try {
    const boot = await api('/api/bootstrap');
    state.settings = mergeHostedSettings(boot.settings);
    state.memories = boot.memories || [];
    if (boot.mockForced) state.settings.mock = true;
    applySettings();
  } catch {}
  const s = state.settings;
  const memCount = (state.memories || []).length;
  const frontier = state.models.filter((m) => m.reasoning || m.tier === 'frontier');
  const options = (list, sel) =>
    list.map((m) => `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)} — ${esc(m.id)}</option>`).join('');

  $('#modalRoot').innerHTML = `<div class="modal-backdrop" id="backdrop"><div class="modal">
    <form id="settingsForm">
    <h2>Settings</h2>
    <div class="field">
      <label>OpenRouter API key</label>
      <input type="password" id="setKey" placeholder="${s.hasApiKey ? `saved (${esc(s.apiKey)}) — leave blank to keep` : 'sk-or-v1-…'}" autocomplete="new-password"/>
      <div class="hint">Stored locally in data/settings.json. Get one at openrouter.ai/keys.</div>
    </div>
    <div class="field">
      <label>Brave Search API key (optional — sharper web_search for agents)</label>
      <input type="password" id="setBrave" placeholder="${s.hasBraveKey ? `saved (${esc(s.braveApiKey)}) — leave blank to keep` : 'free tier at brave.com/search/api'}" autocomplete="new-password"/>
      <div class="hint">Without it, agents fall back to DuckDuckGo.</div>
    </div>
    <div class="field">
      <label>Your name (for the greeting)</label>
      <input type="text" id="setName" value="${esc(s.userName)}"/>
    </div>
    <div class="field">
      <label>Cloud database — Turso/libSQL URL (optional)</label>
      <input type="text" id="setTursoUrl" value="${esc(s.tursoUrl || '')}" placeholder="libsql://your-db.turso.io" autocomplete="off" ${s.tursoFromEnv ? `disabled title="Set via ${esc(s.cloudEnvVar || 'TURSO_DATABASE_URL')} env var"` : ''}/>
      <div class="hint">${
        s.cloudConnected
          ? `● Connected${s.tursoFromEnv ? ` (env var ${esc(s.cloudEnvVar)})` : ''} — chats, memory, files, settings and the cost ledger persist in the cloud.`
          : s.cloudConfigured
            ? '⚠ Configured but NOT reachable — check the URL and auth token (exact error in the server log). Falling back to local files.'
            : (s.cloudEnvCandidates || []).length
              ? `⚠ Env vars ${s.cloudEnvCandidates.map(esc).join(', ')} exist but none holds a database URL — expected TURSO_DATABASE_URL with a libsql:// value.`
              : 'Empty = everything stays in local files. With a free DB from turso.tech, chats, memory and costs survive restarts and hosted deployments.'
      }</div>
    </div>
    <div class="field">
      <label>Turso auth token</label>
      <input type="password" id="setTursoToken" placeholder="${s.hasTursoToken ? `saved (${esc(s.tursoToken)}) — leave blank to keep` : 'eyJhbGci…'}" autocomplete="new-password"/>
    </div>
    <div class="field">
      <label>Orchestrator model — plans, verifies scope, synthesizes</label>
      <select id="setOrch">${options(frontier, s.orchestratorModel)}</select>
    </div>
    <div class="field">
      <label>Verifier model — checks each deliverable (keep it cheap)</label>
      <select id="setVerif">${options(state.models, s.verifierModel)}</select>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Max parallel agents</label>
        <input type="number" id="setPar" min="1" max="8" value="${s.maxParallel}"/>
      </div>
      <div class="field">
        <label>Max retries per node</label>
        <input type="number" id="setRetry" min="0" max="3" value="${s.maxRetries}"/>
      </div>
      <div class="field">
        <label>Cost cap per run ($, 0 = off)</label>
        <input type="number" id="setCap" min="0" step="0.5" value="${s.maxRunCost || 0}"/>
      </div>
    </div>
    <div class="check-field">
      <input type="checkbox" id="setApprove" ${s.approvePlans ? 'checked' : ''}/>
      <label for="setApprove" style="margin:0">Review plans before agents launch (edit models, tools, briefs)</label>
    </div>
    <div class="check-field">
      <input type="checkbox" id="setFree" ${s.preferFree ? 'checked' : ''}/>
      <label for="setFree" style="margin:0">Prefer $0 :free model variants when OpenRouter offers one (rate-limited; falls back to paid automatically)</label>
    </div>
    <div class="check-field">
      <input type="checkbox" id="setMock" ${s.mock ? 'checked' : ''}/>
      <label for="setMock" style="margin:0">Mock mode — simulate runs without API calls</label>
    </div>
    <div class="check-field">
      <input type="checkbox" id="setMemory" ${s.memoryEnabled !== false ? 'checked' : ''}/>
      <label for="setMemory" style="margin:0">Memory — a hierarchical register of durable facts every agent can read and write (listed below, fully deletable)</label>
    </div>
    ${memCount ? `<div class="field"><label>The memory register — ${memCount} fact${memCount === 1 ? '' : 's'}</label><div class="mem-tree" id="memTree"></div></div>` : ''}
    <div class="modal-actions">
      <button class="btn" id="setCancel" type="button">Cancel</button>
      <button class="btn primary" id="setSave" type="submit">Save</button>
    </div>
    </form>
  </div></div>`;

  $('#setCancel').onclick = closeModal;
  // No return value: a DOM0 onclick returning false acts as preventDefault
  // and would cancel checkbox and <details> toggles inside the modal.
  $('#backdrop').onclick = (e) => {
    if (e.target.id === 'backdrop') closeModal();
  };

  // The register rendered as a real tree: path segments become collapsible
  // branches, facts are leaves. Re-rendered in place after every forget.
  const renderMemTree = () => {
    const el = $('#memTree');
    if (!el) return;
    const root = { kids: new Map(), facts: [] };
    for (const m of state.memories || []) {
      let node = root;
      for (const seg of String(m.path || 'general').split('/').filter(Boolean)) {
        if (!node.kids.has(seg)) node.kids.set(seg, { kids: new Map(), facts: [] });
        node = node.kids.get(seg);
      }
      node.facts.push(m);
    }
    const total = (n) => n.facts.length + [...n.kids.values()].reduce((sum, k) => sum + total(k), 0);
    const when = (m) => {
      const t = m.updatedAt || m.ts;
      return t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
    };
    const render = (node) => [
      ...[...node.kids.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, kid]) =>
        `<details class="mem-branch" open><summary><span class="mem-caret"></span><span class="mem-branch-name">${esc(name)}</span><span class="mem-count">${total(kid)}</span>${
          kid.facts.length >= 7 ? '<span class="mem-crowded" title="Crowded — the extractor will differentiate this branch into subpaths">⚠</span>' : ''
        }</summary><div class="mem-kids">${render(kid)}</div></details>`),
      ...node.facts.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)).map((m) =>
        `<div class="mem-item" data-mem-row="${esc(m.id)}" title="${esc(m.path || 'general')}"><span class="mem-dot"></span><span class="mem-text">${esc(m.text)}</span><span class="mem-when">${esc(when(m))}</span><button type="button" class="mem-del" data-mem="${esc(m.id)}" title="Forget this">✕</button></div>`),
    ].join('');
    el.innerHTML = render(root) || '<div class="hint">Empty — agents add durable facts as you work.</div>';
    const n = (state.memories || []).length;
    const lbl = el.closest('.field')?.querySelector('label');
    if (lbl) lbl.textContent = `The memory register — ${n} fact${n === 1 ? '' : 's'}`;
    for (const btn of el.querySelectorAll('.mem-del')) {
      btn.onclick = async () => {
        try {
          const { memories } = await api(`/api/memories/${encodeURIComponent(btn.dataset.mem)}`, { method: 'DELETE' });
          state.memories = memories;
          renderMemTree();
        } catch (err) {
          toast(err.message);
        }
      };
    }
  };
  renderMemTree();
  let savingSettings = false;
  const saveSettings = async (e) => {
    e.preventDefault();
    if (savingSettings) return;
    savingSettings = true;
    $('#setSave').disabled = true;
    try {
      const patch = {
        apiKey: $('#setKey').value.trim(),
        braveApiKey: $('#setBrave').value.trim(),
        tursoUrl: $('#setTursoUrl').value.trim(),
        tursoToken: $('#setTursoToken').value.trim(),
        userName: $('#setName').value.trim() || 'there',
        orchestratorModel: $('#setOrch').value,
        verifierModel: $('#setVerif').value,
        maxParallel: Number($('#setPar').value),
        maxRetries: Number($('#setRetry').value),
        maxRunCost: Math.max(0, Number($('#setCap').value) || 0),
        approvePlans: $('#setApprove').checked,
        preferFree: $('#setFree').checked,
        mock: $('#setMock').checked,
        memoryEnabled: $('#setMemory').checked,
      };
      const res = await api('/api/settings', {
        method: 'POST',
        body: patch,
      });
      if (state.settings?.hosted) {
        saveHostedSettings(patch);
        state.settings = mergeHostedSettings(res.settings);
      } else {
        state.settings = res.settings;
      }
      applySettings();
      closeModal();
      toast('Settings saved');
    } catch (err) {
      toast(err.message);
      $('#setSave').disabled = false;
      savingSettings = false;
    }
  };
  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#setSave').addEventListener('click', saveSettings);
}

function closeModal() {
  $('#modalRoot').innerHTML = '';
}

function applySettings() {
  const s = state.settings;
  $('#footName').textContent = s.userName;
  $('#avatar').textContent = (s.userName || 'F')[0].toUpperCase();
  document.querySelector('.sb-foot-plan').textContent = s.cloudConnected
    ? 'Cloud · Turso'
    : s.hosted
      ? 'Hosted · OpenRouter'
      : 'Local · OpenRouter';
  $('#composerModel').textContent = `${modelShort(s.orchestratorModel)} orchestrating${s.mock ? ' · mock' : ''}`;
  const h = new Date().getHours();
  const part = h < 5 ? 'evening' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  $('#greeting').textContent = `Good ${part}, ${s.userName}`;
}

// ---------------------------------------------------------------- theme

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('maestro-theme', theme);
  $('#themeBtn').innerHTML = theme === 'dark' ? ICON.sun : ICON.moon;
}
$('#themeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

// ---------------------------------------------------------------- boot

(async function boot() {
  applyTheme(localStorage.getItem('maestro-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  try {
    const boot = await api('/api/bootstrap');
    state.settings = mergeHostedSettings(boot.settings);
    state.models = boot.models;
    state.convos = boot.conversations;
    state.memories = boot.memories || [];
    if (boot.mockForced) state.settings.mock = true;
    applySettings();
    renderSidebar();
    renderChat();
    // Reopen the last conversation (also reattaches to a run still executing server-side).
    const last = localStorage.getItem('maestro-last-convo');
    if (last && state.convos.some((c) => c.id === last)) await openConversation(last);
    if (!state.settings.hasApiKey && !state.settings.mock) {
      toast('Add your OpenRouter API key in Settings (gear icon), or enable mock mode.', 6000);
    }
  } catch (err) {
    toast(`Failed to load: ${err.message}`);
  }
  inputEl.focus();
})();
