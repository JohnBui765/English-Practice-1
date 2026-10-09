// Fill-in-the-blank sentences written by the Claude app ("route B"): build the
// prompt the learner pastes into Claude, read Claude's JSON reply back, and
// find word forms inside sentences. Pure: no DOM access.

import { plural, uid } from './util.js';
import { normalizeAnswer, tokenizeWords } from './text.js';

// ---------------------------------------------------------------------------
// Word forms

// "base form form/form ...". Only forms the regular rules below cannot make.
// Compounds (undertake, overcome, misunderstand, chairman) match through
// their last part, so they are not listed.
const IRREGULAR_VERBS = `
arise arose arisen, awake awoke awoken, be am/is/are/was/were been, bear bore borne/born,
beat beat beaten, begin began begun, bend bent, bet bet, bid bid, bind bound, bite bit bitten,
bleed bled, blow blew blown, break broke broken, breed bred, bring brought, build built,
burn burnt, burst burst, buy bought, cast cast, catch caught, choose chose chosen, cling clung,
come came, cost cost, creep crept, cut cut, deal dealt, dig dug, dive dove, do did done,
draw drew drawn, dream dreamt, drink drank drunk, drive drove driven, dwell dwelt, eat ate eaten,
fall fell fallen, feed fed, feel felt, fight fought, find found, flee fled, fling flung,
fly flew flown, forbid forbade forbidden, forsake forsook forsaken, freeze froze frozen,
get got gotten, give gave given, go went gone, grind ground, grow grew grown, hang hung,
have has/had, hear heard, hide hid hidden, hit hit, hold held, hurt hurt, keep kept,
kneel knelt, know knew known, lay laid, lead led, lean leant, leap leapt, learn learnt,
leave left, lend lent, let let, lie lay lain, light lit, lose lost, make made, mean meant,
meet met, pay paid, prove proven, put put, quit quit, read read, rid rid, ride rode ridden,
ring rang rung, rise rose risen, run ran, say said, see saw seen, seek sought, sell sold,
send sent, set set, sew sewn, shake shook shaken, shed shed, shine shone, shoot shot,
show shown, shrink shrank shrunk, shut shut, sing sang sung, sink sank sunk, sit sat,
slay slew slain, sleep slept, slide slid, sling slung, slit slit, smell smelt, sow sown,
speak spoke spoken, speed sped, spell spelt, spend spent, spill spilt, spin spun, spit spat,
split split, spoil spoilt, spread spread, spring sprang sprung, stand stood, steal stole stolen,
stick stuck, sting stung, stink stank stunk, stride strode stridden, strike struck stricken,
string strung, strive strove striven, swear swore sworn, sweep swept, swell swollen,
swim swam swum, swing swung, take took taken, teach taught, tear tore torn, tell told,
think thought, throw threw thrown, thrust thrust, tread trod trodden, wake woke woken,
wear wore worn, weave wove woven, weep wept, wet wet, win won, wind wound, wring wrung,
write wrote written`;

const IRREGULAR_OTHERS = `
man men, woman women, child children, person people, foot feet, tooth teeth, goose geese,
mouse mice, louse lice, ox oxen, die dice, penny pence, phenomenon phenomena,
criterion criteria, datum data, medium media, bacterium bacteria, curriculum curricula,
stratum strata, memorandum memoranda, millennium millennia, stimulus stimuli, fungus fungi,
cactus cacti, nucleus nuclei, radius radii, syllabus syllabi, focus foci, alumnus alumni,
formula formulae, antenna antennae, larva larvae, vertebra vertebrae, index indices,
appendix appendices, matrix matrices, vertex vertices, spectrum spectra, consortium consortia,
referendum referenda, symposium symposia, maximum maxima, minimum minima, optimum optima,
quantum quanta, addendum addenda, corpus corpora, genus genera, locus loci, schema schemata,
automaton automata, alga algae, nebula nebulae, good better best, bad worse worst,
well better best, far farther/further farthest/furthest, little less least, many more most,
much more most`;

const IRREGULAR = buildIrregular(IRREGULAR_VERBS + ',' + IRREGULAR_OTHERS);

