// Persistence facade. Local flat files under ./data always work (zero-config);
// when a cloud libSQL/Turso database is configured (Settings → Cloud database,
// or TURSO_DATABASE_URL / TURSO_AUTH_TOKEN), conversations, files, settings,
// memory, verdicts and the run cost ledger are written through to the cloud
// and read from it — so chats continue across restarts, devices, and hosted
// deployments. The local files stay a warm cache; if the cloud is unreachable
// Maestro degrades to local mode instead of breaking.

import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_ROOT } from './paths.js';
import { rid, normPath } from './util.js';
import * as db from './db.js';

const DIRS = {
  conversations: path.join(DATA_ROOT, 'conversations'),
  files: path.join(DATA_ROOT, 'files'),
};
const SETTINGS_PATH = path.join(DATA_ROOT, 'settings.json');
const STATS_PATH = path.join(DATA_ROOT, 'stats.json');
const MEMORY_PATH = path.join(DATA_ROOT, 'memory.json');
const RUNS_PATH = path.join(DATA_ROOT, 'runs.jsonl');

export const DEFAULT_SETTINGS = {
  apiKey: '',
  braveApiKey: '', // optional — better web_search results than the DuckDuckGo fallback
  userName: 'Mateo',
  orchestratorModel: 'anthropic/claude-opus-4.5',
  verifierModel: 'openai/gpt-5-mini',
  fallbackModel: 'openai/gpt-5-mini',
  maxParallel: 4,
  maxRetries: 1,
  maxRunCost: 0, // hard per-run spend ceiling in USD; 0 = no cap
  verifyEnabled: true, // run the QA verifier on each node's deliverables; off = agents' output is accepted as-is
  memoryEnabled: true, // hierarchical register + memory tools for every agent
  tursoUrl: '', // cloud database (libsql://…); empty = local files only
  tursoToken: '',

  approvePlans: true, // pause each run for plan review before agents launch
  preferFree: true, // route to $0 :free model variants when OpenRouter offers one
  mock: false,
};

let settingsCache = null;
let statsCache = null;
let memoryCache = null;

export async function init() {
  await fs.mkdir(DIRS.conversations, { recursive: true });
  await fs.mkdir(DIRS.files, { recursive: true });
  const local = await readLocalSettings();
  db.configure({ url: local.tursoUrl, authToken: local.tursoToken });
  if (db.isConfigured()) {
    await db.init();
    if (db.isCloud()) await seedCloudFromLocal().catch(() => {});
  }
  settingsCache = await composeSettings(local);
  statsCache = await loadStats();
  memoryCache = await loadMemories();
}

export function cloudStatus() {
  return { configured: db.isConfigured(), connected: db.isCloud() };
}

// Self-healing: if the DB is configured but the connect failed (bad first
// boot, transient outage), retry on demand — called from /api/bootstrap so a
// page reload is enough to recover instead of waiting for a cold start.
export async function ensureCloud() {
  if (db.isConfigured() && !db.isCloud()) {
    await db.init();
    if (db.isCloud()) {
      await seedCloudFromLocal().catch(() => {});
      settingsCache = await composeSettings(await readLocalSettings());
      statsCache = await loadStats();
      memoryCache = await loadMemories();
    }
  }
  return cloudStatus();
}

// First cloud connect: migrate existing local history up, so switching a
// long-running local install to the cloud loses nothing.
async function seedCloudFromLocal() {
  const [{ rows: convoCount }, { rows: memCount }, { rows: verdictCount }] = await Promise.all([
    db.exec('SELECT COUNT(*) AS n FROM conversations'),
    db.exec('SELECT COUNT(*) AS n FROM memory'),
    db.exec('SELECT COUNT(*) AS n FROM verdicts'),
  ]);
  const stmts = [];
  if (!convoCount[0]?.n) {
    for (const f of await fs.readdir(DIRS.conversations).catch(() => [])) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(await fs.readFile(path.join(DIRS.conversations, f), 'utf8'));
        stmts.push(conversationUpsert(c));
      } catch {}
    }
  }
  if (!memCount[0]?.n) {
    for (const m of await loadMemoriesFromDisk()) stmts.push(memoryUpsert(m));
  }
  if (!verdictCount[0]?.n) {
    for (const s of await loadStatsFromDisk()) stmts.push(verdictInsert(s));
  }
  for (let i = 0; i < stmts.length; i += 25) {
    await db.batch(stmts.slice(i, i + 25));
  }
  if (stmts.length) console.log(`  ✦ migrated ${stmts.length} local records to the cloud database`);
}

