// Answer checking: typed words, cloze forms and word-by-word dictation diffs.
// Pure: no DOM access.

import { normalizeAnswer, normalizePos, stripAccents, tokenizeWords } from './text.js';

// Soft hyphens, zero-width spaces/joiners, direction marks and BOMs come along
// when text is copied from web pages. They are invisible, so they must never
// change a result.
const INVISIBLE = /\p{Cf}/gu;

function visible(s) {
  return String(s ?? '').replace(INVISIBLE, '');
}

// ---------------------------------------------------------------------------
// Levenshtein

// Edit distance counted in Unicode code points (so "ộ" is one letter, also
// when it arrives decomposed).
export function levenshtein(a, b) {
  const s = Array.from(String(a ?? '').normalize('NFC'));
  const t = Array.from(String(b ?? '').normalize('NFC'));
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[t.length];
}

// ---------------------------------------------------------------------------
// checkWord

const MAX_VARIANTS = 64;

// Learners write placeholders in many ways; compare them in one spelling.
function canonicalPlaceholders(s) {
  return s
    .replace(/\b(?:someone|somebody|smb|sb)\b\.?/g, 'sb')
    .replace(/\b(?:something|smth|sth)\b\.?/g, 'sth');
}

const PLACEHOLDER_WORD = /\b(?:sb|sth|sb's|sth's|oneself|one's)\b/;

// A comma followed by a space never decides an answer: "so far so good"
// matches "so far, so good".
function answerKey(s, ignoreAccents) {
  return canonicalPlaceholders(normalizeAnswer(visible(s), { ignoreAccents })).replace(/\s*,\s+/g, ' ');
}

function isDigitAt(s, i) {
  return /\d/.test(s[i] ?? '');
}

// Splits on `;`, `,` (not inside "1,000"; skipped when `commas` is false) and
// ` / ` (slash next to a space), but only outside parentheses and brackets.
function splitAlternatives(s, { commas = true } = {}) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    if (depth > 0) continue;
    const comma = commas && c === ',' && !(isDigitAt(s, i - 1) && isDigitAt(s, i + 1));
    const spacedSlash = c === '/' && (/\s/.test(s[i - 1] ?? '') || /\s/.test(s[i + 1] ?? ''));
    if (c === ';' || comma || spacedSlash) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

// Index of the ")" matching the "(" at `open`, or -1.
function closingParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

// "accuse (sb) of (sth)" → every combination with each group kept or dropped.
// Groups inside words work too: "colo(u)r" → "colour", "color".
function expandOptional(phrase) {
  const open = phrase.indexOf('(');
  const close = open === -1 ? -1 : closingParen(phrase, open);
  if (close === -1) return [phrase.replace(/[()]/g, ' ')];
  const before = phrase.slice(0, open).replace(/\)/g, ' '); // drop a stray ")"
  const inners = expandOptional(phrase.slice(open + 1, close));
  const out = [];
  for (const rest of expandOptional(phrase.slice(close + 1))) {
    out.push(before + rest);
    for (const inner of inners) out.push(before + inner + rest);
    if (out.length >= MAX_VARIANTS) break;
  }
  return out.slice(0, MAX_VARIANTS);
}

// Particles and function words in parentheses are optional extras
// ("move (over)", "opt (out)"), never another spelling of the word before them.
const PARTICLES = new Set(('a an the to of in on at by for from with without into onto upon up down out '
  + 'off over about above across after against along around away back behind below beside between beyond '
  + 'through under past round toward towards').split(' '));

// "colour (color)": a single word followed by a near-identical spelling in
// parentheses is an alternative, not an optional extra word.
function spellingVariant(phrase) {
  const m = /^\s*([^\s()]+)\s*\(\s*([^\s()]+)\s*\)\s*$/u.exec(phrase);
  if (!m) return null;
  const [, word, variant] = m;
  if (letterCount(variant) < 3 || normalizePos(variant)) return null; // "go (v)"
  if (PARTICLES.has(variant.toLowerCase())) return null;
  if (PLACEHOLDER_WORD.test(canonicalPlaceholders(variant.toLowerCase()))) return null;
  return levenshtein(word.toLowerCase(), variant.toLowerCase()) <= 2 ? variant : null;
}

function isUrlish(token) {
  return /^[a-z][a-z0-9+.-]*:\/\/|^www\.|\.[a-z]{2,}(?:\/|$)/i.test(token);
}

