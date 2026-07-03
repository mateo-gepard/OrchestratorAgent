// Cloud persistence over the libSQL/Turso HTTP API — plain fetch, zero
// dependencies. When configured (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN env
// vars, or the Cloud database fields in Settings), conversations, files,
// memory, verifier verdicts and the run cost ledger live in the cloud and
// survive restarts, redeployments, and serverless cold starts. Without it,
// the store falls back to the local flat files — Maestro never requires an
// account to run.

let base = '';
let token = '';
let healthy = false;

// The Vercel Turso integration lets users pick a custom env prefix when
// connecting a database, so the vars may arrive as e.g.
// STORAGE_TURSO_DATABASE_URL instead of the documented TURSO_DATABASE_URL.
// Detect by value (libsql:// scheme or a turso.io host), not just by name,
// and find the matching token by shared prefix.
export function envConfig() {
  const env = process.env;
  let urlName = env.TURSO_DATABASE_URL ? 'TURSO_DATABASE_URL' : '';
  if (!urlName) {
    for (const [k, v] of Object.entries(env)) {
      const s = String(v || '').trim();
      const tursoName = /(^|_)(TURSO|LIBSQL)(_|$)/.test(k) && /URL$/.test(k) && /^(libsql|https?):\/\//.test(s);
      const tursoValue = /^libsql:\/\//.test(s) || /^https?:\/\/[^\s/]*\.turso\.io/.test(s);
      if (tursoName || tursoValue) { urlName = k; break; }
    }
  }
  if (!urlName) {
    const candidates = Object.keys(env).filter((k) => /TURSO|LIBSQL/i.test(k)).sort();
    return { url: '', token: '', urlName: '', tokenName: '', candidates };
  }
  const tokenNames = [];
  const stem = urlName.replace(/_(DATABASE_)?URL$/, '');
  for (const s of [stem, stem.replace(/_DATABASE$/, '')]) {
    tokenNames.push(`${s}_AUTH_TOKEN`, `${s}_DATABASE_AUTH_TOKEN`, `${s}_TOKEN`);
  }
  tokenNames.push('TURSO_AUTH_TOKEN', 'LIBSQL_AUTH_TOKEN');
  let tokenName = tokenNames.find((k) => env[k]) || '';
  if (!tokenName) tokenName = Object.keys(env).find((k) => /TURSO|LIBSQL/i.test(k) && /TOKEN|SECRET/i.test(k)) || '';
  return {
    url: String(env[urlName]).trim(),
    token: String(env[tokenName] || '').trim(),
    urlName,
    tokenName,
    candidates: [],
  };
}

export function configure({ url, authToken } = {}) {
  const fromEnv = envConfig();
  const u = String(fromEnv.url || url || '').trim();
  token = String(fromEnv.token || authToken || '').trim();
  // libsql:// is the Turso scheme; the HTTP API lives on https. Plain http is
  // kept as-is so a local sqld instance works too.
  base = u.replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
  healthy = false;
  return Boolean(base);
}

export function isConfigured() {
  return Boolean(base);
}

export function isCloud() {
  return Boolean(base) && healthy;
}

// Self-migrating schema: executed on every connect, all statements idempotent.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER,
    cost REAL DEFAULT 0, saved REAL DEFAULT 0, data TEXT)`,
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, name TEXT, mime TEXT, kind TEXT, size INTEGER,
    created_at INTEGER, meta TEXT, content_b64 TEXT)`,
  `CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY, path TEXT DEFAULT '', text TEXT, type TEXT,
    created_at INTEGER, updated_at INTEGER, used_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS verdicts (
    ts INTEGER, model TEXT, tools TEXT, attempt INTEGER, score REAL,
    pass INTEGER, escalated_from TEXT)`,
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, conversation_id TEXT, ts INTEGER, status TEXT,
    cost REAL, baseline_cost REAL, saved REAL,
    tokens_in INTEGER, tokens_out INTEGER, calls INTEGER)`,
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations (updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_path ON memory (path)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_ts ON runs (ts)`,
];

export async function init() {
  if (!base) return false;
  try {
    await batch(SCHEMA.map((sql) => [sql]));
    healthy = true;
  } catch (err) {
    healthy = false;
    console.error('  ✦ cloud DB unreachable — falling back to local files:', err.message);
  }
  return healthy;
}

// --- the wire protocol -----------------------------------------------------

// One-shot v2 pipeline: all statements plus a close in a single POST, so no
// baton bookkeeping is needed. Statements in one call run on one connection.
async function pipeline(stmts) {
  const body = {
    requests: [...stmts.map((stmt) => ({ type: 'execute', stmt })), { type: 'close' }],
  };
  const res = await fetch(`${base}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`libsql HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  const json = await res.json();
  const out = [];
  for (const r of json.results || []) {
    if (r.type === 'error') throw new Error(`libsql: ${r.error?.message || 'unknown error'}`);
    if (r.response?.type === 'execute') out.push(shapeResult(r.response.result || {}));
  }
  return out;
}

function shapeResult(result) {
  const cols = (result.cols || []).map((c) => c.name);
  const rows = (result.rows || []).map((raw) => {
    const obj = {};
    raw.forEach((cell, i) => (obj[cols[i]] = decodeCell(cell)));
    return obj;
  });
  return { rows, rowsAffected: result.affected_row_count || 0 };
}

// The JSON protocol carries typed cells; integers travel as strings.
function encodeArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  }
  return { type: 'text', value: String(v) };
}

function decodeCell(cell) {
  if (!cell || cell.type === 'null') return null;
  if (cell.type === 'integer' || cell.type === 'float') return Number(cell.value);
  return cell.value; // text; blobs arrive base64 in .base64 but we only store text
}

export async function exec(sql, args = []) {
  const [r] = await pipeline([{ sql, args: args.map(encodeArg) }]);
  return r || { rows: [], rowsAffected: 0 };
}

// stmts: array of [sql, args?] — executed in order in one round trip.
export async function batch(stmts) {
  if (!stmts.length) return [];
  return pipeline(stmts.map(([sql, args]) => ({ sql, args: (args || []).map(encodeArg) })));
}