// --- settings ---------------------------------------------------------------

// The DB credentials themselves must bootstrap from the local file or env —
// everything else lives in the cloud kv when connected, which is what makes
// settings survive on hosted (tmpfs) deployments.
async function readLocalSettings() {
  try {
    const raw = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function composeSettings(local) {
  if (db.isCloud()) {
    try {
      const { rows } = await db.exec('SELECT v FROM kv WHERE k = ?', ['settings']);
      if (rows[0]?.v) {
        const cloud = JSON.parse(rows[0].v);
        delete cloud.tursoUrl;
        delete cloud.tursoToken;
        return { ...local, ...cloud };
      }
    } catch {}
  }
  return local;
}

export async function loadSettings() {
  if (!settingsCache) settingsCache = await composeSettings(await readLocalSettings());
  return { ...settingsCache };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  next.maxParallel = Math.min(8, Math.max(1, Number(next.maxParallel) || 4));
  next.maxRetries = Math.min(3, Math.max(0, Number(next.maxRetries) ?? 1));
  next.maxRunCost = Math.max(0, Number(next.maxRunCost) || 0);
  next.tursoUrl = String(next.tursoUrl || '').trim();
  next.tursoToken = String(next.tursoToken || '').trim();

  await fs.writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2)).catch(() => {});

  const dbChanged = next.tursoUrl !== current.tursoUrl || next.tursoToken !== current.tursoToken;
  if (dbChanged) {
    db.configure({ url: next.tursoUrl, authToken: next.tursoToken });
    if (db.isConfigured()) {
      await db.init();
      if (db.isCloud()) {
        await seedCloudFromLocal().catch(() => {});
        statsCache = await loadStats();
        memoryCache = await loadMemories();
      }
    }
  }
  if (db.isCloud()) {
    const cloud = { ...next };
    delete cloud.tursoUrl;
    delete cloud.tursoToken;
    await db
      .exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', ['settings', JSON.stringify(cloud)])
      .catch(() => {});
  }
  settingsCache = next;
  return { ...next };
}

// --- verifier outcome stats ---------------------------------------------------

// Every verification verdict is appended here: which model delivered (or
// didn't) on which kind of work. This is the raw material for a router that
// learns — no other layer of the stack can collect execution-grounded labels.