// "look after sb/sth" → "look after sb", "look after sth"; "colour/color" too.
// The piece as written stays valid as well ("and/or", "look after sb/sth").
// A spaced slash only survives splitAlternatives inside parentheses
// ("accuse (sb / sth)"), where it is a word-level choice as well.
function expandSlashes(phrase) {
  let results = [''];
  for (const piece of phrase.replace(/\s*\/\s*/g, '/').split(/(\s+)/)) {
    const splittable = piece.includes('/') && !isUrlish(piece) && !/^\d+\/\d+$/.test(piece);
    const parts = splittable ? piece.split('/').filter(Boolean) : [];
    const options = parts.length > 1 ? [...parts, piece] : parts.length ? parts : [piece];
    const next = [];
    for (const r of results) {
      for (const o of options) if (next.length < MAX_VARIANTS) next.push(r + o);
    }
    results = next;
  }
  return results;
}

function rawVariants(answer) {
  const text = visible(answer);
  // "first come, first served": a comma may belong to the answer itself, so the
  // unsplit phrase is accepted next to the comma-separated alternatives.
  const phrases = new Set([...splitAlternatives(text), ...splitAlternatives(text, { commas: false })]);
  const out = [];
  for (const phrase of phrases) {
    const variant = spellingVariant(phrase);
    if (variant) out.push(variant);
    for (const optional of expandOptional(phrase)) out.push(...expandSlashes(optional));
  }
  return out;
}

// Tolerates raw tags such as "(v)" as well as the normalised "v", "phr v", "n/v".
function isVerbPos(pos) {
  const p = normalizePos(pos) ?? String(pos ?? '').toLowerCase();
  return p.split(/[^\p{L}]+/u).some((t) => t === 'v' || t === 'verb');
}

function withoutTo(key) {
  return /^to\s+\S/.test(key) ? key.replace(/^to\s+/, '') : null;
}

// Letters and digits only, so "a b" counts as a 2-letter answer.
function letterCount(s) {
  return (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

export function checkWord(input, answer, { ignoreAccents = false, pos = '' } = {}) {
  const expected = String(answer ?? '');
  const inputKey = answerKey(input ?? '', ignoreAccents);
  if (!inputKey) return { correct: false, close: false, expected };

  const keys = new Set(rawVariants(expected).map((v) => answerKey(v, ignoreAccents)).filter(Boolean));
  // Without a part of speech, an answer written "to acquit" marks a verb.
  const verbish = isVerbPos(pos)
    || [...keys].some((k) => PLACEHOLDER_WORD.test(k) || (!pos && withoutTo(k) !== null));

  const inputs = new Set([inputKey]);
  if (verbish) {
    for (const k of [...keys]) {
      const bare = withoutTo(k);
      if (bare) keys.add(bare);
    }
    const bareInput = withoutTo(inputKey);
    if (bareInput) inputs.add(bareInput);
  }

  const correct = [...inputs].some((i) => keys.has(i));
  const close = !correct && [...keys].some((k) => {
    const limit = letterCount(k) <= 4 ? 1 : 2;
    return [...inputs].some((i) => levenshtein(i, k) <= limit);
  });
  return { correct, close, expected };
}

// ---------------------------------------------------------------------------
// checkForm

function commonPrefixLength(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

// For typed cloze answers. `lemma` is the list word ("acquit") and `answer`
// the form the sentence needs ("acquitted").
export function checkForm(input, answer, lemma, { ignoreAccents = false } = {}) {
  const norm = (s) => normalizeAnswer(visible(s), { ignoreAccents });
  const typed = norm(input);
  const target = norm(answer);
  if (!typed) return { correct: false, rightWordWrongForm: false };
  if (typed === target) return { correct: true, rightWordWrongForm: false };
  // "to acquit" (typed, or as the list word) names the same word as "acquit".
  const bare = (s) => withoutTo(s) ?? s;
  const word = withoutTo(target) ? typed : bare(typed);
  const base = bare(norm(lemma)) || target;
  const rightWordWrongForm = word === base
    || (commonPrefixLength(word, base) >= 4 && levenshtein(word, target) <= 3);
  return { correct: false, rightWordWrongForm };
}

// ---------------------------------------------------------------------------
// Word alignment (shared by diffWords and similarity)

const LCS_MAX_WORDS = 400;
const LCS_MAX_CELLS = LCS_MAX_WORDS * LCS_MAX_WORDS;
const RESYNC_WINDOW = 50;

// Classic LCS table over a[i0..i1) × b[j0..j1); L[i][j] = LCS of the suffixes.
function lcsAlign(a, b, i0, i1, j0, j1, steps) {
  const n = i1 - i0;
  const m = j1 - j0;
  const w = m + 1;
  const L = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = a[i0 + i] === b[j0 + j]
        ? L[(i + 1) * w + j + 1] + 1
        : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i0 + i] === b[j0 + j]) steps.push(['equal', i0 + i++, j0 + j++]);
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) steps.push(['missing', i0 + i++]);
    else steps.push(['extra', -1, j0 + j++]);
  }
  while (i < n) steps.push(['missing', i0 + i++]);
  while (j < m) steps.push(['extra', -1, j0 + j++]);
}

