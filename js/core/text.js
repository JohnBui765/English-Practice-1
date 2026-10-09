// Text helpers shared by parsing and grading. Pure: no DOM access.

const QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g; // ‘ ’ ‚ ‛ ′ ` ´
const DQUOTES = /[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g; // “ ” „ ‟ ″ « »
const DASHES = /[\u2010-\u2015\u2212]/g; // ‐ ‑ ‒ – — ― −
// Format characters (soft hyphen, zero-width space/joiners, direction marks, BOM)
// copied from web pages would make a correct answer look wrong.
const INVISIBLE = /\p{Cf}+/gu;
const SPACES = /[\s\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g;
const EDGE = new Set([...' .,;:!?¿¡"\'()[]{}<>…']);

// Trims edge punctuation/spaces with a loop (a regex anchored at $ backtracks
// quadratically on long punctuation runs).
function trimEdges(s) {
  let a = 0;
  let b = s.length;
  while (a < b && EDGE.has(s[a])) a++;
  while (b > a && EDGE.has(s[b - 1])) b--;
  return s.slice(a, b);
}

export function stripAccents(s) {
  return String(s)
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFC');
}

// Canonical form used to compare a typed answer with the expected one.
export function normalizeAnswer(s, { ignoreAccents = false } = {}) {
  let out = String(s ?? '')
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(QUOTES, "'")
    .replace(DQUOTES, '"')
    .replace(DASHES, '-')
    .replace(SPACES, ' ')
    .toLowerCase();
  out = trimEdges(out);
  if (ignoreAccents) out = stripAccents(out);
  return out;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Words made of letters/digits, allowing inner apostrophes and hyphens
// ("don't", "level-headed", "rock'n'roll").
const WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

export function tokenizeWords(s) {
  const out = [];
  const text = String(s ?? '');
  for (const m of text.matchAll(WORD)) {
    out.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function wordCount(s) {
  return tokenizeWords(s).length;
}

// Part-of-speech aliases → canonical abbreviation stored in VocabItem.pos.
const POS_ALIASES = new Map(Object.entries({
  n: 'n', noun: 'n', nouns: 'n', 'n.': 'n', 'danh từ': 'n',
  v: 'v', verb: 'v', verbs: 'v', 'v.': 'v', vt: 'v', vi: 'v', 'động từ': 'v',
  adj: 'adj', 'adj.': 'adj', adjective: 'adj', a: 'adj', 'tính từ': 'adj',
  adv: 'adv', 'adv.': 'adv', adverb: 'adv', 'trạng từ': 'adv',
  prep: 'prep', preposition: 'prep', 'giới từ': 'prep',
  conj: 'conj', conjunction: 'conj', 'liên từ': 'conj',
  pron: 'pron', pronoun: 'pron', 'đại từ': 'pron',
  det: 'det', determiner: 'det',
  int: 'interj', interj: 'interj', interjection: 'interj', excl: 'interj', exclamation: 'interj',
  phr: 'phr', phrase: 'phr', 'n phr': 'n phr', 'noun phrase': 'n phr',
  'phr v': 'phr v', 'phr. v': 'phr v', 'phr.v': 'phr v', 'phrv': 'phr v', 'phrasal verb': 'phr v', 'phrasal v': 'phr v',
  idiom: 'idiom', idm: 'idiom', collocation: 'collocation', coll: 'collocation',
  'v phr': 'v phr', 'verb phrase': 'v phr', 'adj phr': 'adj phr', 'adv phr': 'adv phr',
  'prep phr': 'prep phr', expression: 'expr', expr: 'expr', 'modal v': 'modal v', modal: 'modal v',
}));

const POS_LABELS = {
  n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', prep: 'preposition',
  conj: 'conjunction', pron: 'pronoun', det: 'determiner', interj: 'interjection',
  phr: 'phrase', 'n phr': 'noun phrase', 'phr v': 'phrasal verb', idiom: 'idiom',
  collocation: 'collocation', 'v phr': 'verb phrase', 'adj phr': 'adjective phrase',
  'adv phr': 'adverb phrase', 'prep phr': 'prepositional phrase', expr: 'expression',
  'modal v': 'modal verb',
};

function posKey(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[\s_]+/g, ' ')
    .replace(/\s*\.\s*/g, '. ')
    .replace(/\.\s*$/, '')
    .replace(/\. /g, ' ')
    .trim();
}

// Returns the canonical abbreviation, or null when `raw` is not a part of speech.
// Combined tags such as "n, v" or "n/v" are kept as "n/v".
export function normalizePos(raw) {
  const key = posKey(raw);
  if (!key) return null;
  if (POS_ALIASES.has(key)) return POS_ALIASES.get(key);
  const parts = key.split(/\s*[,/&]\s*|\s+or\s+/).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => POS_ALIASES.has(p))) {
    return parts.map((p) => POS_ALIASES.get(p)).join('/');
  }
  return null;
}

export function isPos(raw) {
  return normalizePos(raw) !== null;
}

export function posLabel(pos) {
  if (!pos) return '';
  return pos
    .split('/')
    .map((p) => POS_LABELS[p] ?? p)
    .join(' / ');
}
