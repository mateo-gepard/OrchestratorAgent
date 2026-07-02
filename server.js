// Maestro — local agent orchestration server. Zero dependencies, Node 18+.
//   node server.js            → http://localhost:4646
//   MOCK=1 node server.js     → simulated runs, no API key needed

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './src/store.js';
import { CATALOG, ensureLivePricing } from './src/models.js';
import { createRun, executeRun, resolveApproval, workspacePath } from './src/orchestrator.js';
import { initSandbox } from './src/tools.js';
import { executeMockRun } from './src/mock.js';
import { IS_VERCEL } from './src/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 4646;
const FORCE_MOCK = process.env.MOCK === '1';
const BODY_LIMIT = 25 * 1024 * 1024;

const activeRuns = new Map(); // runId -> run (kept in memory; snapshots persist)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const ready = (async () => {
  await store.init();
  ensureLivePricing(); // fire-and-forget; awaited again before first plan
  initSandbox().catch(() => {}); // detect runtimes + build the Python venv
})();

export async function handler(req, res) {
  await ready;
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

export default handler;

if (!process.env.VERCEL) {
  const server = http.createServer(handler);
  server.listen(PORT, () => {
    console.log(`\n  ✦ Maestro is running → http://localhost:${PORT}${FORCE_MOCK ? '  (mock mode)' : ''}\n`);
  });
}

// --- API ---------------------------------------------------------------------

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (method === 'GET' && pathname === '/api/bootstrap') {
    const settings = await store.loadSettings();
    return sendJson(res, 200, {
      settings: maskSettings(settings),
      models: CATALOG,
      conversations: await store.listConversations(),
      mockForced: FORCE_MOCK,
    });
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const body = await readBody(req);
    // An empty key field means "keep the stored key".
    if (body.apiKey === '') delete body.apiKey;
    if (body.braveApiKey === '') delete body.braveApiKey;
    const settings = await store.saveSettings(body);
    return sendJson(res, 200, { settings: maskSettings(settings) });
  }

  if (method === 'POST' && pathname === '/api/upload') {
    const body = await readBody(req);
    if (!body.name || !body.dataBase64) return sendJson(res, 400, { error: 'name and dataBase64 required' });
    const meta = await store.saveFile(body);
    return sendJson(res, 200, meta);
  }

  if (method === 'GET' && pathname.startsWith('/api/conversation/')) {
    const id = pathname.split('/').pop();
    const convo = await store.loadConversation(id);
    if (!convo) return sendJson(res, 404, { error: 'not found' });
    const live = [...activeRuns.values()].find((r) => r.conversationId === id && !r.endedAt);
    return sendJson(res, 200, { conversation: convo, activeRunId: live?.id || null });
  }

  if (method === 'DELETE' && pathname.startsWith('/api/conversation/')) {
    await store.deleteConversation(pathname.split('/').pop());
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/run') {
    return startRun(req, res);
  }

  if (method === 'POST' && pathname === '/api/run-stream') {
    return startRunStream(req, res);
  }

  if (method === 'POST' && /^\/api\/runs\/[\w-]+\/stop$/.test(pathname)) {
    const run = activeRuns.get(pathname.split('/')[3]);
    if (run) run.abort.abort();
    return sendJson(res, 200, { ok: true });
  }

  // Plan review: approve (optionally with per-node edits) or cancel a run
  // that is paused at the approval gate.
  if (method === 'POST' && /^\/api\/runs\/[\w-]+\/plan$/.test(pathname)) {
    const run = activeRuns.get(pathname.split('/')[3]);
    if (!run) return sendJson(res, 404, { error: 'run not found' });
    const body = await readBody(req);
    try {
      resolveApproval(run, { action: body.action, edits: body.edits });
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 409, { error: err.message });
    }
  }

  // Download a workspace artifact. Disk-backed, so links survive restarts.
  if (method === 'GET' && /^\/api\/runs\/[\w-]+\/files\//.test(pathname)) {
    return serveArtifact(res, pathname);
  }

  if (method === 'GET' && pathname.startsWith('/api/events/')) {
    return handleEvents(req, res, pathname.split('/').pop());
  }

  sendJson(res, 404, { error: 'unknown endpoint' });
}

async function startRun(req, res) {
  const body = await readBody(req);
  const prepared = await prepareRun(body, { forceNoApproval: IS_VERCEL });
  if (prepared.error) return sendJson(res, prepared.status, { error: prepared.error });
  const { run, conversation, mock } = prepared;

  activeRuns.set(run.id, run);
  trimRuns();

  await persistUserTurn(conversation, run);

  const engine = mock ? executeMockRun : executeRun;
  engine(run, conversation, { onFinished: finishConversation(conversation) }).catch((err) => console.error('run crashed:', err));

  sendJson(res, 200, { runId: run.id, conversationId: conversation.id, title: conversation.title });
}

