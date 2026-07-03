// Hierarchical long-term memory — the register.
//
// Every fact lives at a path ("privatleben/familie/kind", "preferences/format",
// "work/projects/maestro"); the register differentiates over time: crowded
// branches get flagged and facts migrate to more specific subpaths.
//
// Token economics, the whole point of this module:
//   - Every prompt gets only a compact OUTLINE of the register (adaptive: while
//     the register is small the outline IS the full content, so no tool round
//     is ever wasted; past the budget it collapses to branch summaries).
//   - Details are pulled on demand via memory_read/memory_search tools.
//   - Writes happen the moment an agent learns a durable fact (memory_write),
//     not just in the post-run extraction pass.

import { getMemoriesSync, updateMemories, touchMemories } from './store.js';
import { normPath } from './util.js';

const CROWDED_AT = 7; // direct entries on one branch before we push for a split
const OUTLINE_BUDGET = 1600; // chars of register injected into prompts
const FACT_CAP = 48; // chars per fact once the outline must compress

const label = (p) => (p ? p : '(root)');
const oneLine = (t) => String(t || '').replace(/\s+/g, ' ').trim();

function grouped(mems) {
  const groups = new Map();
  for (const m of mems) {
    const p = m.path || '';
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(m);
  }
  return groups;
}

function branchLine(p, entries, factCap) {
  const texts = entries
    .map((m) => (factCap ? (oneLine(m.text).length > factCap ? oneLine(m.text).slice(0, factCap) + '…' : oneLine(m.text)) : oneLine(m.text)))
    .join(' · ');
  const crowd = entries.length >= CROWDED_AT ? `  ⚠ crowded (${entries.length}) — differentiate into subpaths` : '';
  return `- ${label(p)}: ${texts}${crowd}`;
}

// The register outline for prompt injection. Adaptive: full facts while they
// fit the budget, hard-truncated facts + dropped-branch summary beyond it.
export function memoryBriefing({ maxChars = OUTLINE_BUDGET } = {}) {
  const mems = getMemoriesSync();
  if (!mems.length) return '';
  const groups = grouped(mems);
  const paths = [...groups.keys()].sort();
  const header = '## Long-term memory register (apply when relevant, without announcing it)';

  const full = paths.map((p) => branchLine(p, groups.get(p))).join('\n');
  if (full.length <= maxChars) return `${header}\n${full}`;

  // Over budget: recently touched branches win, everything else collapses.
  const recency = (entries) => Math.max(...entries.map((m) => m.usedAt || m.updatedAt || m.ts || 0));
  const byRecency = [...groups.keys()].sort((a, b) => recency(groups.get(b)) - recency(groups.get(a)));
  const kept = [];
  const dropped = [];
  let used = header.length;
  for (const p of byRecency) {
    const line = branchLine(p, groups.get(p), FACT_CAP);
    if (used + line.length > maxChars) {
      dropped.push(`${label(p)} (${groups.get(p).length})`);
      continue;
    }
    kept.push([p, line]);
    used += line.length + 1;
  }
  kept.sort((a, b) => a[0].localeCompare(b[0]));
  const lines = kept.map(([, l]) => l);
  if (dropped.length) lines.push(`- …more branches: ${dropped.join(', ')} — memory_read(path) fetches them.`);
  return `${header}\n${lines.join('\n')}`;
}

// The register rendered WITH ids, for the post-run extractor (it needs ids to
// remove/move entries) — and nothing else, so it stays cheap.
export function memoryRegisterWithIds() {
  const mems = getMemoriesSync();
  if (!mems.length) return '(register is empty)';
  const groups = grouped(mems);
  const lines = [];
  for (const p of [...groups.keys()].sort()) {
    const entries = groups.get(p);
    const crowd = entries.length >= CROWDED_AT ? `  ⚠ crowded — move entries to more specific subpaths` : '';
    lines.push(`${label(p)}/${crowd}`);
    for (const m of entries) lines.push(`  - [${m.id}] ${oneLine(m.text)}`);
  }
  return lines.join('\n');
}