function buildIrregular(table) {
  const map = new Map();
  for (const entry of table.split(',')) {
    const [base, ...forms] = entry.trim().split(/\s+/);
    if (!base) continue;
    const known = map.get(base) ?? [];
    map.set(base, known.concat(forms.flatMap((f) => f.split('/'))));
  }
  return map;
}

// Forms made by regular English spelling rules.
function regularForms(b) {
  const out = [b];
  for (const suffix of ['s', 'es', 'ed', 'd', 'ing', 'er', 'est', 'ly']) out.push(b + suffix);
  const stem = b.slice(0, -1);
  if (b.endsWith('e')) out.push(stem + 'ing', stem + 'er', stem + 'est', stem + 'ly'); // make → making
  if (b.endsWith('ie')) out.push(b.slice(0, -2) + 'ying'); // die → dying
  if (b.endsWith('le')) out.push(stem + 'y'); // simple → simply
  if (b.endsWith('ll')) out.push(b + 'y'); // full → fully
  if (b.endsWith('y')) {
    for (const suffix of ['es', 'ed', 'er', 'est', 'ly']) out.push(stem + 'i' + suffix); // study → studied
  }
  if (b.endsWith('fe')) out.push(b.slice(0, -2) + 'ves'); // knife → knives
  else if (b.endsWith('f')) out.push(stem + 'ves'); // leaf → leaves
  if (b.endsWith('is')) out.push(b.slice(0, -2) + 'es'); // crisis → crises
  if (b.endsWith('ic')) {
    for (const suffix of ['ked', 'king', 'ker']) out.push(b + suffix); // panic → panicked
    out.push(b + 'ally'); // basic → basically
  }
  if (/[aeiou][bcdfgklmnprstvz]$/.test(b)) {
    const last = b.at(-1);
    for (const suffix of ['ed', 'ing', 'er', 'est', 'es']) out.push(b + last + suffix); // acquit → acquitted
  }
  return out;
}

// Irregular forms of the word itself or of its last part (with a prefix of
// at least two letters: under+take, over+come, misunder+stand, chair+man).
function irregularForms(b) {
  const out = [...(IRREGULAR.get(b) ?? [])];
  for (const [base, forms] of IRREGULAR) {
    const prefixLength = b.length - base.length;
    if (prefixLength >= 2 && b.endsWith(base)) {
      const prefix = b.slice(0, prefixLength);
      for (const form of forms) out.push(prefix + form);
    }
  }
  return out;
}

const formCache = new Map();

function inflections(base) {
  let forms = formCache.get(base);
  if (!forms) {
    if (formCache.size > 2000) formCache.clear();
    forms = new Set([...regularForms(base), ...irregularForms(base)]);
    formCache.set(base, forms);
  }
  return forms;
}

function normalizeForm(s) {
  return normalizeAnswer(s, { ignoreAccents: true });
}

// level-headed → level-headedly; mother-in-law → mothers-in-law.
function hyphenMatches(form, base) {
  const f = form.split('-');
  const b = base.split('-');
  if (f.length !== b.length) return false;
  const othersEqual = (skip) => b.every((part, i) => i === skip || part === f[i]);
  const last = b.length - 1;
  return (othersEqual(last) && inflections(b[last]).has(f[last]))
    || (othersEqual(0) && inflections(b[0]).has(f[0]));
}

// One normalised token against one normalised headword token.
function wordMatches(form, base) {
  if (!form || !base) return false;
  if (form === base || inflections(base).has(form)) return true;
  if (form.endsWith("'s")) return wordMatches(form.slice(0, -2), base); // possessive
  if (form.endsWith("'")) return wordMatches(form.slice(0, -1), base);
  return base.includes('-') && hyphenMatches(form, base);
}