async function startRunStream(req, res) {
  const body = await readBody(req);
  const prepared = await prepareRun(body, { forceNoApproval: IS_VERCEL });
  if (prepared.error) return sendJson(res, prepared.status, { error: prepared.error });
  const { run, conversation, mock } = prepared;

  activeRuns.set(run.id, run);
  trimRuns();
  await persistUserTurn(conversation, run);

  res.writeHead(200, sseHeaders());
  writeSse(res, null, { type: 'meta', data: { runId: run.id, conversationId: conversation.id, title: conversation.title } });
  run.subscribers.add(res);

  let ended = false;
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {}
  }, 15000);
  req.on('close', () => {
    if (!ended && !run.endedAt) run.abort.abort();
    clearInterval(heartbeat);
    run.subscribers.delete(res);
  });

  try {
    const engine = mock ? executeMockRun : executeRun;
    await engine(run, conversation, { onFinished: finishConversation(conversation) });
  } catch (err) {
    console.error('streamed run crashed:', err);
  } finally {
    ended = true;
    clearInterval(heartbeat);
    run.subscribers.delete(res);
    if (!res.writableEnded) res.end();
    trimRuns();
  }
}

async function prepareRun(body, { forceNoApproval }) {
  const task = String(body.message || '').trim();
  if (!task) return { status: 400, error: 'message required' };

  const settings = await store.loadSettings();
  settings.apiKey = process.env.OPENROUTER_API_KEY || settings.apiKey;
  if (forceNoApproval) settings.approvePlans = false;
  const mock = FORCE_MOCK || settings.mock;
  if (!mock && !settings.apiKey) {
    return { status: 400, error: 'No OpenRouter API key configured. Open Settings (gear icon) and add one, or enable mock mode.' };
  }

  let conversation = body.conversationId ? await store.loadConversation(body.conversationId) : null;
  if (!conversation) conversation = store.newConversation(task);

  const attachments = [];
  for (const fileId of body.attachments || []) {
    const f = await store.loadFile(fileId);
    if (f) attachments.push(f.meta);
  }

  const run = createRun({ conversation, task, attachments, settings });
  return { run, conversation, mock };
}

async function persistUserTurn(conversation, run) {
  // Persist the user turn immediately so a refresh mid-run shows it.
  conversation.messages.push({ role: 'user', content: run.task, attachments: run.attachments.map((a) => ({ id: a.id, name: a.name })) });
  await store.saveConversation(conversation);
}

function finishConversation(conversation) {
  return async (snap) => {
    conversation.messages.push({ role: 'assistant', content: snap.answer, run: snap });
    conversation.cost = (conversation.cost || 0) + snap.totals.cost;
    await store.saveConversation(conversation);
  };
}

function handleEvents(req, res, runId) {
  const run = activeRuns.get(runId);
  if (!run) return sendJson(res, 404, { error: 'run not found (server restarted?)' });

  res.writeHead(200, sseHeaders());

  // Replay history (supports EventSource reconnection via Last-Event-ID).
  const from = Number(req.headers['last-event-id'] ?? -1) + 1;
  for (let i = from; i < run.events.length; i++) {
    writeSse(res, i, run.events[i]);
  }
  run.subscribers.add(res);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    run.subscribers.delete(res);
  });
}

function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

function writeSse(res, id, ev) {
  if (id != null) res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

function trimRuns() {
  const finished = [...activeRuns.values()].filter((r) => r.endedAt).sort((a, b) => a.endedAt - b.endedAt);
  while (activeRuns.size > 20 && finished.length) {
    activeRuns.delete(finished.shift().id);
  }
}

function maskSettings(settings) {
  const masked = { ...settings };
  if (IS_VERCEL) masked.approvePlans = false;
  masked.hosted = IS_VERCEL;
  masked.hasApiKey = Boolean(process.env.OPENROUTER_API_KEY || settings.apiKey);
  masked.apiKey = settings.apiKey ? `…${settings.apiKey.slice(-4)}` : '';
  masked.hasBraveKey = Boolean(settings.braveApiKey);
  masked.braveApiKey = settings.braveApiKey ? `…${settings.braveApiKey.slice(-4)}` : '';
  return masked;
}

// Workspace files download safely: text and images render inline (SVG under a
// script-blocking CSP sandbox). HTML renders inline under CSP `sandbox
// allow-scripts` — a unique opaque origin, so agent-built games/apps run but
// can never touch the Maestro origin, its API, or storage.
const SAFE_INLINE = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
};

async function serveArtifact(res, pathname) {
  const [, , , runId, , ...rest] = pathname.split('/');
  const rel = decodeURIComponent(rest.join('/'));
  if (!/^[\w-]+$/.test(runId) || !rel) {
    res.writeHead(400);
    return res.end('bad request');
  }
  const root = workspacePath(runId);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const data = await fs.readFile(full);
    const ext = path.extname(full).toLowerCase();
    const inline = SAFE_INLINE[ext];
    const headers = {
      'Content-Type': inline || 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${path.basename(full).replace(/"/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
    };
    if (ext === '.svg') headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
    if (ext === '.html' || ext === '.htm') headers['Content-Security-Policy'] = 'sandbox allow-scripts allow-pointer-lock';
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

// --- plumbing ------------------------------------------------------------------

function readBody(req) {
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) return parseJsonBody(req.body.toString('utf8'));
    if (typeof req.body === 'string') return parseJsonBody(req.body);
    return Promise.resolve(req.body || {});
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large (25MB limit)'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function parseJsonBody(raw) {
  return Promise.resolve().then(() => JSON.parse(raw || '{}'));
}

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function serveStatic(req, res, url) {
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const data = await fs.readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}
