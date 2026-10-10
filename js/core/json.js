// Tolerant JSON reading for replies pasted from the Claude app ("route B"):
// code fences, prose around the JSON, smart quotes, trailing commas, raw line
// breaks and stray quotes inside strings, JSON Lines, several code blocks and
// replies cut off half-way. Shared by cloze.js (sentences) and families.js.
// Pure: no DOM access.

const SMART_DQ = /[“”„‟″]/g;
const FENCE = /```[^\n`]*\n?([\s\S]*?)```/g;
// After a closing quote: : } ] the end, or a comma and the next value
// ("He said "no", then left." keeps its inner quotes).
const CLOSES_STRING = /\s*(?:[:}\]]|,\s*(?:["{[\]}\d-]|true\b|false\b|null\b|$)|$)/y;
const TRAILING_COMMA = /\s*[}\]]/y;
const ODD_SPACE = /[\u00A0\u200B\u2028\u2029\uFEFF]/;

// String-aware cleanup: drops trailing commas, turns raw line breaks inside
// strings into spaces and escapes stray inner quotes ("He said "no" ...").
function cleanJson(s) {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') {
        out += c + (s[i + 1] ?? '');
        i++;
      } else if (c === '"') {
        CLOSES_STRING.lastIndex = i + 1;
        if (CLOSES_STRING.test(s)) {
          inString = false;
          out += c;
        } else {
          out += '\\"';
        }
      } else {
        out += c < ' ' ? ' ' : c;
      }
      continue;
    }
    if (c === '"') inString = true;
    if (c === ',') {
      TRAILING_COMMA.lastIndex = i + 1;
      if (TRAILING_COMMA.test(s)) continue;
    }
    out += ODD_SPACE.test(c) ? ' ' : c;
  }
  return out;
}

// Smart quotes used as JSON delimiters (next to { [ , : or before : , } ]).
function fixSmartDelimiters(s) {
  return s
    .replace(/([{[,:]\s*)[“”„‟″]/g, '$1"')
    .replace(/[“”„‟″](\s*[:,}\]])/g, '"$1');
}

// JSON.parse after the repairs above; undefined when nothing works.
export function parseLoose(s) {
  const attempts = new Set([s, fixSmartDelimiters(s), s.replace(SMART_DQ, '"')]);
  for (const attempt of attempts) {
    try {
      return JSON.parse(cleanJson(attempt));
    } catch {
      // try the next repair
    }
  }
  return undefined;
}

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The first of `keys` with a value other than undefined, null or ''.
export function firstDefined(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return undefined;
}

// Whole chunk first, then from the first { or [ to the last } or ].
function jsonSlices(chunk) {
  const slices = [chunk.trim()];
  const spans = [['{', '}'], ['[', ']']]
    .map(([open, close]) => [chunk.indexOf(open), chunk.lastIndexOf(close)])
    .filter(([start, end]) => start >= 0 && end > start)
    .sort((a, b) => a[0] - b[0]);
  for (const [start, end] of spans) slices.push(chunk.slice(start, end + 1));
  return slices;
}

function readChunk(chunk, extract) {
  for (const slice of jsonSlices(chunk)) {
    const value = parseLoose(slice);
    const objects = value === undefined ? null : extract(value);
    if (objects) return objects;
  }
  return null;
}

// Last resort for flat records (JSON Lines, a reply cut off half-way, one
// broken object): every {...} without nested braces that parses on its own
// and that `accept` keeps.
export function salvageFlatObjects(text, accept) {
  const out = [];
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    const value = parseLoose(m[0]);
    if (isObject(value) && accept(value)) out.push(value);
  }
  return out;
}

// Records sit near the top ({"families":[{"w":1,...}]}): deeper braces are
// never tried, so a pathological paste cannot make salvaging quadratic.
const MAX_SALVAGE_DEPTH = 3;

// Last resort for nested records ({"w":1,"members":[{...}]}): every balanced
// {...} that parses on its own and that `extract` turns into records. Outer
// objects win; an object that is broken or cut off is searched inside.
// Braces are paired in one pass, so this stays linear-ish on long replies.
export function salvageNestedObjects(text, extract) {
  const close = new Map();
  const depth = new Map();
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      depth.set(i, stack.length);
      stack.push(i);
    } else if (text[i] === '}' && stack.length) close.set(stack.pop(), i);
  }
  const out = [];
  let from = 0;
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    if (i < from || !close.has(i) || depth.get(i) > MAX_SALVAGE_DEPTH) continue;
    const end = close.get(i);
    const value = parseLoose(text.slice(i, end + 1));
    const records = value === undefined ? null : extract(value);
    if (records?.length) {
      out.push(...records);
      from = end + 1;
    }
  }
  return out;
}

// Every code block counts: Claude may split a long reply over several blocks,
// or show the format in a block of its own before the real one. When a block
// is broken or left open (a reply cut off, then "continue" pasted after it),
// the whole text is read instead, and finally `salvage(text)` rescues every
// complete record. `extract(value)` turns one parsed JSON value into an array
// of records, or null when the value is not a reply.
export function readJsonReply(text, { extract, salvage }) {
  const blocks = [...text.matchAll(FENCE)].map((m) => readChunk(m[1], extract));
  const allClosed = (text.match(/```/g) ?? []).length % 2 === 0;
  if (blocks.length && allClosed && blocks.every(Boolean)) return blocks.flat();
  const whole = readChunk(text, extract);
  if (whole) return whole;
  const salvaged = salvage ? salvage(text) : [];
  return salvaged.length ? salvaged : null;
}

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

// 4, "4", "w4", "4." → 4; with `roman`, "ii" → 2.
export function toNumber(v, { roman = false } = {}) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/^[ws#]\s*(?=\d)/, '').replace(/[.)]$/, '');
  if (/^\d+$/.test(s)) return Number(s);
  return roman ? ROMAN[s] ?? null : null;
}
