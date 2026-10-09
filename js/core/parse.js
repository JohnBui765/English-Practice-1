// Turns a pasted list into List items. See docs/architecture.md, "Input formats".
// Pure: no DOM, no storage.

import { uid } from './util.js';
import { normalizePos, tokenizeWords } from './text.js';

const KINDS = ['vocab', 'family', 'passage'];
const KIND_BY_FORMAT = { oneline: 'vocab', block: 'vocab', family: 'family', passage: 'passage' };
const MAX_TITLE_LENGTH = 60;
const MAX_HEAD_WORDS = 6;

const REASON = {
  missingSep: 'No meaning: put ":" between the word and its meaning',
  noWord: 'No word before ":"',
  noMeaning: 'No meaning after the word',
  orphan: 'Not part of any entry',
};

// ---------------------------------------------------------------------------
// Public API

export function detectFormat(text) {
  return detectFromLines(toLines(text).map(classifyLine));
}

export function parseList(text, options = {}) {
  const lines = toLines(text);
  const classes = lines.map(classifyLine);
  const detected = detectFromLines(classes);
  const kind = KINDS.includes(options?.kind) ? options.kind : KIND_BY_FORMAT[detected];

  if (kind === 'passage') return { kind, format: 'passage', ...parsePassages(lines) };
  if (kind === 'family') return { kind, format: 'family', ...parseFamilies(classes) };
  const format = detected === 'block' ? 'block' : 'oneline';
  return { kind, format, ...parseVocab(classes, format) };
}

// ---------------------------------------------------------------------------
// Lines

