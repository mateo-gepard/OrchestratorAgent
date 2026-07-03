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

// Pull a balanced JSON object out of model output. Tolerates code fences,
// preamble/trailing commentary, doubled fences, and the JSON defects models
// actually emit (raw newlines/tabs inside strings, trailing commas). Returns
// the LARGEST object that parses — the intended top-level object, never a
// nested fragment. (An earlier version returned the first parseable {…}, so a
// malformed outer object made it silently fall through to an inner node object,
// which then looked like a plan with "no task nodes".)
export function extractJson(text) {
  if (!text) throw new Error('empty response');

  // Candidate regions: every fenced block first (a model may wrap its whole
  // answer in an outer fence and nest ```json inside, so a single fence can be
  // empty or decorative), then the raw text as a fallback.
  const candidates = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(text))) {
    if (m[1] && m[1].trim()) candidates.push(m[1]);
  }
  candidates.push(text);

  for (const source of candidates) {
    const objects = [];
    let start = source.indexOf('{');
    while (start !== -1) {
      const slice = balancedSlice(source, start);
      if (slice) {
        const parsed = tryParseJson(slice);
        if (parsed !== undefined) {
          objects.push({ len: slice.length, value: parsed });
          // The whole object parsed — skip its interior so nested objects don't
          // compete with (and can't be mistaken for) their container.
          start = source.indexOf('{', start + slice.length);
          continue;
        }
      }
      start = source.indexOf('{', start + 1);
    }
    if (objects.length) {
      objects.sort((a, b) => b.len - a.len);
      return objects[0].value;
    }
  }
  throw new Error('no parseable JSON object found in model output');
}

// Strict parse, then one lenient repair pass for the defects models emit.
function tryParseJson(slice) {
  try {
    return JSON.parse(slice);
  } catch {
    /* try repair */
  }
  const repaired = repairJson(slice);
  if (repaired !== slice) {
    try {
      return JSON.parse(repaired);
    } catch {
      /* give up on this slice */
    }
  }
  return undefined;
}

// The only characters JSON permits after a backslash inside a string.
const JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

// Escape raw control characters that appear INSIDE string values (models often
// write multi-line text with real newlines instead of \n), repair invalid
// backslash escapes, and strip trailing commas. Structural characters outside
// strings are left untouched.
function repairJson(s) {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      const next = s[i + 1];
      if (inString && JSON_ESCAPES.has(next)) {
        // A real escape — copy the pair through untouched (and don't let the
        // escaped char, e.g. \", toggle the in-string state).
        out += ch + next;
        i++;
      } else if (inString) {
        // A backslash the model failed to escape ("Leitzinsen und\Eventuell",
        // a Windows path, a trailing "\"). Double it into a literal backslash
        // so the string parses instead of blowing up JSON.parse.
        out += '\\\\';
      } else {
        // Backslashes don't occur outside strings in valid JSON; leave as-is.
        out += ch;
      }
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += ch;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
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