async function loadStatsFromDisk() {
  try {
    const arr = JSON.parse(await fs.readFile(STATS_PATH, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function loadStats() {
  if (db.isCloud()) {
    try {
      const { rows } = await db.exec(
        'SELECT ts, model, tools, attempt, score, pass, escalated_from FROM verdicts ORDER BY ts DESC LIMIT 2000'
      );
      return rows.reverse().map((r) => ({
        ts: r.ts,
        model: r.model,
        tools: JSON.parse(r.tools || '[]'),
        attempt: r.attempt,
        score: r.score,
        pass: Boolean(r.pass),
        escalatedFrom: r.escalated_from,
      }));
    } catch {}
  }
  return loadStatsFromDisk();
}

export function getStatsSync() {
  return statsCache || [];
}

function verdictInsert(entry) {
  return [
    'INSERT INTO verdicts (ts, model, tools, attempt, score, pass, escalated_from) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [entry.ts, entry.model, JSON.stringify(entry.tools || []), entry.attempt ?? null, entry.score ?? null, entry.pass ? 1 : 0, entry.escalatedFrom || null],
  ];
}

export async function recordVerdict(entry) {
  if (!statsCache) statsCache = await loadStats();
  statsCache.push(entry);
  if (statsCache.length > 5000) statsCache = statsCache.slice(-5000);
  await fs.writeFile(STATS_PATH, JSON.stringify(statsCache)).catch(() => {});
  if (db.isCloud()) await db.batch([verdictInsert(entry)]).catch(() => {});
}

// --- run cost ledger ------------------------------------------------------------

// One row per finished run: what it cost, what frontier-only would have cost,
// and therefore what routing saved. The billing-grade ground truth behind the
// sidebar savings counter.
export async function recordRun(snap, conversationId) {
  const row = {
    id: snap.id,
    conversationId,
    ts: snap.endedAt || Date.now(),
    status: snap.status,
    cost: snap.totals?.cost || 0,
    baselineCost: snap.totals?.baselineCost || 0,
    saved: Math.max(0, (snap.totals?.baselineCost || 0) - (snap.totals?.cost || 0)),
    tokensIn: snap.totals?.tokensIn || 0,
    tokensOut: snap.totals?.tokensOut || 0,
    calls: snap.totals?.calls || 0,
  };
  await fs.appendFile(RUNS_PATH, JSON.stringify(row) + '\n').catch(() => {});
  if (db.isCloud()) {
    await db
      .batch([
        [
          `INSERT INTO runs (id, conversation_id, ts, status, cost, baseline_cost, saved, tokens_in, tokens_out, calls)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
          [row.id, row.conversationId, row.ts, row.status, row.cost, row.baselineCost, row.saved, row.tokensIn, row.tokensOut, row.calls],
        ],
      ])
      .catch(() => {});
  }
}

// --- long-term user memory (the hierarchical register) ----------------------------

// Entries: { id, path, text, type, ts, updatedAt, usedAt }. Paths are register
// branches ("privatleben/familie/kind"); src/memory.js renders outlines and
// the agent tool surface on top of this storage.
const MEMORY_TYPES = ['user', 'preference', 'project'];
const MEMORY_CAP = 400;

// Pre-register entries (from the flat-memory era) get a branch from their type.
const LEGACY_PATHS = { user: 'profile', preference: 'preferences', project: 'projects' };

function normalizeEntry(m) {
  return {
    id: m.id || rid('m_'),
    path: normPath(m.path ?? LEGACY_PATHS[m.type] ?? ''),
    text: String(m.text || ''),
    type: MEMORY_TYPES.includes(m.type) ? m.type : 'user',
    ts: m.ts || Date.now(),
    updatedAt: m.updatedAt || m.ts || Date.now(),
    usedAt: m.usedAt || 0,
  };
}

async function loadMemoriesFromDisk() {
  try {
    const arr = JSON.parse(await fs.readFile(MEMORY_PATH, 'utf8'));
    return (Array.isArray(arr) ? arr : []).map(normalizeEntry);
  } catch {
    return [];
  }
}

async function loadMemoriesFromCloud() {
  const { rows } = await db.exec('SELECT id, path, text, type, created_at, updated_at, used_at FROM memory');
  return rows.map((r) =>
    normalizeEntry({ id: r.id, path: r.path, text: r.text, type: r.type, ts: r.created_at, updatedAt: r.updated_at, usedAt: r.used_at })
  );
}

async function loadMemories() {
  if (db.isCloud()) {
    try {
      return await loadMemoriesFromCloud();
    } catch {}
  }
  return loadMemoriesFromDisk();
}

// Serverless instances are ephemeral and each keeps its own in-memory caches.
// Memory is read via getMemoriesSync() (the prompt-injection path needs it
// synchronous), so a warm instance would otherwise never see a fact another
// instance wrote to the cloud. Re-read the register from the cloud on the read
// paths (bootstrap, run start) so it stays consistent across instances. A
// transient failure keeps the existing cache rather than blanking it.
export async function refreshMemories() {
  if (!db.isCloud()) return memoryCache || [];
  try {
    memoryCache = await loadMemoriesFromCloud();
  } catch {}
  return memoryCache || [];
}

export function getMemoriesSync() {
  return memoryCache || [];
}

function memoryUpsert(m) {
  return [
    `INSERT INTO memory (id, path, text, type, created_at, updated_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET path = excluded.path, text = excluded.text, updated_at = excluded.updated_at, used_at = excluded.used_at`,
    [m.id, m.path, m.text, m.type, m.ts, m.updatedAt, m.usedAt || 0],
  ];
}

async function persistMemories(cloudStmts) {
  await fs.writeFile(MEMORY_PATH, JSON.stringify(memoryCache, null, 2)).catch(() => {});
  if (db.isCloud() && cloudStmts.length) await db.batch(cloudStmts).catch(() => {});
}

// ops: { add: [{path, text, type}], move: [{id, path}], remove: [ids] }
export async function updateMemories({ add = [], move = [], remove = [] } = {}) {
  if (!memoryCache) memoryCache = await loadMemories();
  const stmts = [];
  let changed = false;

  const rm = new Set((Array.isArray(remove) ? remove : []).map(String));
  if (rm.size) {
    const before = memoryCache.length;
    memoryCache = memoryCache.filter((m) => !rm.has(m.id));
    if (memoryCache.length !== before) {
      changed = true;
      for (const id of rm) stmts.push(['DELETE FROM memory WHERE id = ?', [id]]);
    }
  }

  for (const mv of Array.isArray(move) ? move : []) {
    const m = memoryCache.find((x) => x.id === String(mv?.id));
    const newPath = normPath(mv?.path);
    if (!m || m.path === newPath) continue;
    m.path = newPath;
    m.updatedAt = Date.now();
    stmts.push(memoryUpsert(m));
    changed = true;
  }

  for (const a of Array.isArray(add) ? add : []) {
    const text = String(a?.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text) continue;
    if (memoryCache.some((m) => m.text.toLowerCase() === text.toLowerCase())) continue;
    const entry = normalizeEntry({ id: rid('m_'), path: a.path, text, type: a.type });
    memoryCache.push(entry);
    stmts.push(memoryUpsert(entry));
    changed = true;
  }

  // Cap: drop the least recently touched entries first.
  if (memoryCache.length > MEMORY_CAP) {
    const byStaleness = [...memoryCache].sort(
      (a, b) => Math.max(a.usedAt, a.updatedAt) - Math.max(b.usedAt, b.updatedAt)
    );
    const evict = new Set(byStaleness.slice(0, memoryCache.length - MEMORY_CAP).map((m) => m.id));
    memoryCache = memoryCache.filter((m) => !evict.has(m.id));
    for (const id of evict) stmts.push(['DELETE FROM memory WHERE id = ?', [id]]);
    changed = true;
  }

  if (changed) await persistMemories(stmts);
  return memoryCache;
}

export async function deleteMemory(id) {
  return updateMemories({ remove: [id] });
}

// Reads bump usedAt so the outline prioritizes what actually gets used.
// Fire-and-forget persistence — never blocks a tool round.
export function touchMemories(ids) {
  if (!memoryCache) return;
  const now = Date.now();
  const set = new Set(ids);
  const stmts = [];
  for (const m of memoryCache) {
    if (set.has(m.id)) {
      m.usedAt = now;
      stmts.push(['UPDATE memory SET used_at = ? WHERE id = ?', [now, m.id]]);
    }
  }
  if (!stmts.length) return;
  fs.writeFile(MEMORY_PATH, JSON.stringify(memoryCache, null, 2)).catch(() => {});
  if (db.isCloud()) db.batch(stmts).catch(() => {});
}

// --- conversations ----------------------------------------------------------

function conversationUpsert(c) {
  return [
    `INSERT INTO conversations (id, title, created_at, updated_at, cost, saved, data) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at,
       cost = excluded.cost, saved = excluded.saved, data = excluded.data`,
    [c.id, c.title || '', c.createdAt || Date.now(), c.updatedAt || Date.now(), c.cost || 0, c.saved || 0, JSON.stringify(c)],
  ];
}

export async function listConversations() {
  if (db.isCloud()) {
    try {
      const { rows } = await db.exec('SELECT id, title, updated_at, cost, saved FROM conversations ORDER BY updated_at DESC LIMIT 200');
      return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at, cost: r.cost || 0, saved: r.saved || 0 }));
    } catch {}
  }
  const files = await fs.readdir(DIRS.conversations).catch(() => []);
  const items = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const c = JSON.parse(await fs.readFile(path.join(DIRS.conversations, f), 'utf8'));
      items.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, cost: c.cost || 0, saved: c.saved || 0 });
    } catch {
      // skip corrupt files
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

export async function loadConversation(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  if (db.isCloud()) {
    try {
      const { rows } = await db.exec('SELECT data FROM conversations WHERE id = ?', [id]);
      if (rows[0]?.data) return JSON.parse(rows[0].data);
    } catch {}
  }
  try {
    return JSON.parse(await fs.readFile(path.join(DIRS.conversations, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export async function saveConversation(convo) {
  convo.updatedAt = Date.now();
  await fs.writeFile(path.join(DIRS.conversations, `${convo.id}.json`), JSON.stringify(convo, null, 2)).catch(() => {});
  if (db.isCloud()) await db.batch([conversationUpsert(convo)]).catch(() => {});
  return convo;
}

export async function deleteConversation(id) {
  if (!/^[\w-]+$/.test(id)) return;
  await fs.rm(path.join(DIRS.conversations, `${id}.json`), { force: true });
  if (db.isCloud()) await db.exec('DELETE FROM conversations WHERE id = ?', [id]).catch(() => {});
}

export function newConversation(firstMessage) {
  const title = (firstMessage || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 64);
  return { id: rid('c_'), title, createdAt: Date.now(), updatedAt: Date.now(), cost: 0, messages: [] };
}

// --- uploaded files ---------------------------------------------------------

const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
]);
const TEXT_EXTS = /\.(txt|md|markdown|csv|tsv|json|xml|yaml|yml|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|hpp|sh|sql|toml|ini|cfg|log)$/i;

// Rows past this stay local-only — cloud DBs cap row size, and multi-MB
// uploads are cheap to re-attach but expensive to sync.
const CLOUD_FILE_CAP = 4 * 1024 * 1024;

export function classifyFile(name, mime) {
  if ((mime || '').startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if ((mime || '').startsWith('text/') || TEXT_MIMES.has(mime) || TEXT_EXTS.test(name)) return 'text';
  return 'binary';
}

export async function saveFile({ name, mime, dataBase64 }) {
  const buffer = Buffer.from(dataBase64, 'base64');
  const kind = classifyFile(name, mime);
  const meta = { id: rid('f_'), name, mime: mime || 'application/octet-stream', size: buffer.length, kind };
  if (kind === 'text') {
    meta.preview = buffer.toString('utf8', 0, 400).replace(/\s+/g, ' ');
  }
  await fs.writeFile(path.join(DIRS.files, `${meta.id}.bin`), buffer);
  await fs.writeFile(path.join(DIRS.files, `${meta.id}.json`), JSON.stringify(meta));
  if (db.isCloud() && buffer.length <= CLOUD_FILE_CAP) {
    await db
      .batch([
        [
          'INSERT INTO files (id, name, mime, kind, size, created_at, meta, content_b64) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
          [meta.id, meta.name, meta.mime, meta.kind, meta.size, Date.now(), JSON.stringify(meta), buffer.toString('base64')],
        ],
      ])
      .catch(() => {});
  }
  return meta;
}

export async function loadFile(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  try {
    const meta = JSON.parse(await fs.readFile(path.join(DIRS.files, `${id}.json`), 'utf8'));
    const buffer = await fs.readFile(path.join(DIRS.files, `${id}.bin`));
    return { meta, buffer };
  } catch {
    // Not on this disk (fresh instance / hosted cold start) — try the cloud.
    if (db.isCloud()) {
      try {
        const { rows } = await db.exec('SELECT meta, content_b64 FROM files WHERE id = ?', [id]);
        if (rows[0]?.content_b64) {
          return { meta: JSON.parse(rows[0].meta), buffer: Buffer.from(rows[0].content_b64, 'base64') };
        }
      } catch {}
    }
    return null;
  }
}