// U+2028/U+2029 (line/paragraph separator), VT, FF and NEL break lines too.
const LINE_BREAK = /\r\n?|[\u2028\u2029\v\f\u0085]/g;
// Tab, NBSP, figure space, narrow NBSP.
const ODD_SPACE = /[\t\u00A0\u2007\u202F]/g;
// Invisible characters pasted from web pages and chat apps: soft hyphen,
// zero-width space/non-joiner, LRM/RLM, bidi embeddings and isolates, word
// joiner, BOM. Left in place they would hide inside words and answers.
const INVISIBLE = /[\u00AD\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function toLines(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(LINE_BREAK, '\n')
    .replace(ODD_SPACE, ' ')
    .replace(INVISIBLE, '')
    .split('\n');
}

// "1. word ...", "2) word ...", "3/ word ..." (common in Vietnam), also
// "**3. word**" and "## 4. word".
const NUMBERED = /^(?:#{1,6}\s*)?[*_]{0,3}\s*(\d{1,4})\s*([.)/])(?:\s+|(?=[\p{L}*_"“'(]))(\S.*)$/u;
const BULLET = /^([•·*+\-–—])\s*(\S.*)$/u;
const LABEL = /^(?:[•·*+\-–—]\s+)?[*_]*(\p{L}[\p{L} .]{0,29}?)[*_]*\s*[:：]\s*[*_]*\s*(.*)$/u;

const LABEL_FIELDS = new Map([
  ...['definition', 'definitions', 'meaning', 'meanings'].map((k) => [k, 'senses']),
  ...['example', 'examples', 'e.g', 'eg', 'ví dụ', 'vd'].map((k) => [k, 'examples']),
  ...['synonym', 'synonyms', 'syn', 'syns', 'similar'].map((k) => [k, 'synonyms']),
  ...['word family', 'family', 'word forms', 'word form'].map((k) => [k, 'family']),
  ...['ipa', 'pronunciation', 'phonetic', 'phonetics'].map((k) => [k, 'ipa']),
  ...['part of speech', 'pos', 'word class', 'word type', 'loại từ'].map((k) => [k, 'pos']),
  ['context', 'context'],
  // Recognised so their lines do not leak into another field, but not stored.
  ...['antonym', 'antonyms', 'opposite', 'opposites', 'note', 'notes', 'collocation', 'collocations', 'usage']
    .map((k) => [k, 'ignore']),
]);

function labelField(name) {
  const key = name.toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '').trim();
  return LABEL_FIELDS.get(key);
}

// "---", "***", "* * *", "___", "===": a Markdown rule acts like a blank line.
const RULE = /^(?:[-–—_*=~•·]\s*){3,}$/u;

function isBlankLine(line) {
  return !line || RULE.test(line);
}

function classifyLine(raw) {
  const line = raw.trim();
  if (isBlankLine(line)) return { type: 'blank', line };
  let m = NUMBERED.exec(line);
  if (m) return numberedLine(line, m);
  m = LABEL.exec(line);
  const field = m ? labelField(m[1]) : undefined;
  if (field) return { type: 'label', line, field, content: m[2].trim() };
  m = BULLET.exec(line);
  if (m) {
    // "• 1. acquit (v): ..." — the number belongs to the entry, not the word.
    const numbered = NUMBERED.exec(m[2]);
    return numbered ? numberedLine(line, numbered) : { type: 'bullet', line, content: m[2].trim() };
  }
  return { type: 'text', line, content: line };
}

function numberedLine(line, m) {
  return { type: 'numbered', line, n: Number(m[1]), delim: m[2], content: m[3].trim() };
}

// Head/meaning split of a line's content, computed once per line.
function partsOf(cls) {
  cls.parts ??= splitEntry(cls.content);
  return cls.parts;
}

// "#378", "378.", "No. 378" — a heading rather than text.
function isHeading(line) {
  return /^#/.test(line) || /^(?:no\.?\s*)?\d{1,6}\s*[.:]?$/i.test(line);
}

function cleanTitle(line) {
  return line
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^[•·*+\-–—]\s+/, '')
    .replace(/^[*_]+|[*_]+$/g, '')
    .replace(/^no\.?\s*(?=\d)/i, '')
    .replace(/[\s:：.]+$/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Format detection

function detectFromLines(classes) {
  if (classes.every((c) => c.type === 'blank')) return 'oneline';
  if (classes.some((c) => c.type === 'label' && c.field === 'senses')) return 'block';
  const numberedDoc = classes.some(isNumberedEntry);
  if (!classes.some((c) => looksLikeEntry(c, numberedDoc))) return 'passage';
  return isFamilyLayout(classes) ? 'family' : 'oneline';
}

function isNumberedEntry(cls) {
  return cls.type === 'numbered' && partsOf(cls).hasSep;
}

function looksLikeEntry(cls, numberedDoc) {
  if (cls.type === 'numbered') return partsOf(cls).hasSep || isMarkedHead(parseHead(cls.content));
  return lineEntry(cls, numberedDoc) !== null;
}

// Two or more blank-line separated blocks, each numbered from 1 with >= 2 entries.
// A number heading ("379.") after the first entry means several word lists
// were pasted together, not word families.
function isFamilyLayout(classes) {
  const blocks = [];
  let numbers = [];
  for (const cls of [...classes, { type: 'blank' }]) {
    if (cls.type === 'text' && isHeading(cls.line) && (blocks.length || numbers.length)) return false;
    if (cls.type === 'numbered') numbers.push(cls.n);
    else if (cls.type === 'blank' && numbers.length) {
      blocks.push(numbers);
      numbers = [];
    }
  }
  return blocks.length >= 2 && blocks.every((b) => b[0] === 1 && b.length >= 2);
}

// ---------------------------------------------------------------------------
// Entry heads: "word (pos) /ipa/ : meaning"

const MASK = '\u0001';

// "/ipa/" — the slashes hug the transcription, so "colour / color" is not IPA.
const IPA_SPAN = /(^|[\s([)\]])\/(?=[^\s/])([^/\n]*?[^\s/])\/(?=$|[\s:：;,.)\]=→\-–—])/gu;

// Slashes that do not hug the text ("repository/rɪˈpɑːzətɔːri/(n)",
// "/ ˈpremɪs /") still mark IPA when the text between them has a letter that
// only phonetic transcriptions use (never English or Vietnamese spelling).
const LOOSE_IPA_SPAN = /\/(?=([^/\n]*[ˈˌːɪʊəɚɛɜɝɒɔɑɐæʌʃʒθðŋɡɹɾʔ][^/\n]*)\/)/gu;