// Ascending positions of every key in b[j0..j1).
function positionIndex(b, j0, j1) {
  const index = new Map();
  for (let y = j0; y < j1; y++) {
    const list = index.get(b[y]);
    if (list) list.push(y);
    else index.set(b[y], [y]);
  }
  return index;
}

function firstAtOrAfter(list, y) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Nearest point where both sequences agree again (two tokens in a row, or one
// at the very end), looking at most RESYNC_WINDOW tokens ahead on each side.
// Cheapest skipA + skipB wins; at equal cost a 1:1 substitution beats a pure
// insertion/deletion, then the smaller skipA. Only positions where the token
// occurs at all are visited, so unrelated texts stay fast.
function findResync(a, b, i, j, i1, j1, index) {
  let best = null;
  let bestCost = Infinity;
  let bestSkew = Infinity;
  for (let skipA = 0; skipA <= RESYNC_WINDOW && skipA <= bestCost && i + skipA < i1; skipA++) {
    const x = i + skipA;
    const list = index.get(a[x]);
    if (!list) continue;
    for (let k = firstAtOrAfter(list, j); k < list.length; k++) {
      const y = list[k];
      const skipB = y - j;
      const cost = skipA + skipB;
      if (skipB > RESYNC_WINDOW || cost > bestCost) break;
      const skew = Math.abs(skipA - skipB);
      if (cost === bestCost && skew >= bestSkew) continue;
      if (x + 1 >= i1 || y + 1 >= j1 || a[x + 1] === b[y + 1]) {
        best = [skipA, skipB];
        bestCost = cost;
        bestSkew = skew;
      }
    }
  }
  return best;
}

// Linear-ish fallback for very long texts so the UI never freezes.
function greedyAlign(a, b, i, i1, j, j1, steps) {
  const index = positionIndex(b, j, j1);
  while (i < i1 && j < j1) {
    if (a[i] === b[j]) {
      steps.push(['equal', i++, j++]);
      continue;
    }
    const [skipA, skipB] = findResync(a, b, i, j, i1, j1, index) ?? [1, 1];
    for (let k = 0; k < skipA; k++) steps.push(['missing', i++]);
    for (let k = 0; k < skipB; k++) steps.push(['extra', -1, j++]);
  }
  while (i < i1) steps.push(['missing', i++]);
  while (j < j1) steps.push(['extra', -1, j++]);
}

// Aligns two key arrays → steps [type, indexInA, indexInB].
function alignKeys(a, b) {
  const steps = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    steps.push(['equal', start, start]);
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if ((endA - start) * (endB - start) <= LCS_MAX_CELLS) lcsAlign(a, b, start, endA, start, endB, steps);
  else greedyAlign(a, b, start, endA, start, endB, steps);
  for (let k = 0; endA + k < a.length; k++) steps.push(['equal', endA + k, endB + k]);
  return steps;
}

// ---------------------------------------------------------------------------
// diffWords

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
const WHITESPACE = /\s+/;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
const EDGE_MARK = /[\p{P}\p{S}]/u;
// An em dash, "--" or an ellipsis written between two words without spaces
// ("angry\u2014just", "wait...what") separates them. Captures instead of a
// lookbehind, which older iOS Safari cannot parse.
const JOINED = /([^\s\u2014\u2015.\u2026-])(\u2014|\u2015|-{2,}|\u2026|\.{3,})(?=[\p{L}\p{N}\p{Pi}\p{Ps}"'])/gu;

// iOS "smart punctuation" types curly quotes and dashes; never count those.
function unifyPunctuation(s) {
  return s
    .normalize('NFC')
    .replace(/[\u2018\u2019\u201a\u201b\u2032`\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...');
}

function caseSignature(s) {
  return Array.from(s.replace(/[^\p{L}]/gu, ''), (c) => (c === c.toLowerCase() ? 'l' : 'U')).join('');
}

// normalizeAnswer keeps edge dashes and markup ("was\u2014", "**bold**");
// with ignorePunctuation those must go too. A loop, so long runs stay linear.
function trimEdgeMarks(s) {
  let start = 0;
  let end = s.length;
  while (start < end && EDGE_MARK.test(s[start])) start++;
  while (end > start && EDGE_MARK.test(s[end - 1])) end--;
  return s.slice(start, end);
}

function tokenKeyFn({ ignoreCase, ignorePunctuation, ignoreAccents }) {
  if (ignorePunctuation) {
    return (token) => {
      const key = trimEdgeMarks(normalizeAnswer(token, { ignoreAccents }));
      if (!HAS_WORD_CHAR.test(key)) return '';
      return ignoreCase ? key : `${key}|${caseSignature(token)}`;
    };
  }
  return (token) => {
    let key = unifyPunctuation(token);
    if (ignoreCase) key = key.toLowerCase();
    return ignoreAccents ? stripAccents(key) : key;
  };
}

// Whitespace-separated tokens; `breakBefore` marks the first word of a new
// line (any number of blank lines counts as one break).
function displayTokens(text, keyOf) {
  const tokens = [];
  let pendingBreak = false;
  for (const line of visible(text).split(LINE_BREAK)) {
    for (const word of line.replace(JOINED, '$1$2 ').split(WHITESPACE)) {
      if (!word) continue;
      const key = keyOf(word);
      if (!key) continue; // a lone dash or ellipsis: keep any pending break
      tokens.push({ text: word, key, breakBefore: pendingBreak && tokens.length > 0 });
      pendingBreak = false;
    }
    pendingBreak = true;
  }
  return tokens;
}

// Pairs each run of missing words with the neighbouring run of extra words.
function pairChanges(ops) {
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === 'equal') {
      out.push(ops[k++]);
      continue;
    }
    const missing = [];
    const extra = [];
    while (k < ops.length && ops[k].type !== 'equal') {
      (ops[k].type === 'missing' ? missing : extra).push(ops[k]);
      k++;
    }
    const pairs = Math.min(missing.length, extra.length);
    missing.forEach((op, idx) => {
      out.push(idx < pairs ? { ...op, type: 'wrong', actual: extra[idx].actual } : op);
    });
    out.push(...extra.slice(pairs));
  }
  return out;
}

function withBreaks(ops) {
  const out = [];
  for (const { breakBefore, ...op } of ops) {
    if (breakBefore) out.push({ type: 'break' });
    out.push(op);
  }
  return out;
}

export function diffWords(expected, actual, { ignoreCase = true, ignorePunctuation = true, ignoreAccents = false } = {}) {
  const keyOf = tokenKeyFn({ ignoreCase, ignorePunctuation, ignoreAccents });
  const exp = displayTokens(expected, keyOf);
  const act = displayTokens(actual, keyOf);

  const raw = alignKeys(exp.map((t) => t.key), act.map((t) => t.key)).map(([type, i, j]) => {
    if (type === 'equal') return { type, expected: exp[i].text, actual: act[j].text, breakBefore: exp[i].breakBefore };
    if (type === 'missing') return { type, expected: exp[i].text, breakBefore: exp[i].breakBefore };
    return { type, actual: act[j].text };
  });
  const ops = withBreaks(pairChanges(raw));

  let equal = 0;
  let extra = 0;
  let changed = 0;
  for (const op of ops) {
    if (op.type === 'equal') equal++;
    else if (op.type === 'extra') extra++;
    if (op.type !== 'equal' && op.type !== 'break') changed++;
  }
  const denominator = exp.length + extra;
  const score = denominator === 0 ? 1 : Math.round((equal / denominator) * 1000) / 1000;
  return { ops, score, correct: changed === 0 };
}

// ---------------------------------------------------------------------------
// similarity

// Tokenise first, then normalise each word: an em dash separates words (it is
// not a hyphen), and normalizeAnswer never sees a whole long text.
function wordKeys(s, ignoreAccents) {
  const text = unifyPunctuation(visible(s).replace(/[\u2014\u2015]|-{2,}/g, ' '));
  return tokenizeWords(text).map((t) => normalizeAnswer(t.word, { ignoreAccents }));
}

// Dice-style overlap of the word sequences: 2·LCS / (lenA + lenB).
export function similarity(a, b, { ignoreAccents = false } = {}) {
  const x = wordKeys(a, ignoreAccents);
  const y = wordKeys(b, ignoreAccents);
  if (x.length === 0 && y.length === 0) return 1;
  if (x.length === 0 || y.length === 0) return 0;
  const common = alignKeys(x, y).filter(([type]) => type === 'equal').length;
  return (2 * common) / (x.length + y.length);
}