const PLACEHOLDER_WORDS = [
  "someone's", "somebody's", "one's", "sb's", "sth's", 'someone', 'somebody', 'something',
  'oneself', 'smth', 'smb', 'sth', 'sb',
];
const PLACEHOLDER_ALT = `(?:${PLACEHOLDER_WORDS.join('|')})`;
// A placeholder, or several joined by slashes ("sb/sth").
const PLACEHOLDERS = new RegExp(
  `(?<![\\p{L}\\p{N}'])${PLACEHOLDER_ALT}(?:\\s*/\\s*${PLACEHOLDER_ALT})*(?![\\p{L}\\p{N}'])`,
  'gu',
);

// A phrase may be written with or without these first words, e.g. "to acquit",
// "a far cry from", and "be keen on" in "She's [[keen on]] jazz".
const OPTIONAL_FIRST = new Set(['to', 'be', 'a', 'an', 'the']);
const MAX_COMBOS = 32;

// "colour / color" → colour, color. A slash between words swaps single words:
// "be/get used to" → be used to, get used to (never "be" alone);
// "look after/for" → look after, look for. Whole phrases on both sides of a
// slash ("kind of/sort of", "in spite of / despite") are kept as they are.
function slashAlternatives(raw) {
  if (!raw.includes('/')) return [raw];
  // A slash with a space on one side only counts as a tight slash.
  const s = raw.replace(/\s*\/\s*/g, (m) => (m.length > 2 && /^\s/.test(m) && /\s$/.test(m) ? ' / ' : '/'));
  const out = new Set();
  const spacedSides = s.split(/\s+\/\s+/);
  for (const side of spacedSides) {
    let combos = [''];
    for (const chunk of side.split(' ')) {
      const options = chunk.split('/').filter(Boolean);
      if (options.length) combos = combos.flatMap((c) => options.map((o) => `${c} ${o}`)).slice(0, MAX_COMBOS);
    }
    combos.forEach((c) => out.add(c.trim()));
  }
  const sides = s.split('/').map((side) => side.trim()).filter(Boolean);
  const lengths = sides.map((side) => side.split(' ').length);
  const sameShape = lengths.every((n) => n > 1) || lengths.every((n) => n === 1);
  if (spacedSides.length > 1 || sameShape) sides.forEach((side) => out.add(side));
  return [...out];
}

const headwordCache = new Map();

// Headword → list of token arrays to try. "accuse (sb) of (sth)" → [accuse, of];
// "(be) fed up with" → [fed, up, with] and [be, fed, up, with];
// "colour / color" → [colour] and [color]; "to acquit" → also [acquit].
function headwordVariants(word) {
  const raw = String(word ?? '');
  let variants = headwordCache.get(raw);
  if (variants) return variants;
  const noBrackets = raw.replace(/\[[^\]]*\]/g, ' ');
  const shapes = [noBrackets.replace(/\([^)]*\)/g, ' '), noBrackets.replace(/[()]/g, ' ')];
  const seen = new Set();
  variants = [];
  const add = (tokens) => {
    const key = tokens.join(' ');
    if (tokens.length && !seen.has(key)) {
      seen.add(key);
      variants.push(tokens);
    }
  };
  for (const shape of shapes) {
    const normalized = normalizeForm(shape);
    const cleaned = normalizeForm(normalized.replace(PLACEHOLDERS, ' ')) || normalized;
    for (const alternative of slashAlternatives(cleaned)) {
      const tokens = tokenizeWords(alternative).map((t) => t.word);
      add(tokens);
      if (tokens.length > 1 && OPTIONAL_FIRST.has(tokens[0])) add(tokens.slice(1));
    }
  }
  if (headwordCache.size > 2000) headwordCache.clear();
  headwordCache.set(raw, variants);
  return variants;
}

// Multi-word headwords: the form starts with the first word (maybe inflected)
// and ends with the last one; the middle words follow in order, possibly with
// other words in between ("took it for granted", not "came up with a plan").
function phraseMatches(form, words) {
  if (words.length === 1) return !/\s/.test(form) && wordMatches(form, words[0]);
  const tokens = tokenizeWords(form).map((t) => t.word);
  const last = tokens.length - 1;
  if (last < 1 || !wordMatches(tokens[last], words.at(-1))) return false;
  return phraseEnd(tokens, 0, words.slice(0, -1), last) >= 0;
}