function ipaSpans(s) {
  const strict = [...s.matchAll(IPA_SPAN)].map((m) => ({
    start: m.index + m[1].length,
    end: m.index + m[0].length,
    inner: m[2].trim(),
  }));
  const loose = [];
  let next = 0; // first strict span that may still overlap
  let free = 0; // end of the last loose span
  for (const m of s.matchAll(LOOSE_IPA_SPAN)) {
    const span = { start: m.index, end: m.index + m[1].length + 2, inner: m[1].trim() };
    while (next < strict.length && strict[next].end <= span.start) next++;
    const overlaps = span.start < free || (next < strict.length && strict[next].start < span.end);
    // ":" as a length mark hugs a letter ("ɑ:z"); ": " is the entry separator.
    const hidesSeparator = /[:：]\s|：/u.test(span.inner);
    if (!overlaps && !hidesSeparator && span.inner) {
      loose.push(span);
      free = span.end;
    }
  }
  return loose.length ? [...strict, ...loose].sort((a, b) => a.start - b.start) : strict;
}

// Hides IPA and bracketed text so separators inside them are ignored.
function maskNested(s) {
  const chars = s.split('');
  for (const { start, end } of ipaSpans(s)) chars.fill(MASK, start, end);
  const ipaMasked = chars.join('');
  let depth = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '(' || c === '[') depth++;
    const inside = depth > 0;
    if ((c === ')' || c === ']') && depth > 0) depth--;
    if (inside) chars[i] = MASK;
  }
  // Unbalanced brackets would hide the rest of the line: ignore them instead.
  return depth === 0 ? chars.join('') : ipaMasked;
}

// The spaces around the symbol are trimmed by hand: a leading `\s*` in the
// pattern would rescan long runs of spaces (quadratic time).
const FALLBACK_SEP = /→|=>|=|(?<=\s)[-–—]{1,2}(?=\s)/u;

function splitEntry(content) {
  const masked = maskNested(content);
  let at = masked.search(/[:：]/);
  let length = 1;
  if (at < 0) {
    // "word (n) - meaning" / "word /ipa/ = meaning": only after a pos or IPA.
    const m = FALLBACK_SEP.exec(masked);
    const start = m ? masked.slice(0, m.index).trimEnd().length : 0;
    if (start > 0 && isMarkedHead(parseHead(content.slice(0, start)))) {
      at = start;
      length = m.index + m[0].length - start;
    }
  }
  if (at < 0) return { head: content.trim(), meaning: '', hasSep: false };
  return { head: content.slice(0, at).trim(), meaning: content.slice(at + length).trim(), hasSep: true };
}

// `loosePos` (families): an unknown trailing "(gerund)" still counts as the pos.
function parseHead(head, { loosePos = false } = {}) {
  const spans = ipaSpans(head);
  let rest = removeSpans(head, spans);
  const groups = [...rest.matchAll(/\(([^()]*)\)/g)];
  const groupEnd = (g) => g.index + g[0].length;
  const isPosGroup = (g) => normalizePos(g[1]) !== null;
  let last = groups.findLastIndex(isPosGroup);
  if (last < 0 && loosePos && groups.length && !rest.slice(groupEnd(groups.at(-1))).trim()) {
    last = groups.length - 1;
  }
  // "(n) (v)" / "(n)(v)": neighbouring pos groups name several parts of speech.
  let first = last;
  while (first > 0 && isPosGroup(groups[first - 1])
    && /^[\s,/&]*$/.test(rest.slice(groupEnd(groups[first - 1]), groups[first].index))) {
    first--;
  }
  let posRaw = '';
  if (last >= 0) {
    posRaw = groups.slice(first, last + 1).map((g) => g[1].trim()).join('/');
    rest = `${rest.slice(0, groups[first].index)} ${rest.slice(groupEnd(groups[last]))}`;
  }
  return {
    word: cleanWord(rest),
    ipa: spans[0]?.inner ?? '',
    pos: normalizePos(posRaw) ?? '',
    posRaw,
  };
}

function isMarkedHead(head) {
  return Boolean(head.word && (head.pos || head.ipa));
}

// "UK /…/ US /…/": region labels copied from a dictionary, dropped with the IPA.
const REGION_LABEL = /(^|\s)(?:UK|US|BrE|AmE|NAmE)\s*$/u;

