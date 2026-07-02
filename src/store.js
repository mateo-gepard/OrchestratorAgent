// Flat-file persistence under ./data — conversations, settings, uploads.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rid } from './util.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DIRS = {
  conversations: path.join(ROOT, 'conversations'),
  files: path.join(ROOT, 'files'),
};
const SETTINGS_PATH = path.join(ROOT, 'settings.json');

export const DEFAULT_SETTINGS = {
  apiKey: '',
  braveApiKey: '', // optional — better web_search results than the DuckDuckGo fallback
  userName: 'Mateo',
  orchestratorModel: 'anthropic/claude-opus-4.5',
  verifierModel: 'openai/gpt-5-mini',
  fallbackModel: 'openai/gpt-5-mini',
  maxParallel: 4,
  maxRetries: 1,
  approvePlans: true, // pause each run for plan review before agents launch
  preferFree: true, // route to $0 :free model variants when OpenRouter offers one
  mock: false,
};

export async function init() {
  await fs.mkdir(DIRS.conversations, { recursive: true });
  await fs.mkdir(DIRS.files, { recursive: true });
}

// --- settings ---------------------------------------------------------------

export async function loadSettings() {
  try {
    const raw = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  next.maxParallel = Math.min(8, Math.max(1, Number(next.maxParallel) || 4));
  next.maxRetries = Math.min(3, Math.max(0, Number(next.maxRetries) ?? 1));
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

// --- conversations ----------------------------------------------------------

export async function listConversations() {
  const files = await fs.readdir(DIRS.conversations).catch(() => []);
  const items = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const c = JSON.parse(await fs.readFile(path.join(DIRS.conversations, f), 'utf8'));
      items.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, cost: c.cost || 0 });
    } catch {
      // skip corrupt files
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

export async function loadConversation(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(DIRS.conversations, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export async function saveConversation(convo) {
  convo.updatedAt = Date.now();
  await fs.writeFile(path.join(DIRS.conversations, `${convo.id}.json`), JSON.stringify(convo, null, 2));
  return convo;
}

export async function deleteConversation(id) {
  if (!/^[\w-]+$/.test(id)) return;
  await fs.rm(path.join(DIRS.conversations, `${id}.json`), { force: true });
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
  return meta;
}

export async function loadFile(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  try {
    const meta = JSON.parse(await fs.readFile(path.join(DIRS.files, `${id}.json`), 'utf8'));
    const buffer = await fs.readFile(path.join(DIRS.files, `${id}.bin`));
    return { meta, buffer };
  } catch {
    return null;
  }
}
