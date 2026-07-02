// The agent tool layer: web search, URL fetch, sandboxed code execution, and
// per-run workspace files. Tools are executed server-side; each run gets an
// isolated workspace directory under data/workspaces/<runId>.
//
// Tool groups (the planner assigns these per node):
//   "web"  → web_search, fetch_url
//   "code" → run_code, pip_install, write_file, read_file, list_files
//
// The Python runtime prefers the sandbox venv at data/sandbox/venv (created by
// initSandbox on server start; ships numpy/pandas/matplotlib/sympy). Compiled
// languages are detected on the host and compiled into the workspace .tmp dir.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { DATA_ROOT } from './paths.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const FETCH_CAP = 20_000;
const FILE_READ_CAP = 50_000;
const CODE_OUT_CAP = 12_000;

// ---------------------------------------------------------------- sandbox runtimes

const VENV_DIR = path.join(DATA_ROOT, 'sandbox', 'venv');
const VENV_PACKAGES = ['sympy', 'openpyxl'];

// language → how to run it. `probe` is the binary checked for availability.
const RUNTIMES = {
  python: { probe: 'python3', ext: 'py', cmd: () => venvBin('python3') || 'python3' },
  node: { probe: 'node', ext: 'js', cmd: () => 'node' },
  bash: { probe: 'bash', ext: 'sh', cmd: () => 'bash' },
  ruby: { probe: 'ruby', ext: 'rb', cmd: () => 'ruby' },
  perl: { probe: 'perl', ext: 'pl', cmd: () => 'perl' },
  java: { probe: 'java', ext: 'java', cmd: () => 'java' }, // single-file source launch
  swift: { probe: 'swift', ext: 'swift', cmd: () => 'swift' },
  c: { probe: 'cc', ext: 'c', compile: (src, bin) => ['cc', ['-O2', '-o', bin, src, '-lm']] },
  cpp: { probe: 'c++', ext: 'cpp', compile: (src, bin) => ['c++', ['-std=c++17', '-O2', '-o', bin, src]] },
  go: { probe: 'go', ext: 'go', cmd: () => 'go', args: (file) => ['run', file] },
  rust: { probe: 'rustc', ext: 'rs', compile: (src, bin) => ['rustc', ['-O', '-o', bin, src]] },
};

let available = new Set(['python', 'node', 'bash']); // pre-detection fallback
let venvReady = false;

function venvBin(name) {
  return venvReady ? path.join(VENV_DIR, 'bin', name) : null;
}

function which(cmd) {
  return new Promise((resolve) => execFile('which', [cmd], (err) => resolve(!err)));
}

export function sandboxLanguages() {
  return [...available];
}

// Detect host runtimes and make sure the Python venv exists (with the base
// scientific stack) so agents can plot charts out of the box. Idempotent;
// called fire-and-forget from server startup.
export async function initSandbox() {
  const found = await Promise.all(Object.entries(RUNTIMES).map(async ([lang, rt]) => [(await which(rt.probe)) ? lang : null]));
  available = new Set(found.flat().filter(Boolean));

  if (!available.has('python')) return;
  try {
    await fs.access(path.join(VENV_DIR, 'bin', 'python3'));
    venvReady = true;
  } catch {
    try {
      await execP('python3', ['-m', 'venv', '--system-site-packages', VENV_DIR], 120_000);
      await execP(path.join(VENV_DIR, 'bin', 'pip'), ['install', '--quiet', ...VENV_PACKAGES], 300_000);
      venvReady = true;
      console.log('  ✦ sandbox venv created at data/sandbox/venv');
    } catch (err) {
      console.error('  ✦ sandbox venv setup failed (falling back to system python3):', err.message);
    }
  }
}