function removeSpans(s, spans) {
  let out = '';
  let from = 0;
  for (const { start, end } of spans) {
    out += `${s.slice(from, start).replace(REGION_LABEL, '$1')} `;
    from = end;
  }
  return out + s.slice(from);
}

// "“come up with”", "'jolt'": quotes around the whole word are not part of it.
const WRAPPING_QUOTES = /^["“”„'‘’«](.+)["“”'‘’»]$/u;
// Heading marks, emphasis marks and list numbers in front of the word, in any
// order ("## 1. **level-headed**"). A list number is never part of the word.
const WORD_PREFIX = /^(?:(?:#{1,6}|[*_]+|\d{1,4}\s*[.)/](?=\s))\s*)+/;

function cleanWord(s) {
  return collapse(s)
    .replace(WORD_PREFIX, '')
    .replace(/\s*[*_]+$/, '')
    .replace(/[\s,;:：]+$/, '')
    .trim()
    .replace(WRAPPING_QUOTES, '$1')
    .trim();
}

// "repository (n): /rɪˈpɑːzətɔːri/ nơi lưu trữ" — IPA written after the separator.
function takeLeadingIpa(meaning) {
  const span = ipaSpans(meaning)[0];
  if (!span || meaning.slice(0, span.start).trim()) return null;
  return { ipa: span.inner, rest: meaning.slice(span.end).replace(/^\s*[:：\-–—]?\s*/, '') };
}

function stripSlashes(s) {
  const span = ipaSpans(s)[0];
  return span ? span.inner : s.replace(/\//g, '').trim();
}

// An unnumbered line ("• word (n): meaning") that starts an entry, or null.
function lineEntry(cls, numberedDoc) {
  if (cls.type !== 'bullet' && cls.type !== 'text') return null;
  const parts = partsOf(cls);
  if (!parts.hasSep || !hasContent(parts.meaning)) return null;
  const head = parseHead(parts.head);
  const words = tokenizeWords(head.word).length;
  if (!words || words > MAX_HEAD_WORDS) return null;
  const marked = isMarkedHead(head) || takeLeadingIpa(parts.meaning) !== null;
  // Plain lines, and bullets inside a numbered list, need a pos or IPA to
  // count — otherwise "Note: ..." or a wrapped "- ..." would start an entry.
  if (!marked && (cls.type === 'text' || numberedDoc)) return null;
  return { ...head, meaning: parts.meaning };
}

// ---------------------------------------------------------------------------
// Senses: "i) a. ii) b", "(1) a (2) b", "a. ii) b"

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const MARKER = /\(?(viii|vii|vi|iv|ix|iii|ii|i|v|x|\d{1,2})\)/iy;
const MARKER_ANYWHERE = /(?<![^\s.,;:!?…\-–—])\(?(?:viii|vii|vi|iv|ix|iii|ii|i|v|x|\d{1,2})\)/giu;
const MARKER_BOUNDARY = /[\s.,;:!?…\-–—]/u;

function matchMarker(text, index) {
  MARKER.lastIndex = index;
  const m = MARKER.exec(text);
  if (!m) return null;
  const key = m[1].toLowerCase();
  return {
    index,
    end: index + m[0].length,
    ownParen: m[0].startsWith('('),
    value: ROMAN[key] ?? Number(key),
    style: key in ROMAN ? 'roman' : 'digit',
  };
}

// Closing brackets after `from` that are not part of a marker.
function closersAhead(text, from) {
  return text.slice(from).replace(MARKER_ANYWHERE, '').split(/[)\]]/).length - 1;
}

// Marker candidates outside brackets. A marker must start the text or follow
// whitespace/punctuation, so "Hawaii)" or "taxi)" never match.
function findMarkers(text) {
  const found = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const marker = i === 0 || MARKER_BOUNDARY.test(text[i - 1]) ? matchMarker(text, i) : null;
    if (marker) {
      if (depth === 0) found.push(marker);
      // Inside brackets, "v)" in "(n, v)" closes the group; "i)" in "(i) a, ii) b)" does not.
      else if (!marker.ownParen && closersAhead(text, marker.end) < depth) depth--;
      i = marker.end - 1;
      continue;
    }
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
  }
  return found;
}

// Keeps only markers that count up: 1, 2, 3... (or 2, 3... after an unmarked
// first sense), all in one style. A stray "(v)" is left in the text.
function markerChain(markers, text) {
  const chain = [];
  for (const m of markers) {
    const last = chain.at(-1);
    if (last) {
      if (m.style === last.style && m.value === last.value + 1) chain.push(m);
    } else if (m.value === 1 || (m.value === 2 && hasContent(text.slice(0, m.index)))) {
      chain.push(m);
    }
  }
  return chain;
}

function splitSenses(text) {
  const chain = markerChain(findMarkers(text), text);
  const parts = [text.slice(0, chain[0]?.index ?? text.length)];
  chain.forEach((m, k) => parts.push(text.slice(m.end, chain[k + 1]?.index ?? text.length)));
  return parts.map(cleanSense).filter(hasContent);
}

function cleanSense(s) {
  return collapse(s).replace(/^[,;]\s*/, '').replace(/[\s.;,]+$/, '');
}

const SYNONYM_TAG = /\[\s*=\s*([^\]]*)\]/g;

