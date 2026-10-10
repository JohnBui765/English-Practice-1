// Word families built by the Claude app ("route B", like cloze.js): the prompt
// the learner copies into Claude, reading Claude's JSON reply back, family
// status, and answer checking for Word formation. Pure: no DOM access.
// See docs/architecture.md, "Word families from Claude".

import { normalizeAnswer, normalizePos, tokenizeWords } from './text.js';
import { levenshtein } from './grade.js';
import { bracketFirstForm, clozeParts, formMatchesWord, tidyText } from './cloze.js';
import { firstDefined, isObject, readJsonReply, salvageNestedObjects, toNumber } from './json.js';

// ---------------------------------------------------------------------------
// Small text helpers

const INVISIBLE = /\p{Cf}/gu; // soft hyphen, zero-width characters, direction marks, BOM
const BRACKETS = /\[\[([^[\]]*)\]\]/g;

function plain(s) {
  return String(s ?? '').normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

function stripBrackets(s) {
  return String(s ?? '').replace(BRACKETS, '$1');
}

const key = (s) => normalizeAnswer(s, { ignoreAccents: true });

function letterCount(s) {
  return (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

// ---------------------------------------------------------------------------
// Family status

// Ready: two or more members, or one member plus a note ("no real family").
export function isFamilyReady(item) {
  const count = item?.members?.length ?? 0;
  return count >= 2 || (count === 1 && plain(item?.note) !== '');
}

export function familyStatus(list) {
  const items = list?.items ?? [];
  const pending = items.filter((item) => !isFamilyReady(item)).map((item) => item.id);
  return { total: items.length, ready: items.length - pending.length, pending };
}

// ---------------------------------------------------------------------------
// Members

// "authorize / authorise" → ["authorize", "authorise"].
export function memberForms(member) {
  const seen = new Set();
  const out = [];
  for (const part of String(member?.word ?? '').split('/')) {
    const form = plain(part);
    if (form && !seen.has(form.toLowerCase())) {
      seen.add(form.toLowerCase());
      out.push(form);
    }
  }
  return out;
}

// The word the learner pasted, or the model member of a family pasted fully written.
function rootWord(item) {
  return plain(item?.root) || plain(item?.members?.[0]?.word);
}

// Index of the member that is the root itself ("authority" in its family), else 0.
export function modelIndex(item) {
  const members = item?.members ?? [];
  const root = plain(item?.root);
  if (!root || members.length < 2) return 0;
  const rootKey = key(root);
  let index = members.findIndex((m) => memberForms(m).some((form) => key(form) === rootKey));
  if (index < 0) index = members.findIndex((m) => formMatchesWord(root, m.word));
  return Math.max(0, index);
}

// The member's example split around its [[form]], or around the first form of
// the member word when the example has no brackets (families pasted written).
export function memberBlank(member) {
  let text = tidyText(member?.example);
  if (!text) return null;
  if (!clozeParts(text)) {
    const found = member?.word ? bracketFirstForm(text, member.word) : null;
    if (!found) return null;
    text = found.text;
  }
  const parts = clozeParts(text);
  return parts ? { before: stripBrackets(parts.before), answer: parts.answer, after: stripBrackets(parts.after) } : null;
}

const PLACEHOLDERS = new Set(['sb', 'sth', 'smb', 'smth', 'someone', 'somebody', 'something', "sb's", "someone's", "one's", 'oneself']);

// "accuse (sb) of (sth)" and "accuse sb of sth" → "accuse of".
function looseKey(s) {
  const words = tokenizeWords(key(String(s ?? '').replace(/\([^)]*\)/g, ' '))).map((t) => t.word);
  return words.filter((w) => !PLACEHOLDERS.has(w)).join(' ');
}

function isRootMember(member, root) {
  const rootKey = looseKey(root);
  return memberForms(member).some((form) => looseKey(form) === rootKey
    || formMatchesWord(root, form) || formMatchesWord(form, root));
}

// Merges Claude's families into list items: members and note are replaced;
// a family pasted fully written keeps its model word as `root`.
export function applyFamilies(items, families) {
  const byId = new Map((families ?? []).map((f) => [f.itemId, f]));
  return (items ?? []).map((item) => {
    const family = byId.get(item.id);
    if (!family) return item;
    const members = family.members.map((m) => ({ ...m }));
    const hadRoot = !!plain(item.root);
    // A family pasted written out has no root yet: take it, with its part
    // of speech and meaning, from the model member so later prompts and
    // Edit list still know them.
    const model = hadRoot ? null : item.members?.[modelIndex(item)] || members[0];
    return {
      ...item,
      root: plain(item.root) || rootWord(item),
      rootPos: item.rootPos || (model ? plain(model.pos) : ''),
      rootMeaning: item.rootMeaning || (model ? plain(model.vi || model.definition) : ''),
      note: family.note ?? '',
      members,
    };
  });
}

// The list as root words in the one-line format ("1. authority (n): quyền
// lực"), so Edit list reads the same words back. A family pasted written out
// is listed by its model member.
export function rootsText(items) {
  let n = 0;
  return (items ?? [])
    .map((item) => {
      const root = plain(item?.root);
      const model = root ? null : item?.members?.[modelIndex(item)];
      const word = root || memberForms(model)[0] || '';
      if (!word) return null;
      const pos = plain(item.rootPos) || plain(model?.pos);
      const meaning = plain(item.rootMeaning) || plain(model?.vi || model?.definition);
      n += 1;
      return `${n}. ${word}${pos ? ` (${pos})` : ''}${meaning ? `: ${meaning}` : ''}`;
    })
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Word formation answers

// British spellings of American -ize/-yze words: authorized → authorised,
// authorization → authorisation, analyzing → analysing.
const IZE = /(\p{L}{3})iz(e|ed|es|ing|er|ers|ation|ations|ational|able)(?!\p{L})/gu;
const YZE = /(\p{L}{2})yz(e|ed|es|ing|er|ers)(?!\p{L})/gu;

function britishSpelling(s) {
  return s.replace(IZE, '$1is$2').replace(YZE, '$1ys$2');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The answer written with spelling `to` of the member instead of `from`:
// ("authorized", authorize → authorise) → "authorised";
// ("colours", colour → color) → "colors". Null when it does not apply.
function swapSpelling(answer, from, to) {
  if (!formMatchesWord(answer, from)) return null;
  let prefix = 0;
  while (prefix < from.length && prefix < to.length && from[prefix] === to[prefix]) prefix++;
  if (prefix < 3) return null; // two different words, not two spellings
  let suffix = 0;
  while (suffix < from.length - prefix && suffix < to.length - prefix
    && from[from.length - 1 - suffix] === to[to.length - 1 - suffix]) suffix++;
  const stem = from.slice(0, from.length - suffix);
  const m = new RegExp(`(^|[^\\p{L}])${escapeRegExp(stem)}`, 'u').exec(answer);
  if (!m) return null;
  const at = m.index + m[1].length;
  return answer.slice(0, at) + to.slice(0, to.length - suffix) + answer.slice(at + stem.length);
}

// British doubled l: a family word ending in one vowel + l ("travel",
// "cancel", "label") doubles it before -ed/-ing/-er/-ers: traveled →
// travelled, canceling → cancelling, traveler → traveller.
const DOUBLED_L = /(?:[^aeiou]|qu)[aeiou]l$|(?:ue|ia)l$/;

function britishDoubledL(s, bases) {
  let out = s;
  for (const base of bases) {
    if (!DOUBLED_L.test(base)) continue;
    out = out.replace(new RegExp(`(^|[^\\p{L}])${escapeRegExp(base)}(ed|ing|ers?)(?!\\p{L})`, 'gu'), `$1${base}l$2`);
  }
  return out;
}

// Every accepted spelling of `answer` (lower case, accents kept): itself, the
// member's other slash spellings in the same form, British -ise/-yse spellings
// and the British doubled l (from the words of the member and of `members`).
function acceptedSpellings(answer, member, members = null) {
  const base = normalizeAnswer(answer);
  const out = new Set([base]);
  const forms = memberForms(member).map((form) => normalizeAnswer(form));
  for (const from of forms) {
    for (const to of forms) {
      const alt = from === to ? null : swapSpelling(base, from, to);
      if (alt) out.add(alt);
    }
  }
  const bases = new Set(forms);
  for (const m of members ?? []) for (const form of memberForms(m)) bases.add(normalizeAnswer(form));
  for (const s of [...out]) {
    out.add(britishSpelling(s));
    out.add(britishDoubledL(s, bases));
  }
  // A British answer ("travelled") also accepts the American "traveled".
  for (const s of [...out]) {
    for (const b of bases) {
      if (!DOUBLED_L.test(b)) continue;
      out.add(s.replace(new RegExp(`(^|[^\\p{L}])${escapeRegExp(b)}l(ed|ing|ers?)(?!\\p{L})`, 'gu'), `$1${b}$2`));
    }
  }
  return [...out].filter(Boolean);
}

// "to authorize", "the authority": a leading "to" or article the answer does
// not start with is left out (as checkWord does for verbs).
const LEAD = /^(?:to|the|an?) (?=\S)/;

// "unable" / "able", "indecisive" / "decisive": a negative prefix makes
// another word, never a slip.
function isNegativeOf(a, b) {
  return a.length > b.length && a.endsWith(b) && /^(?:un|in|im|il|ir|dis|non|mis)-?$/.test(a.slice(0, a.length - b.length));
}

// Is `typed` a form of `word` ("authorizes" of "authorize / authorise"), or
// `word` a form of `typed` ("decisively" of "decisive")?
function sameWordOtherForm(typed, word) {
  return memberForms({ word }).some((form) => {
    const forms = [form, britishSpelling(key(form))];
    return forms.some((f) => formMatchesWord(typed, f) || formMatchesWord(f, typed));
  });
}

// `answer` is the form the sentence needs ("authorized"), `member` the family
// member it belongs to ({ word: "authorize / authorise", ... }).
// correct: the answer or an accepted spelling of it ("authorised").
// rightWordWrongForm: another form of the member word ("authorizes",
// "authorize") — wrong, since the form is the point.
// A leading "to" or article ("to authorize", "the authority") is ignored.
// close: a slip of 1 letter (answers up to 5 letters) or 2 letters (longer),
// never another form or a negative ("unauthorized").
// With `members` (the whole family), a typed form of another member is not
// close either, and `otherMember` is that member's index (else -1): "ably"
// or "unable" typed for "able".
export function checkFormation(input, answer, member, { ignoreAccents = false, members = null } = {}) {
  const withOther = Array.isArray(members);
  const result = (correct, close, rightWordWrongForm, otherMember = -1) => (withOther
    ? { correct, close, rightWordWrongForm, otherMember }
    : { correct, close, rightWordWrongForm });
  const norm = (s) => normalizeAnswer(s, { ignoreAccents });
  let typed = norm(input);
  const lead = LEAD.exec(typed);
  if (lead && !norm(answer).startsWith(lead[0])) typed = typed.slice(lead[0].length);
  if (!typed) return result(false, false, false);
  const accepted = [...new Set(acceptedSpellings(answer, member, withOther ? members : null).map(norm))].filter(Boolean);
  if (accepted.includes(typed)) return result(true, false, false);
  // "cafe" for "café": only the accents are off.
  if (accepted.some((k) => key(k) === key(typed))) return result(false, true, false);
  const word = String(member?.word ?? '') || String(answer ?? '');
  const rightWordWrongForm = sameWordOtherForm(typed, word);
  const otherMember = withOther ? findOtherMember(typed, member, members) : -1;
  const close = !rightWordWrongForm && otherMember < 0
    && accepted.some((k) => !isNegativeOf(typed, k) && !isNegativeOf(k, typed)
      && levenshtein(typed, k) <= (letterCount(k) <= 5 ? 1 : 2));
  return result(false, close, rightWordWrongForm, otherMember);
}

// The family member (other than `member`) that `typed` is, or a form of; -1.
function findOtherMember(typed, member, members) {
  const others = members
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m && m !== member && m.word && m.word !== member?.word);
  const typedKey = key(typed);
  const exact = others.find(({ m }) => memberForms(m).some((form) => key(form) === typedKey));
  const found = exact ?? others.find(({ m }) => sameWordOtherForm(typed, m.word));
  return found ? found.index : -1;
}

// ---------------------------------------------------------------------------
// buildFamilyPrompt

const FORMAT_LINE = '{"families":[{"w":1,"note":"","members":[{"word":"authority","pos":"n","ipa":"əˈθɔːrəti","hint":"power to decide","vi":"quyền lực, thẩm quyền","example":"Only the director has the [[authority]] to approve overtime."%VI%}]}]}';
const FORMAT_SENTENCE = 'Only the director has the [[authority]] to approve overtime.';

// "1. authority (n) — quyền lực, thẩm quyền". A family pasted fully written
// is asked for by its model member.
function wordLine(item, w) {
  const written = !plain(item.root);
  const model = item.members?.[modelIndex(item)];
  const word = written ? plain(model?.word) : plain(item.root);
  const pos = written ? plain(model?.pos) : plain(item.rootPos);
  const meaning = written ? plain(model?.vi || model?.definition) : plain(item.rootMeaning);
  if (!word) return null;
  return `${w}. ${word}${pos ? ` (${pos})` : ''}${meaning ? ` — ${meaning}` : ''}`;
}

// The text the learner pastes into Claude; '' when there is nothing to ask
// for. `only`: item ids to ask for; word numbers stay index + 1.
export function buildFamilyPrompt(list, { level = 'B2', translate = true, only = null } = {}) {
  const wanted = Array.isArray(only) ? new Set(only) : null;
  const words = (list?.items ?? [])
    .map((item, index) => (!wanted || wanted.has(item.id) ? wordLine(item, index + 1) : null))
    .filter(Boolean);
  if (!words.length) return '';
  const lines = [
    `I'm a Vietnamese learner of English at about ${level} level. For each word below, give me its word family so I can practise word formation.`,
    '',
    'For each word:',
    '1. List the common members of its family (usually 3–6 words across noun, verb, adjective and adverb) that share the same core meaning. Include the word itself. Leave out rare or technical forms (e.g. "authoritativeness") and words that only look related but mean something different (e.g. "author" for "authority"). Include a negative form only if it is very common (e.g. "unauthorized"), and at most one.',
    '2. If I give a meaning, build the family around that meaning.',
    '3. For each member give: part of speech, American IPA (like /rɪˈpɑːzətɔːri/), a short Vietnamese meaning, and – only when two members share a part of speech – a 1–3 word English hint that tells them apart ("permission" vs "power"). If US and UK spelling differ, write both: "authorize / authorise".',
    '4. Write one example sentence per member: natural, everyday English, 10–20 words, using the word\'s most typical collocations ("local authorities", "authorize a payment"). Where it feels natural, set the family\'s sentences in one situation, so I can see the same idea said in different ways ("She has the authority to sign" / "She is authorized to sign"). Don\'t force it: if a form doesn\'t fit, use another everyday situation. Never write stiff sentences just to fit a word in.',
    '5. Put the member in its example in double square brackets, in the form the sentence needs: [[authorized]].',
    '6. If a word has no real family (e.g. a phrasal verb), return only that word and add a short "note".',
  ];
  if (translate) lines.push('7. "example_vi" is a natural Vietnamese translation of the example.');
  lines.push(
    '',
    'Reply with ONLY one JSON code block in this format, where "w" is the word number below:',
    FORMAT_LINE.replace('%VI%', translate ? ',"example_vi":"…"' : ''),
    '',
    'Words:',
    ...words,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Reading Claude's reply

const NOT_READABLE = 'Could not read the reply — copy the whole JSON block from Claude.';

const FAMILY_LIST_KEYS = ['families', 'family', 'words', 'word_families', 'wordFamilies', 'items', 'results'];
const W_KEYS = ['w', 'n', 'number', 'num', 'no'];
const ROOT_KEYS = ['root', 'word', 'headword', 'base'];
const MEMBER_LIST_KEYS = ['members', 'forms', 'family', 'words', 'word_family', 'wordFamily'];
const WORD_KEYS = ['word', 'form', 'member'];
const POS_KEYS = ['pos', 'part_of_speech', 'partOfSpeech', 'word_class', 'type'];
const IPA_KEYS = ['ipa', 'pronunciation', 'pron', 'phonetic', 'phonetics'];
const VI_KEYS = ['vi', 'meaning', 'vietnamese', 'vn', 'meaning_vi', 'meaningVi'];
const HINT_KEYS = ['hint', 'label', 'sense'];
const EXAMPLE_KEYS = ['example', 'sentence', 'examples', 'ex', 'text'];
const EXAMPLE_VI_KEYS = ['example_vi', 'exampleVi', 'translation', 'example_vn', 'exampleVn', 'sentence_vi', 'vi_example'];
const DEFINITION_KEYS = ['definition', 'def', 'meaning_en', 'en'];
const NOTE_KEYS = ['note', 'notes', 'comment'];

// A string value; numbers become strings, an array gives its first string.
function str(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return str(v.find((x) => typeof x === 'string') ?? '');
  return '';
}

function isMemberish(x) {
  if (typeof x === 'string') return x.trim() !== '';
  return isObject(x) && firstDefined(x, WORD_KEYS) !== undefined && !MEMBER_LIST_KEYS.some((k) => Array.isArray(x[k]));
}

function memberArray(obj) {
  for (const k of MEMBER_LIST_KEYS) {
    const v = obj[k];
    if (Array.isArray(v) && (!v.length || v.some(isMemberish))) return v;
  }
  return null;
}

function isFamilyish(x) {
  return isObject(x) && (firstDefined(x, W_KEYS) !== undefined || memberArray(x) !== null);
}

// The family objects inside a parsed value, or null if it is not a reply.
function familyObjects(value) {
  if (Array.isArray(value)) {
    const families = value.filter(isFamilyish);
    return families.length || !value.length ? families : null;
  }
  if (!isObject(value)) return null;
  for (const k of FAMILY_LIST_KEYS) {
    const v = value[k];
    if (Array.isArray(v) && v.some(isFamilyish)) return v.filter(isFamilyish);
  }
  if (isFamilyish(value)) return [value];
  const array = Object.values(value).find((v) => Array.isArray(v) && v.some(isFamilyish));
  return array ? array.filter(isFamilyish) : null;
}

// Word number, or the root word itself ("w": "authority" / "root": "authority").
function resolveFamily(obj, items) {
  const rawW = firstDefined(obj, W_KEYS);
  const n = toNumber(rawW);
  if (n !== null) return { index: n - 1, item: items[n - 1] ?? null, label: String(n) };
  const raw = typeof rawW === 'string' && rawW.trim() ? rawW : str(firstDefined(obj, ROOT_KEYS));
  if (raw.trim()) {
    const wanted = key(raw);
    const index = items.findIndex((item) => key(rootWord(item)) === wanted);
    return { index, item: items[index] ?? null, label: index >= 0 ? String(index + 1) : plain(raw) };
  }
  if (items.length === 1) return { index: 0, item: items[0], label: '1' };
  return { index: -1, item: null, label: null };
}

const refOf = (label) => (label == null ? null : /^\d+$/.test(label) ? `w${label}` : `"${label}"`);

// "authority (n)" → word "authority", pos "n"; wrapping quotes, [[ ]] and
// markdown go; slashes get spaces: "authorize/authorise" → "authorize / authorise".
function cleanWord(raw) {
  let word = plain(stripBrackets(raw)).replace(/[*_]+/g, '').replace(/[.,;:]+$/, '').trim();
  let pos = '';
  const m = /\s*\(([^()]*)\)$/.exec(word);
  if (m && normalizePos(m[1])) {
    pos = normalizePos(m[1]);
    word = word.slice(0, m.index).trim();
  }
  word = word.replace(/^["“'‘]+|["”'’]+$/g, '').trim();
  return { word: word.replace(/\s*\/\s*/g, ' / '), pos };
}

function cleanIpa(raw) {
  return plain(raw).replace(/^[\s/[\]]+|[\s/[\]]+$/g, '').replace(/\/\s*\//g, ' / ').replace(/\s+/g, ' ');
}

// The example with exactly one [[form]] of the member word. A missing or
// wrong bracket is fixed when the word is in the sentence; otherwise the
// example is kept without brackets and `reason` says why.
function checkExample(raw, word) {
  const text = tidyText(raw);
  if (!text) return { example: '', reason: 'No example sentence.' };
  const marks = [...text.matchAll(BRACKETS)];
  if (marks.length === 1 && formMatchesWord(marks[0][1], word)) return { example: text };
  const unmarked = tidyText(text.replace(/[*_[\]]+/g, ''));
  const fixed = bracketFirstForm(unmarked, word);
  if (fixed) return { example: fixed.text };
  if (marks.length > 1) return { example: unmarked, reason: 'The example has more than one [[ ]].' };
  if (marks.length === 1) return { example: unmarked, reason: `[[${marks[0][1]}]] is not a form of "${word}".` };
  return { example: unmarked, reason: `"${word}" is not in the example.` };
}

// One reply member → { member, reason? } or { reason } when it is unusable.
function readMember(raw) {
  const obj = typeof raw === 'string' ? { word: raw } : raw;
  if (!isObject(obj)) return { reason: 'This is not a word.' };
  const { word, pos: wordPos } = cleanWord(str(firstDefined(obj, WORD_KEYS)));
  const exampleRaw = str(firstDefined(obj, EXAMPLE_KEYS));
  if (!word) return { reason: 'This member has no word.', text: tidyText(exampleRaw) };
  const posRaw = plain(str(firstDefined(obj, POS_KEYS)));
  const checked = checkExample(exampleRaw, word);
  const member = {
    word,
    pos: posRaw ? normalizePos(posRaw) ?? posRaw : wordPos,
    ipa: cleanIpa(str(firstDefined(obj, IPA_KEYS))),
    definition: plain(str(firstDefined(obj, DEFINITION_KEYS))),
    vi: plain(stripBrackets(str(firstDefined(obj, VI_KEYS)))),
    hint: plain(str(firstDefined(obj, HINT_KEYS))),
    example: checked.example,
    exampleVi: plain(stripBrackets(str(firstDefined(obj, EXAMPLE_VI_KEYS)))),
  };
  // A "note" put inside the member ("no family") is read too.
  return { member, reason: checked.reason, text: checked.example, note: plain(str(firstDefined(obj, NOTE_KEYS))) };
}

function memberKeys(member) {
  return memberForms(member).map(key);
}

// The format line of the prompt echoed back as if it were a family.
function isFormatEcho(members) {
  if (members.length !== 1) return false;
  const [m] = members;
  return key(m.word) === 'authority'
    && key(stripBrackets(m.example)) === key(stripBrackets(FORMAT_SENTENCE))
    && (!m.exampleVi || /^(?:…|\.{3})$/.test(m.exampleVi));
}

function problem(ref, reason, text, skipped) {
  return text ? { ref, reason, text, skipped } : { ref, reason, skipped };
}

// The word itself as the only member of a family with no real family ("come
// up with"), when Claude sends just a note.
function rootMember(item) {
  return { word: rootWord(item), pos: plain(item.rootPos), ipa: '', definition: '', vi: '', hint: '', example: '', exampleVi: '' };
}

// Reads one family object into `found` (slot → family). The same word may
// come twice (a reply pasted twice, split over blocks): later members replace
// earlier ones with the same word. A family whose number is not in the list
// is kept as well (item null): its forms may still show whose family it is.
function readFamily(obj, items, found, problems) {
  const { index, item, label } = resolveFamily(obj, items);
  const rawMembers = memberArray(obj) ?? [];
  const preview = rawMembers.map((m) => cleanWord(str(isObject(m) ? firstDefined(m, WORD_KEYS) : m)).word).filter(Boolean).join(', ');
  const ref = refOf(label);

  const members = [];
  const seen = new Set();
  const memberProblems = [];
  let memberNote = '';
  rawMembers.forEach((raw, j) => {
    const read = readMember(raw);
    if (!read.member) return memberProblems.push({ j, reason: read.reason, text: read.text, skipped: true });
    const keys = memberKeys(read.member);
    if (keys.some((k) => seen.has(k))) return; // the same word twice: keep the first
    keys.forEach((k) => seen.add(k));
    if (read.reason) memberProblems.push({ j, reason: read.reason, text: read.text, skipped: false });
    if (read.note && !memberNote) memberNote = read.note;
    members.push(read.member);
  });
  if (isFormatEcho(members)) return;

  // The note may come inside the only member; with a note and no members,
  // the word itself is the family.
  const note = plain(str(firstDefined(obj, NOTE_KEYS))) || (members.length === 1 ? memberNote : '');
  if (!members.length && note && item && rootWord(item)) members.push(rootMember(item));

  if (!item && !members.length) return problems.push(orphanProblem(label, preview));
  if (item && !rawMembers.length && !members.length) problems.push(problem(ref, 'No words for this family.', note, true));
  // Each family without a number stands alone; the same number is one family.
  const slot = item ? item.id : label === null ? Symbol('unnumbered') : `#${label}`;
  let family = found.get(slot);
  if (!family) {
    family = { item, index, label, preview, members: [], note: '', problems: [] };
    found.set(slot, family);
  }
  family.problems.push(...memberProblems);
  for (const member of members) {
    const keys = memberKeys(member);
    const at = family.members.findIndex((m) => memberKeys(m).some((k) => keys.includes(k)));
    if (at >= 0) family.members[at] = member;
    else family.members.push(member);
  }
  if (note) family.note = note;
}

function orphanProblem(label, preview) {
  if (label === null) return problem(null, 'A family has no word number ("w").', preview, true);
  return problem(refOf(label), `There is no word ${label} in this list.`, preview, true);
}

function movedReason(label) {
  if (label === null) return 'Came back without a word number — matched by its forms.';
  return /^\d+$/.test(label) ? `Came back as word ${label} — matched by its forms.` : `Came back as "${label}" — matched by its forms.`;
}

// Where each family goes (`dest`, an item index, or -1 when it is left out).
// A family with its own word stays. One numbered wrongly (word 1 and 2 for
// words 2 and 4, counted from 0, swapped, or not numbered) moves to the one
// word whose root it contains, preferring words still waiting. Otherwise it
// stays, flagged, only on a word still waiting that is in no other family,
// so it never replaces a family the learner already has.
function placeFamilies(entries, items) {
  const roots = items.map((item) => rootWord(item));
  const hasRoot = (e, i) => !!roots[i] && e.members.some((m) => isRootMember(m, roots[i]));
  // Looking through every word is slow on long lists: only words starting
  // with the letter of one of the family's forms can be its root.
  const initial = (s) => looseKey(s).charAt(0);
  const rootInitials = roots.map((root) => (root ? initial(root) : ''));
  const live = entries.filter((e) => e.members.length);
  const taken = new Set();
  for (const e of live) {
    e.dest = -1;
    e.others = [];
    if (e.item && (!roots[e.index] || hasRoot(e, e.index))) {
      e.dest = e.index;
      taken.add(e.index);
    }
  }
  for (const e of live) {
    if (e.dest >= 0) continue;
    const initials = new Set(e.members.flatMap((m) => memberForms(m).map(initial)));
    for (let i = 0; i < items.length; i++) {
      if (i !== e.index && initials.has(rootInitials[i]) && hasRoot(e, i)) e.others.push(i);
    }
    let free = e.others.filter((i) => !taken.has(i));
    if (free.length > 1) {
      const waiting = free.filter((i) => !isFamilyReady(items[i]));
      if (waiting.length) free = waiting;
    }
    if (free.length === 1) {
      e.dest = free[0];
      e.moved = true;
      taken.add(e.dest);
    }
  }
  for (const e of live) {
    if (e.dest >= 0 || !e.item || e.others.length || taken.has(e.index) || isFamilyReady(e.item)) continue;
    e.dest = e.index;
    e.doubtful = true;
    taken.add(e.index);
  }
}

// Problems in word order: "w1 member 2" before "w2"; unnumbered ones first.
function problemOrder(p) {
  const m = /^w(\d+)(?: member (\d+))?$/.exec(p.ref ?? '');
  if (m) return [Number(m[1]), Number(m[2] ?? 0)];
  return p.ref == null ? [-1, 0] : [Infinity, 0];
}

function sortProblems(problems) {
  const seen = new Set();
  return problems
    .filter((p) => {
      const id = `${p.ref}|${p.reason}|${p.text ?? ''}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((p, i) => ({ p, i, order: problemOrder(p) }))
    .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.i - b.i)
    .map(({ p }) => p);
}

// families: [{ itemId, members: FamilyMember[], note }] — every family with at
// least one usable member, in reply order. missing: ids of items that would
// still be pending after saving these families. problems: [{ ref, reason,
// text?, skipped }] — skipped: true when a family or member is left out,
// false when it is kept with a flaw (e.g. an example without a blank).
export function parseFamilyReply(text, list) {
  const items = list?.items ?? [];
  const raw = String(text ?? '').replace(/\uFEFF/g, '');
  const objects = readJsonReply(raw, { extract: familyObjects, salvage: (t) => salvageNestedObjects(t, familyObjects) });
  if (!objects) {
    return { families: [], problems: [{ ref: null, reason: NOT_READABLE }], missing: familyStatus(list).pending };
  }

  const found = new Map();
  const problems = [];
  for (const obj of objects) readFamily(obj, items, found, problems);
  const entries = [...found.values()];
  placeFamilies(entries, items);

  const families = [];
  const placed = new Map(); // itemId → family
  for (const e of entries) {
    const words = e.members.map((m) => m.word).join(', ');
    if (!e.members.length) {
      // Every member was unusable: their problems still say why.
      e.problems.forEach((p) => problems.push(problem(`${refOf(e.label)} member ${p.j + 1}`, p.reason, p.text, p.skipped)));
      continue;
    }
    if (e.dest < 0) {
      problems.push(e.item ? problem(refOf(e.label), `"${rootWord(e.item)}" is not in this family — is the word number right?`, words, true) : orphanProblem(e.label, e.preview));
      continue;
    }
    const item = items[e.dest];
    const ref = `w${e.dest + 1}`;
    e.problems.forEach((p) => problems.push(problem(`${ref} member ${p.j + 1}`, p.reason, p.text, p.skipped)));
    families.push({ itemId: item.id, members: e.members, note: e.note });
    placed.set(item.id, e);
    if (e.moved) problems.push(problem(ref, movedReason(e.label), words, false));
    if (e.doubtful) problems.push(problem(ref, `"${rootWord(item)}" is not in this family — is the word number right?`, words, false));
    if (e.members.length === 1 && !e.note) problems.push(problem(ref, 'Only one word came back for this family.', words, false));
  }
  const missing = items.filter((item) => !isFamilyReady(placed.get(item.id) ?? item)).map((item) => item.id);
  return { families, problems: sortProblems(problems), missing };
}