// Keyword search over path + text. No embeddings — at register scale (a few
// hundred entries) scored substring match is both sufficient and debuggable.
export function searchMemories(query, limit = 12) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
  if (!terms.length) return [];
  const scored = [];
  for (const m of getMemoriesSync()) {
    const p = (m.path || '').toLowerCase();
    const t = (m.text || '').toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (p.includes(term)) score += 2;
      if (t.includes(term)) score += 3;
    }
    if (score > 0) scored.push([score, m]);
  }
  scored.sort((a, b) => b[0] - a[0] || (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  return scored.slice(0, limit).map(([, m]) => m);
}

// --- the tool surface every agent gets ---------------------------------------

export const MEMORY_TOOL_NAMES = new Set(['memory_search', 'memory_read', 'memory_write', 'memory_forget']);

export function memoryToolDefs() {
  return [
    {
      type: 'function',
      function: {
        name: 'memory_search',
        description:
          'Search the long-term memory register (durable facts about the user, their preferences, projects, life). Use before asking or assuming anything the user may have told Maestro before.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Keywords, e.g. "birthday daughter" or "tech stack"' } },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'memory_read',
        description:
          'Read all memory entries under a register path (including subpaths), e.g. "work/projects" or "privatleben/familie". Empty path reads the whole register.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Register path, "" for everything' } },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'memory_write',
        description:
          'Store ONE durable fact in the register the moment you learn it (standing preference, personal fact, ongoing project). Choose the most specific sensible path — new subpaths are created automatically. Never store secrets, one-off task details, or world knowledge.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Register path, e.g. "privatleben/familie/kind" or "preferences/format"' },
            text: { type: 'string', description: 'One concise sentence stating the fact' },
            type: { type: 'string', enum: ['user', 'preference', 'project'], description: 'Kind of fact' },
          },
          required: ['path', 'text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'memory_forget',
        description: 'Delete a memory entry by id (from memory_read/memory_search output) when the user retracts it or it is proven wrong.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'The entry id, e.g. "m_ab12cd"' } },
          required: ['id'],
        },
      },
    },
  ];
}

export async function execMemoryTool(name, args = {}) {
  switch (name) {
    case 'memory_search': {
      const hits = searchMemories(args.query);
      if (!hits.length) {
        const outline = memoryBriefing({ maxChars: 700 });
        return `No matching memories.${outline ? `\n${outline}` : ' The register is empty.'}`;
      }
      touchMemories(hits.map((m) => m.id));
      return hits.map((m) => `[${m.id}] ${label(m.path)} — ${m.text}`).join('\n');
    }
    case 'memory_read': {
      const p = normPath(args.path);
      const all = getMemoriesSync().filter((m) => !p || m.path === p || (m.path || '').startsWith(`${p}/`));
      if (!all.length) {
        const outline = memoryBriefing({ maxChars: 700 });
        return `No entries under "${label(p)}".${outline ? `\n${outline}` : ''}`;
      }
      touchMemories(all.map((m) => m.id));
      return all
        .slice(0, 60)
        .map((m) => `[${m.id}] ${label(m.path)} — ${m.text}`)
        .join('\n');
    }
    case 'memory_write': {
      const text = oneLine(args.text).slice(0, 300);
      if (!text) throw new Error('text required');
      const before = getMemoriesSync().length;
      await updateMemories({ add: [{ path: args.path, text, type: args.type }] });
      const stored = getMemoriesSync().length > before;
      return stored
        ? `Remembered under "${label(normPath(args.path))}": ${text}`
        : `Already known (duplicate) — nothing stored.`;
    }
    case 'memory_forget': {
      const id = String(args.id || '').trim();
      if (!id) throw new Error('id required');
      await updateMemories({ remove: [id] });
      return `Forgot ${id}.`;
    }
    default:
      throw new Error(`unknown memory tool: ${name}`);
  }
}