// Moves "[=plain, simple]" into `into`, returning the text without it.
function takeSynonyms(text, into) {
  return text.replace(SYNONYM_TAG, (_, list) => {
    into.push(...splitList(list));
    return ' ';
  });
}

function splitList(s) {
  return s
    .split(/\s*[,;/]\s*/)
    .map((x) => collapse(x).replace(/\.+$/, ''))
    .filter(hasContent);
}

// ---------------------------------------------------------------------------
// Vocab lists (one-line and block formats)

function parseVocab(classes, format) {
  const s = {
    format,
    numberedDoc: classes.some(isNumberedEntry),
    title: '',
    warnings: [],
    entries: [],
    current: null, // entry receiving label and continuation lines
    open: false, // false after a blank line: plain text no longer continues it
    skipping: false, // continuation lines of a rejected entry are dropped
    started: false,
  };
  classes.forEach((cls, i) => vocabLine(s, cls, i + 1, classes[i + 1]));

  const items = [];
  for (const entry of s.entries) {
    const item = toVocabItem(entry, items.length + 1);
    if (item) items.push(item);
    else s.warnings.push({ line: entry.line, text: entry.text, reason: REASON.noMeaning });
  }
  s.warnings.sort((a, b) => a.line - b.line);
  return { title: s.title, items, warnings: s.warnings };
}

function vocabLine(s, cls, lineNo, next) {
  if (cls.type === 'blank') {
    s.open = false;
    s.skipping = false;
    return;
  }
  const first = !s.started;
  s.started = true;
  const warn = (reason) => s.warnings.push({ line: lineNo, text: cls.line, reason });

  if (cls.type === 'numbered') return vocabNumbered(s, cls, lineNo, warn);
  if (cls.type === 'label') {
    if (s.current) {
      addLabel(s.current, cls);
      s.open = true;
    } else if (!s.skipping) warn(REASON.orphan);
    return;
  }
  const head = lineEntry(cls, s.numberedDoc) ?? blockHeader(s, cls, next);
  if (head) return startEntry(s, head, lineNo, cls.line);
  if (s.current && s.open && !isHeading(cls.line)) return addContinuation(s.current, cls);
  if (s.skipping) return;
  if (takeTitle(s, cls.line, first, s.entries.length > 0)) return;
  warn(REASON.orphan);
}

function vocabNumbered(s, cls, lineNo, warn) {
  const parts = partsOf(cls);
  const head = parseHead(parts.head);
  if (isSenseLine(s, cls, parts, head)) {
    const line = `${cls.n}) ${cls.content}`;
    return addContinuation(s.current, { type: 'text', line, content: line });
  }
  if (parts.hasSep) {
    if (!head.word) return reject(s, warn, REASON.noWord);
    return startEntry(s, { ...head, meaning: parts.meaning }, lineNo, cls.line);
  }
  if (s.format === 'block') {
    if (!head.word) return reject(s, warn, REASON.noWord);
    return startEntry(s, { ...head, meaning: null }, lineNo, cls.line);
  }
  return reject(s, warn, REASON.missingSep);
}