function execP(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

// ---------------------------------------------------------------- definitions

const DEFS = {
  web: [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web. Returns titles, URLs and snippets. Follow up with fetch_url to read a promising result in full.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query' },
            count: { type: 'number', description: 'Number of results (1-10, default 6)' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fetch_url',
        description: 'Fetch a web page and return its readable text content (HTML is stripped). Use for reading articles, docs, or checking citations.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Absolute http(s) URL' } },
          required: ['url'],
        },
      },
    },
  ],
  code: () => [
    {
      type: 'function',
      function: {
        name: 'run_code',
        description:
          'Execute code in the run workspace and return exit code, stdout and stderr. The workspace persists across calls and across agents — files you write are visible to later tools, agents, and the user. Use this to actually test code before presenting it. Python runs in a sandbox venv with numpy, pandas, matplotlib (headless — save figures with savefig), sympy and openpyxl preinstalled; use pip_install for anything else. Compiled languages (c, cpp, rust) are compiled automatically before running.',
        parameters: {
          type: 'object',
          properties: {
            language: { type: 'string', enum: sandboxLanguages(), description: 'Runtime to use' },
            code: { type: 'string', description: 'The code to execute' },
            timeout_s: { type: 'number', description: 'Timeout in seconds (default 30, max 120)' },
          },
          required: ['language', 'code'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pip_install',
        description: 'Install Python packages into the sandbox venv so run_code(python) can import them. numpy, pandas, matplotlib, sympy and openpyxl are already installed.',
        parameters: {
          type: 'object',
          properties: {
            packages: { type: 'array', items: { type: 'string' }, description: 'PyPI package names, e.g. ["scikit-learn", "pillow"]' },
          },
          required: ['packages'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write a file into the run workspace (relative path). Deliverable files written here become downloadable artifacts for the user.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path inside the workspace, e.g. "report.md" or "src/app.py"' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from the run workspace (user attachments are placed there too).',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Relative path inside the workspace' } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List all files currently in the run workspace with sizes.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ],
};

export function toolDefs(groups) {
  const defs = [];
  for (const g of groups || []) {
    const d = DEFS[g];
    if (d) defs.push(...(typeof d === 'function' ? d() : d));
  }
  return defs.length ? defs : null;
}

// ---------------------------------------------------------------- dispatcher

// ctx: { workspace, signal, settings }
export async function execTool(name, args, ctx) {
  switch (name) {
    case 'web_search':
      return webSearch(args, ctx);
    case 'fetch_url':
      return fetchUrl(args, ctx);
    case 'run_code':
      return runCode(args, ctx);
    case 'pip_install':
      return pipInstall(args, ctx);
    case 'write_file':
      return writeFile(args, ctx);
    case 'read_file':
      return readFile(args, ctx);
    case 'list_files':
      return listFilesTool(ctx);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// Compact one-line summary of a tool call for UI display.
export function summarizeArgs(name, args) {
  try {
    switch (name) {
      case 'web_search':
        return `"${args.query}"`;
      case 'fetch_url':
        return args.url;
      case 'run_code':
        return `${args.language}: ${String(args.code).slice(0, 90).replace(/\s+/g, ' ')}…`;
      case 'pip_install':
        return (args.packages || []).join(', ');
      case 'write_file':
        return `${args.path} (${String(args.content).length} chars)`;
      case 'read_file':
        return args.path;
      case 'list_files':
        return '';
      default:
        return JSON.stringify(args).slice(0, 90);
    }
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- web search

async function webSearch({ query, count = 6 }, ctx) {
  if (!query) throw new Error('query required');
  count = Math.min(10, Math.max(1, Number(count) || 6));

  // Prefer Brave when the user configured a key — better quality and reliability.
  if (ctx.settings?.braveApiKey) {
    try {
      return await braveSearch(query, count, ctx);
    } catch {
      // fall through to DuckDuckGo
    }
  }
  let results = await ddgLite(query, ctx).catch(() => []);
  if (!results.length) results = await ddgHtml(query, ctx).catch(() => []);
  if (!results.length) {
    return 'No results returned (the search engine may be rate-limiting). Try a different query, or fetch_url a source you already know.';
  }
  return results
    .slice(0, count)
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join('\n');
}

async function braveSearch(query, count, ctx) {
  const res = await timedFetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
    { headers: { 'X-Subscription-Token': ctx.settings.braveApiKey, Accept: 'application/json' } },
    ctx
  );
  if (!res.ok) throw new Error(`brave HTTP ${res.status}`);
  const json = await res.json();
  const results = (json.web?.results || []).map((r) => ({
    title: stripTags(r.title || ''),
    url: r.url,
    snippet: stripTags(r.description || ''),
  }));
  if (!results.length) throw new Error('no brave results');
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n');
}

async function ddgLite(query, ctx) {
  const res = await timedFetch(
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    { headers: { 'User-Agent': UA } },
    ctx
  );
  const html = await res.text();
  const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)];
  return links.map((m, i) => ({
    title: stripTags(m[2]),
    url: resolveDdgUrl(m[1]),
    snippet: stripTags(snippets[i]?.[1] || ''),
  }));
}

async function ddgHtml(query, ctx) {
  const res = await timedFetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { headers: { 'User-Agent': UA } },
    ctx
  );
  const html = await res.text();
  const links = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
  return links.map((m, i) => ({
    title: stripTags(m[2]),
    url: resolveDdgUrl(m[1]),
    snippet: stripTags(snippets[i]?.[1] || ''),
  }));
}

function resolveDdgUrl(href) {
  const m = href.match(/uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {}
  }
  if (href.startsWith('//')) return 'https:' + href;
  return href;
}

// ---------------------------------------------------------------- fetch url

async function fetchUrl({ url }, ctx) {
  assertPublicUrl(url);
  const res = await timedFetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json,text/plain,*/*' } }, ctx, 20_000);
  const type = res.headers.get('content-type') || '';
  if (!res.ok) return `HTTP ${res.status} for ${url}`;
  const raw = await res.text();
  let text;
  if (type.includes('html')) {
    const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    text = (title ? `Title: ${stripTags(title)}\n\n` : '') + htmlToText(raw);
  } else {
    text = raw;
  }
  if (text.length > FETCH_CAP) text = text.slice(0, FETCH_CAP) + `\n[…truncated, ${text.length - FETCH_CAP} more characters]`;
  return text || '(empty response)';
}

function assertPublicUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    throw new Error(`invalid URL: ${u}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('only http/https URLs are allowed');
  const h = url.hostname.toLowerCase();
  if (
    h === 'localhost' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)
  ) {
    throw new Error('local/private addresses are blocked');
  }
}

async function timedFetch(url, opts, ctx, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuter = () => controller.abort();
  ctx?.signal?.addEventListener('abort', onOuter, { once: true });
  try {
    return await fetch(url, { ...opts, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
    ctx?.signal?.removeEventListener('abort', onOuter);
  }
}

// ---------------------------------------------------------------- html → text

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeEntities(t) {
  return t.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code || 63);
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function htmlToText(html) {
  let t = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table)>/gi, '\n').replace(/<(br|hr)\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  return t.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------- code execution

let codeSeq = 0;

// The child env: secrets stripped, venv on PATH, matplotlib headless so
// savefig works without a display and show() never blocks the sandbox.
function sandboxEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/(_KEY|_TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)) delete env[k];
  }
  env.MPLBACKEND = 'Agg';
  env.PYTHONUNBUFFERED = '1';
  if (venvReady) {
    env.VIRTUAL_ENV = VENV_DIR;
    env.PATH = `${path.join(VENV_DIR, 'bin')}:${env.PATH || ''}`;
  }
  return env;
}

async function runCode({ language, code, timeout_s = 30 }, ctx) {
  const rt = RUNTIMES[language];
  if (!rt || !available.has(language)) {
    throw new Error(`unsupported language "${language}" — available: ${sandboxLanguages().join(', ')}`);
  }
  if (!code) throw new Error('code required');
  const timeout = Math.min(120, Math.max(1, Number(timeout_s) || 30)) * 1000;

  const tmpDir = path.join(ctx.workspace, '.tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `snippet_${++codeSeq}.${rt.ext}`);
  await fs.writeFile(file, code);
  const env = sandboxEnv();

  let cmd, args;
  if (rt.compile) {
    const bin = path.join(tmpDir, `snippet_${codeSeq}.bin`);
    const [cc, ccArgs] = rt.compile(file, bin);
    const compiled = await spawnCapped(cc, ccArgs, { cwd: ctx.workspace, env, timeout: 60_000, signal: ctx.signal });
    if (compiled.code !== 0) {
      return `COMPILE FAILED (${cc} exit ${compiled.code})\n--- compiler output ---\n${compiled.stderr || compiled.stdout || '(empty)'}`;
    }
    cmd = bin;
    args = [];
  } else {
    cmd = rt.cmd();
    args = rt.args ? rt.args(file) : [file];
  }

  const r = await spawnCapped(cmd, args, { cwd: ctx.workspace, env, timeout, signal: ctx.signal });
  if (r.startError) return `Failed to start ${cmd}: ${r.startError}`;
  return [
    `exit code: ${r.code}${r.timedOut ? ' (KILLED — timeout)' : ''}`,
    `--- stdout ---`,
    r.stdout || '(empty)',
    `--- stderr ---`,
    r.stderr || '(empty)',
  ].join('\n');
}

function spawnCapped(cmd, args, { cwd, env, timeout, signal }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    const cap = (s) => (s.length > CODE_OUT_CAP ? s.slice(0, CODE_OUT_CAP) + `\n[…truncated]` : s);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: '', timedOut, startError: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: cap(stdout), stderr: cap(stderr), timedOut });
    });
  });
}

async function pipInstall({ packages }, ctx) {
  if (!Array.isArray(packages) || !packages.length) throw new Error('packages required');
  const names = packages.map(String).slice(0, 12);
  for (const p of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._\-\[\],=<>!~]*$/.test(p)) throw new Error(`invalid package name: ${p}`);
  }
  const pip = venvBin('pip');
  const [cmd, args] = pip ? [pip, ['install', ...names]] : ['python3', ['-m', 'pip', 'install', '--user', ...names]];
  const r = await spawnCapped(cmd, args, { cwd: ctx.workspace, env: sandboxEnv(), timeout: 240_000, signal: ctx.signal });
  if (r.startError) return `Failed to start pip: ${r.startError}`;
  if (r.code !== 0) return `pip install failed (exit ${r.code})\n${r.stderr || r.stdout}`;
  return `Installed: ${names.join(', ')}`;
}

// ---------------------------------------------------------------- workspace files

function safeJoin(workspace, rel) {
  if (!rel || typeof rel !== 'string') throw new Error('path required');
  const full = path.resolve(workspace, rel);
  if (!full.startsWith(path.resolve(workspace) + path.sep) && full !== path.resolve(workspace)) {
    throw new Error('path escapes the workspace');
  }
  return full;
}

async function writeFile({ path: rel, content }, ctx) {
  if (String(content).length > 2_000_000) throw new Error('content over 2MB limit');
  const full = safeJoin(ctx.workspace, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, String(content));
  return `wrote ${String(content).length} chars to ${rel}`;
}

async function readFile({ path: rel }, ctx) {
  const full = safeJoin(ctx.workspace, rel);
  const buf = await fs.readFile(full);
  let text = buf.toString('utf8');
  if (text.length > FILE_READ_CAP) text = text.slice(0, FILE_READ_CAP) + `\n[…truncated, file is ${buf.length} bytes total]`;
  return text;
}

async function listFilesTool(ctx) {
  const files = await listWorkspace(ctx.workspace);
  if (!files.length) return '(workspace is empty)';
  return files.map((f) => `${f.path} (${f.size} bytes)`).join('\n');
}

// Recursive workspace listing — also used for the artifacts panel.
export async function listWorkspace(workspace, sub = '', depth = 0) {
  if (depth > 6) return [];
  const out = [];
  const dir = path.join(workspace, sub);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...(await listWorkspace(workspace, rel, depth + 1)));
    } else if (e.isFile()) {
      const stat = await fs.stat(path.join(dir, e.name)).catch(() => null);
      if (stat) out.push({ path: rel, size: stat.size });
    }
    if (out.length >= 200) break;
  }
  return out;
}