// Index of the token that ends `words` when it starts at tokens[start], or -1.
// The match must end before `limit`; the shortest match wins.
function phraseEnd(tokens, start, words, limit) {
  if (start >= tokens.length || !wordMatches(tokens[start], words[0])) return -1;
  let j = start;
  for (const word of words.slice(1)) {
    j++;
    while (j < limit && !wordMatches(tokens[j], word)) j++;
    if (j >= limit) return -1;
  }
  return j;
}

export function formMatchesWord(form, word) {
  const f = normalizeForm(form);
  if (!f) return false;
  return headwordVariants(word).some((words) => phraseMatches(f, words));
}

const MAX_GAP = 6; // other words allowed inside a phrase when auto-bracketing

// Wraps the first run of tokens that is a form of `word` in [[ ]]. At one
// start, longer variants win ("gets on with" before "gets on").
function bracketFirstForm(text, word) {
  const variants = [...headwordVariants(word)].sort((a, b) => b.length - a.length);
  const tokens = tokenizeWords(text);
  const forms = tokens.map((t) => normalizeForm(t.word));
  for (let i = 0; i < tokens.length; i++) {
    for (const words of variants) {
      const limit = Math.min(tokens.length, i + words.length + MAX_GAP);
      const end = phraseEnd(forms, i, words, limit);
      if (end >= 0) {
        const form = text.slice(tokens[i].start, tokens[end].end);
        return { text: `${text.slice(0, tokens[i].start)}[[${form}]]${text.slice(tokens[end].end)}`, answer: form };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sentence text

// The content cannot contain [ or ], which also keeps matching linear on
// text full of unclosed "[[".
const BRACKET = /\[\[([^[\]]*)\]\]/;
const BRACKETS = /\[\[([^[\]]*)\]\]/g;
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060]/g; // soft hyphen, zero-width chars

export function clozeParts(text) {
  const s = String(text ?? '');
  const m = BRACKET.exec(s);
  if (!m || !m[1].trim()) return null;
  return { before: s.slice(0, m.index), answer: m[1].trim(), after: s.slice(m.index + m[0].length) };
}

const OPEN_PUNCT = '("“‘\'';
const CLOSE_PUNCT = '.,;:!?)"”’\'…';

// "[[ acquitted, ]]" → "[[acquitted]]," (edge punctuation moves outside);
// an empty "[[ ]]" is dropped.
function tidyBracket(inner) {
  const s = inner.trim();
  let start = 0;
  let end = s.length;
  while (start < end && OPEN_PUNCT.includes(s[start])) start++;
  while (end > start && CLOSE_PUNCT.includes(s[end - 1])) end--;
  const core = s.slice(start, end).trim();
  return core ? `${s.slice(0, start)}[[${core}]]${s.slice(end)}` : s;
}

// Plain text: NFC (so NFD-decomposed accents compare and tokenise like typed
// ones), no invisible characters, single spaces.
function tidyPlain(s) {
  return String(s ?? '').normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

function tidyText(s) {
  const text = tidyPlain(s)
    .replace(/\[{3,}/g, '[[')
    .replace(/\]{3,}/g, ']]')
    .replace(BRACKETS, (_, inner) => tidyBracket(inner));
  return tidyPlain(text);
}

function stripBrackets(s) {
  return String(s ?? '').replace(BRACKETS, '$1');
}

// Keeps the first [[ ]] and unwraps any later ones.
function keepFirstBracket(text) {
  let first = true;
  return text.replace(BRACKETS, (whole, inner) => {
    if (!first) return inner;
    first = false;
    return whole;
  });
}

function dedupeKey(text) {
  return tidyPlain(stripBrackets(text)).toLowerCase();
}

// ---------------------------------------------------------------------------
// List helpers

function senseCount(item) {
  return Math.max(1, item?.senses?.length ?? 0);
}

const pairKey = (itemId, sense) => `${itemId}#${sense}`;

function allPairs(items) {
  return items.flatMap((item) => Array.from({ length: senseCount(item) }, (_, sense) => ({ itemId: item.id, sense })));
}

function coveredKeys(sentences) {
  return new Set((sentences ?? []).map((s) => pairKey(s.itemId, s.sense)));
}

export function coverage(list) {
  const pairs = allPairs(list?.items ?? []);
  const covered = coveredKeys(list?.sentences);
  const missing = pairs.filter((p) => !covered.has(pairKey(p.itemId, p.sense)));
  return { total: pairs.length, covered: pairs.length - missing.length, missing };
}

// ---------------------------------------------------------------------------
// buildPrompt

// [{ item, w, senses: number[] }] for the meanings to ask for. Word numbers
// stay index + 1 even when `only` picks a subset.
function requestedWords(items, only) {
  let wanted = null;
  if (Array.isArray(only)) {
    wanted = new Set(only.map((o) => (o.sense == null ? `${o.itemId}#*` : pairKey(o.itemId, o.sense))));
  }
  const out = [];
  items.forEach((item, index) => {
    const senses = Array.from({ length: senseCount(item) }, (_, s) => s)
      .filter((s) => !wanted || wanted.has(pairKey(item.id, s)) || wanted.has(`${item.id}#*`));
    if (senses.length) out.push({ item, w: index + 1, senses });
  });
  return out;
}

function isPhrase(word) {
  return headwordVariants(word).some((tokens) => tokens.length > 1);
}

function senseLine(item, s) {
  const meaning = String(item.senses?.[s] ?? '').trim().replace(/\.$/, '');
  return `   ${s + 1}) ${meaning || '(the most common meaning)'}`;
}

function wordBlock({ item, w, senses }) {
  const lines = [`${w}. ${item.word}${item.pos ? ` (${item.pos})` : ''}`];
  for (const s of senses) lines.push(senseLine(item, s));
  const synonyms = (item.synonyms || []).map((x) => String(x).trim()).filter(Boolean);
  if (synonyms.length) lines.push(`   Similar to: ${synonyms.join(', ')}`);
  const context = stripBrackets(item.context).replace(/\s+/g, ' ').trim();
  if (context) lines.push(`   Seen in: “${context}”`);
  return lines.join('\n');
}

const MAX_FRESH = 40;

function existingSentences(list, requested) {
  const wanted = new Set(requested.flatMap(({ item, senses }) => senses.map((s) => pairKey(item.id, s))));
  return (list.sentences ?? [])
    .filter((s) => s.origin === 'ai' && wanted.has(pairKey(s.itemId, s.sense)))
    .slice(-MAX_FRESH)
    .map((s) => `- ${stripBrackets(s.text).replace(/\s+/g, ' ').trim()}`);
}

// Returns '' when there is nothing to ask for.
export function buildPrompt(list, { sentencesPerSense = 1, level = 'B2', fresh = false, only = null } = {}) {
  const requested = requestedWords(list?.items ?? [], only);
  const meanings = requested.reduce((n, r) => n + r.senses.length, 0);
  if (!meanings) return '';
  const per = Math.max(1, Math.round(Number(sentencesPerSense) || 1));
  const source = tidyPlain(list.source);
  const phrases = requested.some(({ item }) => isPhrase(item.word));

  let intro = `I'm a Vietnamese learner of English at about ${level} level. Please help me practise these words in context.`;
  if (source) intro += ` I collected them from: ${source} — where it fits, use similar topics.`;

  let rule3 = '3. Put the target word in double square brackets exactly once, in the form the sentence needs, e.g. [[acquitted]], [[repositories]].';
  if (phrases) rule3 += ' For a phrase, bracket the whole phrase, including any words that come between its parts, e.g. [[took it for granted]].';

  let rule6 = '6. Reply with ONLY one JSON code block in exactly this format, where "w" is the word number and "s" the meaning number';
  if (per > 1) rule6 += ` (one object per sentence, so each meaning gets ${per} objects with the same "w" and "s")`;
  rule6 += ':';

  const lines = [
    intro,
    '',
    `Write fill-in-the-blank sentences: ${plural(per, 'sentence')} for EACH numbered meaning of each word below (${plural(meanings * per, 'sentence')} in total).`,
    '',
    'Rules:',
    '1. Each sentence must clearly use the word in that specific meaning.',
    `2. Natural, modern English at ${level} level, 12–25 words. Vary the situations (work, news, science, daily life, culture...).`,
    rule3,
    '4. The context should make the answer guessable: only this word from my list should fit the blank. Do not define or translate the word inside the sentence.',
    '5. "vi" is a natural Vietnamese translation of the whole sentence.',
    rule6,
    '{"sentences":[{"w":1,"s":1,"text":"... [[word]] ...","vi":"..."}]}',
    '',
    'Words:',
    ...requested.map(wordBlock),
  ];

  const existing = fresh ? existingSentences(list, requested) : [];
  if (existing.length) {
    lines.push('', 'These sentences already exist — write NEW ones that are clearly different:', ...existing);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Reading Claude's reply

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

function parseLoose(s) {
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

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function firstDefined(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return undefined;
}

const TEXT_KEYS = ['text', 'sentence'];

// The sentence objects inside a parsed value, or null if it is not a reply.
function sentenceObjects(value) {
  if (Array.isArray(value)) {
    const objects = value.filter(isObject);
    return objects.length || !value.length ? objects : null;
  }
  if (!isObject(value)) return null;
  if (Array.isArray(value.sentences)) return value.sentences.filter(isObject);
  if (firstDefined(value, TEXT_KEYS) !== undefined) return [value];
  const array = Object.values(value).find((v) => Array.isArray(v) && v.some(isObject));
  return array ? array.filter(isObject) : null;
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

// Last resort (JSON Lines, a reply cut off half-way, one broken object):
// every flat {...} that parses on its own.
function salvageObjects(text) {
  const out = [];
  for (const m of text.matchAll(/\{[^{}]*\}/g)) {
    const value = parseLoose(m[0]);
    if (isObject(value) && firstDefined(value, TEXT_KEYS) !== undefined) out.push(value);
  }
  return out;
}

function readChunk(chunk) {
  for (const slice of jsonSlices(chunk)) {
    const value = parseLoose(slice);
    const objects = value === undefined ? null : sentenceObjects(value);
    if (objects) return objects;
  }
  return null;
}

// Every code block counts: Claude may split a long reply over several blocks,
// or show the format in a block of its own before the real one. When a block
// is broken or left open (a reply cut off, then "continue" pasted after it),
// the whole text is read instead, which salvages every complete object.
function readReplyObjects(text) {
  const blocks = [...text.matchAll(FENCE)].map((m) => readChunk(m[1]));
  const allClosed = (text.match(/```/g) ?? []).length % 2 === 0;
  if (blocks.length && allClosed && blocks.every(Boolean)) return blocks.flat();
  const whole = readChunk(text);
  if (whole) return whole;
  const salvaged = salvageObjects(text);
  return salvaged.length ? salvaged : null;
}

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

// 4, "4", "w4", "4." → 4; with `roman`, "ii" → 2.
function toNumber(v, { roman = false } = {}) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/^[ws#]\s*(?=\d)/, '').replace(/[.)]$/, '');
  if (/^\d+$/.test(s)) return Number(s);
  return roman ? ROMAN[s] ?? null : null;
}

// Word number, or the word itself ("word": "acquit").
function resolveItem(raw, items) {
  const n = toNumber(raw);
  if (n !== null) return { index: n - 1, item: items[n - 1] ?? null, label: String(n) };
  if (typeof raw === 'string' && raw.trim()) {
    const key = normalizeForm(raw);
    const index = items.findIndex((item) => normalizeForm(item.word) === key);
    return { index, item: items[index] ?? null, label: index >= 0 ? String(index + 1) : raw.trim() };
  }
  return { index: -1, item: null, label: null };
}

const NOT_READABLE = 'Could not read the reply — copy the whole JSON block from Claude.';

function problemRef(wLabel, sLabel) {
  const parts = [];
  if (wLabel != null) parts.push(`w${wLabel}`);
  if (sLabel != null) parts.push(`s${sLabel}`);
  return parts.join(' ') || null;
}

// The [[answer]] of a sentence → { text, answer } or { reason }. Without
// brackets, the first form of the word in the sentence gets them.
function checkBrackets(text, word) {
  const marks = [...text.matchAll(BRACKETS)];
  if (marks.length > 1) return { reason: 'The sentence has more than one [[ ]].' };
  if (marks.length === 1) {
    const answer = marks[0][1];
    return formMatchesWord(answer, word) ? { text, answer } : { reason: `[[${answer}]] is not a form of "${word}".` };
  }
  const plain = tidyText(text.replace(/[*_[\]]+/g, ''));
  return bracketFirstForm(plain, word) ?? { reason: `"${word}" is not marked with [[ ]] and is not in the sentence.` };
}

// Validates one reply object → { sentence } or { problem }.
function readSentence(obj, items) {
  const rawS = firstDefined(obj, ['s', 'sense', 'meaning']);
  const rawText = firstDefined(obj, TEXT_KEYS);
  const rawVi = firstDefined(obj, ['vi', 'translation']);
  const text = typeof rawText === 'string' ? tidyText(rawText) : '';
  const vi = typeof rawVi === 'string' ? tidyPlain(stripBrackets(rawVi)) : '';

  const { index, item, label } = resolveItem(firstDefined(obj, ['w', 'word']), items);
  let s = toNumber(rawS, { roman: true });
  if (s === null && rawS === undefined && item && senseCount(item) === 1) s = 1;
  const ref = problemRef(label, s ?? rawS);
  const problem = (reason) => ({ problem: { ref, reason, text } });

  if (label === null) return problem('The sentence has no word number ("w").');
  if (!item) return problem(`There is no word number ${label} in this list.`);
  if (s === null && rawS === undefined) {
    return problem(`Missing meaning number ("s") — "${item.word}" has ${senseCount(item)} meanings.`);
  }
  if (s === null) return problem(`"${rawS}" is not a meaning number.`);
  if (s < 1 || s > senseCount(item)) return problem(`Word ${index + 1} (${item.word}) has no meaning number ${s}.`);
  if (!text) return problem('The sentence is empty.');

  const checked = checkBrackets(text, item.word);
  if (checked.reason) return problem(checked.reason);
  return { sentence: { itemId: item.id, sense: s - 1, text: checked.text, answer: checked.answer, vi } };
}

export function parseReply(text, list, { now = Date.now() } = {}) {
  const items = list?.items ?? [];
  const pairs = allPairs(items);
  const raw = String(text ?? '').replace(/\uFEFF/g, '');
  const objects = readReplyObjects(raw);
  if (!objects) {
    return { sentences: [], problems: [{ ref: null, reason: NOT_READABLE }], missing: pairs, duplicates: 0 };
  }

  const seen = new Set((list?.sentences ?? []).map((s) => dedupeKey(s.text)));
  const covered = new Set();
  const sentences = [];
  const problems = [];
  let duplicates = 0;
  for (const obj of objects) {
    const { sentence, problem } = readSentence(obj, items);
    if (problem) {
      problems.push(problem);
      continue;
    }
    covered.add(pairKey(sentence.itemId, sentence.sense));
    const key = dedupeKey(sentence.text);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    sentences.push({ id: uid(), ...sentence, origin: 'ai', createdAt: now });
  }
  const missing = pairs.filter((p) => !covered.has(pairKey(p.itemId, p.sense)));
  return { sentences, problems, missing, duplicates };
}

// ---------------------------------------------------------------------------
// Sentence from the learner's own context

export function sentenceFromContext(item, now = Date.now()) {
  const context = tidyText(item?.context);
  if (!context || !item?.word) return null;
  let cloze = null;
  if (clozeParts(context)) {
    const text = keepFirstBracket(context);
    cloze = { text, answer: clozeParts(text).answer };
  } else {
    cloze = bracketFirstForm(context, item.word);
  }
  if (!cloze) return null;
  return {
    id: uid(), itemId: item.id, sense: 0, text: cloze.text, answer: cloze.answer,
    vi: '', origin: 'user', createdAt: now,
  };
}