// "1. repository (n):" followed by "1) ..." / "2) ..." sense lines. When the
// header left its meaning for the lines below, a sense line may contain ":"
// itself; a line with its own pos or IPA still starts a new entry.
function isSenseLine(s, cls, parts, head) {
  if (cls.delim !== ')' || !s.current || !s.open || !continuesSenses(s.current, cls.n)) return false;
  return !parts.hasSep || (s.current.sensesBelow && !isMarkedHead(head));
}

function reject(s, warn, reason) {
  warn(reason);
  s.current = null;
  s.open = false;
  s.skipping = true;
}

// Block format: an unnumbered line directly followed by "Definition:" is a header.
function blockHeader(s, cls, next) {
  if (s.format !== 'block' || (cls.type !== 'bullet' && cls.type !== 'text')) return null;
  if (next?.type !== 'label' || next.field !== 'senses') return null;
  const parts = partsOf(cls);
  const head = parseHead(parts.head);
  const words = tokenizeWords(head.word).length;
  if (!words || words > MAX_HEAD_WORDS) return null;
  // Inside an open entry a bare line is more likely wrapped text.
  if (s.current && s.open && !isMarkedHead(head)) return null;
  return { ...head, meaning: parts.hasSep ? parts.meaning : null };
}

function continuesSenses(entry, n) {
  if (entry.field !== 'senses') return false;
  const text = entry.fields.senses.map((seg) => seg.text).join(' ');
  if (!hasContent(text)) return n === 1;
  const last = markerChain(findMarkers(text), text).at(-1);
  return last?.style === 'digit' && last.value === n - 1;
}

function takeTitle(s, line, first, afterEntries) {
  if (afterEntries || s.title) return false;
  if (first ? line.length > MAX_TITLE_LENGTH : !isHeading(line)) return false;
  s.title = cleanTitle(line);
  return true;
}

function startEntry(s, head, lineNo, text) {
  let { ipa, meaning } = head;
  if (!ipa && meaning) {
    const lead = takeLeadingIpa(meaning);
    if (lead) ({ ipa, rest: meaning } = lead);
  }
  const entry = {
    line: lineNo,
    text,
    word: head.word,
    ipa,
    pos: head.pos,
    field: 'senses',
    fields: { senses: [], examples: [], synonyms: [], family: [], context: [], ipa: [], pos: [] },
    sensesBelow: !hasContent(meaning ?? ''), // "word (n):" with the senses on the next lines
  };
  if (meaning != null) entry.fields.senses.push({ text: meaning, bullet: false });
  s.entries.push(entry);
  s.current = entry;
  s.open = true;
  s.skipping = false;
}

function addLabel(entry, cls) {
  entry.field = cls.field;
  if (cls.field !== 'ignore') entry.fields[cls.field].push({ text: cls.content, bullet: false });
}

// A wrapped line joins the last segment; a bullet starts a new one when it
// follows an empty label ("Examples:") or another bullet.
function addContinuation(entry, cls) {
  if (entry.field === 'ignore') return;
  const segments = entry.fields[entry.field];
  const last = segments.at(-1);
  if (cls.type === 'bullet' && (!last || !hasContent(last.text) || last.bullet)) {
    segments.push({ text: cls.content, bullet: true });
  } else if (!last) {
    segments.push({ text: cls.line, bullet: false });
  } else {
    last.text += ` ${cls.line}`;
  }
}

function toVocabItem(entry, n) {
  const { fields } = entry;
  const synonyms = [];
  const senses = fields.senses.flatMap((seg) => splitSenses(takeSynonyms(seg.text, synonyms)));
  if (!senses.length) return null;
  for (const seg of fields.synonyms) synonyms.push(...splitList(seg.text));
  return {
    id: uid(),
    n,
    word: entry.word,
    ipa: entry.ipa || stripSlashes(joinSegments(fields.ipa)),
    pos: entry.pos || normalizePos(joinSegments(fields.pos)) || '',
    senses,
    synonyms: unique(synonyms),
    examples: fields.examples.map((seg) => collapse(seg.text)).filter(hasContent),
    family: joinSegments(fields.family),
    context: joinSegments(fields.context),
  };
}

// ---------------------------------------------------------------------------
// Word families

const FAMILY_FIELDS = { senses: 'definition', examples: 'example', ipa: 'ipa', pos: 'pos' };

