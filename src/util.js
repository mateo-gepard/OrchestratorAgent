import crypto from 'node:crypto';

export function rid(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('base64url');
}

export function now() {
  return Date.now();
}

export function truncate(text, max) {
  if (!text || text.length <= max) return text || '';
  return text.slice(0, max) + `\n\n[…truncated, ${text.length - max} more characters]`;
}

// Head+tail truncation: keeps the start and the end of long text (structure
// and conclusions live there) and elides the middle.
export function truncateMiddle(text, max) {
  if (!text || text.length <= max) return text || '';
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n[…${text.length - max} characters elided…]\n\n${text.slice(-tail)}`;
}

// Pull the first balanced JSON object out of model output. Tolerates code
// fences, preamble text, and trailing commentary.
export function extractJson(text) {
  if (!text) throw new Error('empty response');
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);

  for (const source of candidates) {
    let start = source.indexOf('{');
    while (start !== -1) {
      const slice = balancedSlice(source, start);
      if (slice) {
        try {
          return JSON.parse(slice);
        } catch {
          // fall through, try the next opening brace
        }
      }
      start = source.indexOf('{', start + 1);
    }
  }
  throw new Error('no parseable JSON object found in model output');
}

function balancedSlice(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Normalize a memory register path: lowercase kebab segments joined by "/",
// e.g. "Privatleben / Familie/Kind " → "privatleben/familie/kind".
export function normPath(raw) {
  return String(raw || '')
    .toLowerCase()
    .split('/')
    .map((s) =>
      s
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{N}_-]+/gu, '')
        .slice(0, 40)
    )
    .filter(Boolean)
    .slice(0, 5)
    .join('/');
}