function parseFamilies(classes) {
  const s = {
    title: '',
    warnings: [],
    families: [],
    family: null,
    member: null,
    field: 'definition',
    open: false,
    skipping: false,
    started: false,
    pendingBreak: false, // a blank line was seen: the next entry starts a new family
  };
  classes.forEach((cls, i) => familyLine(s, cls, i + 1));
  const items = s.families
    .filter((f) => f.members.length)
    .map((f) => ({ id: uid(), members: f.members.map(finishMember) }));
  return { title: s.title, items, warnings: s.warnings };
}

function familyLine(s, cls, lineNo) {
  if (cls.type === 'blank') {
    s.open = false;
    s.skipping = false;
    s.pendingBreak = true;
    return;
  }
  const first = !s.started;
  s.started = true;
  const warn = (reason) => s.warnings.push({ line: lineNo, text: cls.line, reason });

  if (cls.type === 'numbered') return familyMember(s, cls, warn);
  if (cls.type === 'label') {
    if (s.member) {
      s.field = FAMILY_FIELDS[cls.field] ?? 'ignore';
      appendMember(s.member, s.field, cls.content);
      s.open = true;
    } else if (!s.skipping) warn(REASON.orphan);
    return;
  }
  if (s.member && s.open && !isHeading(cls.line)) return appendMember(s.member, s.field, cls.line);
  if (s.skipping) return;
  if (takeTitle(s, cls.line, first, s.families.length > 0)) return;
  warn(REASON.orphan);
}

function familyMember(s, cls, warn) {
  const parts = partsOf(cls);
  const head = parts.hasSep ? parseHead(parts.head, { loosePos: true }) : null;
  if (!head?.word) {
    warn(head ? REASON.noWord : REASON.missingSep);
    s.member = null;
    s.open = false;
    s.skipping = true;
    return;
  }
  // A new family starts after a blank line, or when numbering restarts at 1.
  if (!s.family || (s.family.members.length && (s.pendingBreak || cls.n === 1))) {
    s.family = { members: [] };
    s.families.push(s.family);
  }
  s.pendingBreak = false;
  let { ipa } = head;
  let definition = parts.meaning;
  const lead = ipa ? null : takeLeadingIpa(definition);
  if (lead) ({ ipa, rest: definition } = lead);
  s.member = {
    word: head.word,
    pos: head.posRaw ? normalizePos(head.posRaw) ?? head.posRaw : '',
    ipa,
    definition,
    example: '',
  };
  s.family.members.push(s.member);
  s.field = 'definition';
  s.open = true;
  s.skipping = false;
}

function appendMember(member, field, text) {
  if (field === 'ignore' || !text) return;
  if (field === 'ipa') {
    member.ipa ||= stripSlashes(text);
  } else if (field === 'pos') {
    member.pos ||= normalizePos(text) ?? collapse(text);
  } else {
    member[field] = member[field] ? `${member[field]} ${text}` : text;
  }
}

function finishMember(m) {
  return { ...m, definition: collapse(m.definition), example: collapse(m.example) };
}

// ---------------------------------------------------------------------------
// Passages

function parsePassages(lines) {
  const paragraphs = [];
  let current = [];
  for (const raw of [...lines, '']) {
    if (!isBlankLine(raw.trim())) current.push(raw.trimEnd());
    else if (current.length) {
      paragraphs.push(current);
      current = [];
    }
  }
  let title = '';
  const firstLine = paragraphs[0]?.[0].trim();
  if (firstLine && isHeading(firstLine)) {
    title = cleanTitle(firstLine);
    paragraphs[0].shift();
    if (!paragraphs[0].length) paragraphs.shift();
  }
  const items = paragraphs.map((p) => ({ id: uid(), text: p.join('\n').trim() }));
  return { title, items, warnings: [] };
}

// ---------------------------------------------------------------------------
// Small helpers

function collapse(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function hasContent(s) {
  return /[\p{L}\p{N}]/u.test(s);
}

function joinSegments(segments) {
  return segments.map((seg) => collapse(seg.text)).filter(Boolean).join(' ');
}

function unique(list) {
  const seen = new Set();
  return list.filter((x) => {
    const key = x.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
