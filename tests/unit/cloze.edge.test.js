// Adversarial tests for js/core/cloze.js: what a Vietnamese learner really
// pastes or types on an iPhone, plus spec edge cases the main suite skips.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildPrompt, clozeParts, coverage, formMatchesWord, parseReply, sentenceFromContext,
} from '../../js/core/cloze.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

const NOW = 1_760_000_000_000;
const NOT_READABLE = 'Could not read the reply — copy the whole JSON block from Claude.';
const ZWSP = '​';
const NBSP = ' ';
const SOFT_HYPHEN = '­';

function makeItem(n, word, pos, senses, extra = {}) {
  return {
    id: `i${n}`, n, word, ipa: '', pos, senses, synonyms: [], examples: [], family: '', context: '', ...extra,
  };
}

function makeList(items, extra = {}) {
  return {
    id: 'list', kind: 'vocab', title: 'Test', source: '', rawText: '', items, sentences: [],
    createdAt: 0, updatedAt: 0, lastPracticedAt: null, ...extra,
  };
}

// tests/fixtures/list-378.txt, built by hand.
function list378(extra = {}) {
  return makeList([
    makeItem(1, 'repository', 'n', ['nơi lưu trữ đồ đạc số lượng lớn.', 'người nắm được nhiều kiến thức hay thông tin.']),
    makeItem(2, 'interoperability', 'n', ['khả năng các hệ thống hay thiết bị khác nhau hoạt động cùng nhau.']),
    makeItem(3, 'aggregate', 'n', ['kết quả tổng từ các phần nhỏ hơn.', 'cát xây dựng được trộn với xi măng.']),
    makeItem(4, 'acquit', 'v', ['tuyên chính thức vô tội tại tòa.', 'tự mình thể hiện một màn trình diễn trong công việc như thế nào đó.']),
    makeItem(5, 'understudy', 'v', ['học phần lời thoại của diễn viên khác như một phương án dự phòng.']),
    makeItem(6, 'jolt', 'v', ['làm chuyển động mạnh bạo và bất ngờ.', 'khiến ai sốc và bắt đầu hành động.']),
    makeItem(7, 'fumble', 'v', ['sử dụng tay một cách vụng về loay hoay khi làm gì.', 'khó khăn trong việc tìm từ ngữ phù hợp.']),
    makeItem(8, 'stale', 'adj', ['tính cũ, không được tươi mới nữa.']),
    makeItem(9, 'unadorned', 'adj', ['tính không hoa lá màu mè - chỉ giản đơn mộc mạc'], { synonyms: ['plain'] }),
    makeItem(10, 'progressive', 'adj', ['có tính ủng hộ cái mới.', 'có tính xảy ra hay phát triển ổn định.', 'liên quan đến thì tiếp diễn.', 'có tính thuế bị tính cao hơn.']),
    makeItem(11, 'premise', 'n', ['tiền đề - cơ sở lập luận']),
  ], { title: '378', ...extra });
}

// Phrases and slash headwords as a learner writes them in a Google Keep note.
function phraseList() {
  return makeList([
    makeItem(1, 'be/get used to', 'phr', ['quen với']),
    makeItem(2, 'look after/for', 'phr v', ['chăm sóc / tìm kiếm']),
    makeItem(3, 'be keen on', 'phr', ['say mê']),
    makeItem(4, 'come up with', 'phr v', ['nghĩ ra']),
    makeItem(5, 'colour / color', 'n', ['màu sắc']),
    makeItem(6, 'acquit', 'v', ['tuyên vô tội', 'thể hiện']),
  ]);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const fenced = (objects) => '```json\n' + JSON.stringify({ sentences: objects }) + '\n```';
const pairsOf = (missing) => missing.map((m) => `${m.itemId}:${m.sense}`);
const replyLines = () => fixture('reply-378.md').split('\n').filter((line) => line.startsWith('{"w":'));

function elapsed(fn) {
  const start = performance.now();
  const result = fn();
  return { ms: performance.now() - start, result };
}

// Every stored sentence must satisfy the ClozeSentence contract.
function assertValidSentences(sentences, list) {
  const ids = new Set();
  for (const s of sentences) {
    const item = list.items.find((i) => i.id === s.itemId);
    assert.ok(item, `unknown item ${s.itemId}`);
    assert.ok(Number.isInteger(s.sense) && s.sense >= 0 && s.sense < Math.max(1, item.senses.length), s.text);
    assert.equal((s.text.match(/\[\[/g) ?? []).length, 1, `one [[ in ${s.text}`);
    assert.equal(clozeParts(s.text)?.answer, s.answer, s.text);
    assert.ok(formMatchesWord(s.answer, item.word), `${s.answer} ~ ${item.word}`);
    assert.equal(s.text, s.text.normalize('NFC'));
    assert.doesNotMatch(s.text, /[­​-‍⁠]|\s{2}|^\s|\s$/u);
    assert.equal(typeof s.vi, 'string');
    assert.ok(!ids.has(s.id), 'ids are unique');
    ids.add(s.id);
  }
}

// ---------------------------------------------------------------------------

describe('formMatchesWord — edge cases', () => {
  const yes = (pairs) => {
    for (const [form, word] of pairs) assert.equal(formMatchesWord(form, word), true, `${form} ~ ${word}`);
  };
  const no = (pairs) => {
    for (const [form, word] of pairs) assert.equal(formMatchesWord(form, word), false, `${form} !~ ${word}`);
  };

  test('a slash inside a phrase swaps single words, never leaves one word alone', () => {
    yes([
      ['is used to', 'be/get used to'], ['got used to', 'be/get used to'], ['getting used to', 'be/get used to'],
      ['am used to', '(be/get) used to'], ['used to', '(be/get) used to'],
      ['looked after', 'look after/for'], ['looked for', 'look after/for'],
      ['had a look at', 'take/have a look at'], ['took a look at', 'take/have a look at'],
      ['gets along with', 'get on/along with'], ['got on with', 'get on/along with'],
    ]);
    no([
      ['is', 'be/get used to'], ['am', '(be/get) used to'], ['got', 'be/get used to'],
      ['for', 'look after/for'], ['take', 'take/have a look at'], ['have', 'take/have a look at'],
    ]);
  });

  test('whole-phrase alternatives and uneven spacing around the slash', () => {
    yes([
      ['kind of', 'kind of/sort of'], ['sort of', 'kind of/sort of'],
      ['despite', 'in spite of / despite'], ['in spite of', 'in spite of / despite'],
      ['colors', 'colour /color'], ['coloured', 'colour/ color'], ['analysed', 'analyse/analyze'],
    ]);
  });

  test('a phrase form must end with the last word of the phrase', () => {
    no([
      ['came up with a plan', 'come up with'], ['took it for granted entirely', 'take sth for granted'],
      ['gave up smoking', 'give sb/sth up'], ['accused him of fraud', 'accuse (sb) of (sth)'],
    ]);
    yes([
      ['accused the head of state of', 'accuse (sb) of (sth)'], // "of" also appears in between
      ['face to face', 'face to face'], ['day by day', 'day by day'], ['gave it up', 'give sb/sth up'],
    ]);
  });

  test('a leading "be", "to" or article is optional (contractions: "She\'s keen on")', () => {
    yes([
      ['keen on', 'be keen on'], ['is keen on', 'be keen on'], ['were keen on', 'be keen on'],
      ['fed up with', 'be fed up with'], ['far cry from', 'a far cry from'], ['a far cry from', 'a far cry from'],
      ['last straw', 'the last straw'], ['acquitting', 'to acquit'],
    ]);
    no([['on', 'be keen on'], ['keen', 'be keen on'], ['far', 'a far cry from']]);
  });

  test('Unicode from iPhone and macOS copies', () => {
    yes([
      ['cafés', 'café'], ['café'.normalize('NFD'), 'cafe'], ['naïve', 'naive'],
      [`came${NBSP}up${NBSP}with`, 'come up with'], [`${ZWSP}acquitted${ZWSP}`, 'acquit'],
      ['repository’s', 'repository'], ['company‘s', 'company'], ['students’', 'student'],
      ['ACQUITTED', 'acquit'], ['Stale.', 'stale'], ['“premise”', 'premise'], ['deciphered', 'Decipher'],
      ['level–headed', 'level-headed'], // en dash typed by iOS smart punctuation
    ]);
  });

  test('regular spelling rules a B2 list needs', () => {
    yes([
      ['referred', 'refer'], ['occurring', 'occur'], ['travelled', 'travel'], ['traveled', 'travel'],
      ['mimicked', 'mimic'], ['quizzes', 'quiz'], ['heroes', 'hero'], ['wolves', 'wolf'], ['lives', 'life'],
      ['dyeing', 'dye'], ['fleeing', 'flee'], ['arguing', 'argue'], ['truly', 'true'], ['gently', 'gentle'],
      ['wholly', 'whole'], ['dramatically', 'dramatic'], ['tied', 'tie'], ['studying', 'study'], ['freer', 'free'],
    ]);
  });

  test('more irregular verbs, behind prefixes too', () => {
    yes([
      ['forgot', 'forget'], ['forgotten', 'forget'], ['forgave', 'forgive'], ['underwent', 'undergo'],
      ['withheld', 'withhold'], ['overslept', 'oversleep'], ['outgrew', 'outgrow'], ['mistook', 'mistake'],
      ['mistaken', 'mistake'], ['overthrew', 'overthrow'], ['foretold', 'foretell'], ['broadcast', 'broadcast'],
      ['dealt with', 'deal with'], ['understood', 'understand'], ['overheard', 'overhear'], ['rebuilt', 'rebuild'],
    ]);
  });

  test('Latin and Greek plurals from academic and news English', () => {
    yes([
      ['spectra', 'spectrum'], ['consortia', 'consortium'], ['referenda', 'referendum'], ['maxima', 'maximum'],
      ['minima', 'minimum'], ['theses', 'thesis'], ['diagnoses', 'diagnosis'], ['nuclei', 'nucleus'],
      ['appendices', 'appendix'], ['consortiums', 'consortium'],
    ]);
  });

  test('never matches inside a longer word or across unrelated words', () => {
    no([
      ['stalemate', 'stale'], ['jolts back', 'jolt'], ['acquittal', 'acquit'], ['premiss', 'premise'],
      ['repository of', 'repository'], ['level', 'level-headed'], ['', 'come up with'], ['   ', 'acquit'],
    ]);
  });

  test('odd argument types do not throw', () => {
    assert.equal(formMatchesWord(undefined, 'acquit'), false);
    assert.equal(formMatchesWord('acquit', undefined), false);
    assert.equal(formMatchesWord('acquit', null), false);
    assert.equal(formMatchesWord({}, 'acquit'), false);
    assert.equal(formMatchesWord('acquit', '()'), false);
    assert.equal(formMatchesWord('acquit', '/'), false);
  });
});

// ---------------------------------------------------------------------------

describe('parseReply — realistic pastes', () => {
  test('reply-378 survives NFD text, CRLF line ends, smart-quote JSON and a double paste', () => {
    const reply = fixture('reply-378.md');
    const smart = reply.replace(/"/g, (_, i, s) => (/[{,:[]\s*$/.test(s.slice(Math.max(0, i - 3), i)) ? '“' : '”'));
    assert.ok(smart.includes('{“w”:1,“s”:1,“text”:“The old'), 'the smart-quote variant really uses smart delimiters');
    const plain = parseReply(reply, list378(), { now: NOW }).sentences;
    for (const text of [reply.normalize('NFD'), reply.replace(/\n/g, '\r\n'), smart]) {
      const list = list378();
      const { sentences, problems, missing } = parseReply(text, list, { now: NOW });
      assert.deepEqual(problems, []);
      assert.deepEqual(missing, []);
      assert.deepEqual(sentences.map((s) => [s.itemId, s.sense, s.text, s.answer, s.vi]),
        plain.map((s) => [s.itemId, s.sense, s.text, s.answer, s.vi]));
      assertValidSentences(sentences, list);
    }
    const twice = parseReply(`${reply}\n\n${reply}`, list378(), { now: NOW });
    assert.equal(twice.sentences.length, 19);
    assert.equal(twice.duplicates, 19);
    assert.deepEqual(twice.problems, []);
  });

  test('a reply split over several code blocks is read completely', () => {
    const lines = replyLines().map((line) => line.replace(/,$/, ''));
    const block = (part) => '```json\n{"sentences":[\n' + part.join(',\n') + '\n]}\n```';
    const text = `Part 1:\n${block(lines.slice(0, 10))}\n\nPart 2:\n${block(lines.slice(10))}`;
    const { sentences, problems, missing } = parseReply(text, list378(), { now: NOW });
    assert.deepEqual(problems, []);
    assert.equal(sentences.length, 19);
    assert.deepEqual(missing, []);
  });

  test('a format example in its own block does not hide the real block', () => {
    const example = '```json\n{"sentences":[{"w":1,"s":1,"text":"... [[word]] ...","vi":"..."}]}\n```';
    const real = fenced([{ w: 8, s: 1, text: 'Nobody touched the [[stale]] biscuits left over from the meeting.', vi: 'x' }]);
    const { sentences } = parseReply(`The format is:\n${example}\nHere you go:\n${real}`, list378(), { now: NOW });
    assert.deepEqual(sentences.map((s) => s.answer), ['stale']);
  });

  test('a cut-off reply followed by the "continue" reply keeps every complete sentence', () => {
    const reply = fixture('reply-378.md');
    const first = reply.slice(0, reply.indexOf('{"w":6') + 12); // cut inside an object, block left open
    const rest = replyLines().filter((line) => /"w":(6|7|8|9|10|11),/.test(line)).map((line) => line.replace(/,$/, ''));
    const second = '```json\n{"sentences":[\n' + rest.join(',\n') + '\n]}\n```';
    const { sentences, problems, missing } = parseReply(`${first}\n\nContinue\n\nHere is the rest:\n${second}`, list378(), { now: NOW });
    assert.deepEqual(problems, []);
    assert.equal(sentences.length, 19);
    assert.deepEqual(missing, []);
  });

  test('a complete block followed by a cut-off block keeps both', () => {
    const lines = replyLines().map((line) => line.replace(/,$/, ''));
    const text = '```json\n{"sentences":[\n' + lines.slice(0, 8).join(',\n') + '\n]}\n```\nMore:\n```json\n{"sentences":[\n'
      + lines.slice(8, 15).join(',\n') + ',\n{"w":11,"s":1,"text":"The whole argu';
    const { sentences, problems } = parseReply(text, list378(), { now: NOW });
    assert.deepEqual(problems, []);
    assert.equal(sentences.length, 15);
  });

  test('NFD text is stored as NFC and recognised as a duplicate of a saved sentence', () => {
    const saved = 'At the café, the [[stale]] croissants were sold for half price.';
    const list = list378({ sentences: [{ id: 'x', itemId: 'i8', sense: 0, text: saved, answer: 'stale', vi: '', origin: 'ai', createdAt: 1 }] });
    const nfd = parseReply(fenced([{ w: 8, s: 1, text: saved.normalize('NFD') }]), list, { now: NOW });
    assert.deepEqual(nfd.sentences, []);
    assert.equal(nfd.duplicates, 1);

    const vi = 'Bánh mì đã bị cũ.'.normalize('NFD');
    const { sentences } = parseReply(fenced([{ w: 8, s: 1, text: 'The café sold [[stale]] bread.'.normalize('NFD'), vi }]), list378(), { now: NOW });
    assert.equal(sentences[0].text, 'The café sold [[stale]] bread.');
    assert.equal(sentences[0].vi, 'Bánh mì đã bị cũ.');
  });

  test('invisible characters and odd spaces never reach the stored text or answer', () => {
    const list = list378();
    const { sentences, problems } = parseReply(fenced([
      { w: 8, s: 1, text: `Nobody${NBSP}ate the${ZWSP} [[stale${ZWSP}]]${NBSP}bread.`, vi: `Không ai ăn${ZWSP} bánh.` },
      { w: 4, s: 1, text: `The jury acquit${SOFT_HYPHEN}ted him on Friday.` },
      { w: 6, s: 1, text: '　The bus [[jolted]] forward.\t' },
    ]), list, { now: NOW });
    assert.deepEqual(problems, []);
    assert.deepEqual(sentences.map((s) => [s.text, s.answer, s.vi]), [
      ['Nobody ate the [[stale]] bread.', 'stale', 'Không ai ăn bánh.'],
      ['The jury [[acquitted]] him on Friday.', 'acquitted', ''],
      ['The bus [[jolted]] forward.', 'jolted', ''],
    ]);
    assertValidSentences(sentences, list);
  });

  test('unescaped inner quotes followed by a comma do not break the reply', () => {
    const text = '```json\n{"sentences":[{"w":4,"s":1,"text":"He said "no", then the jury [[acquitted]] him anyway.","vi":"Anh ấy nói "không", rồi đi."},'
      + '{"w":8,"s":1,"text":"The [[stale]] bread was "fine", she insisted, 5 times.","vi":""}]}\n```';
    const { sentences, problems } = parseReply(text, list378(), { now: NOW });
    assert.deepEqual(problems, []);
    assert.deepEqual(sentences.map((s) => [s.text, s.vi]), [
      ['He said "no", then the jury [[acquitted]] him anyway.', 'Anh ấy nói "không", rồi đi.'],
      ['The [[stale]] bread was "fine", she insisted, 5 times.', ''],
    ]);
  });

  test('smart-quote delimiters together with smart quotes and commas inside the Vietnamese', () => {
    const text = '{“sentences”:[{“w”:4,“s”:1,“text”:“The jury [[acquitted]] him after a short trial.”,“vi”:“Anh ấy nói “không”, rồi đi.”},'
      + '{“w”:8,“text”:“Nobody ate the [[stale]] bread on the table.”}]}';
    const { sentences, problems } = parseReply(text, list378(), { now: NOW });
    assert.deepEqual(problems, []);
    assert.deepEqual(sentences.map((s) => s.answer), ['acquitted', 'stale']);
    assert.match(sentences[0].vi, /^Anh ấy nói “không[”"], rồi đi\.$/);
  });

  test('[[ ]] in the Vietnamese translation is removed', () => {
    const { sentences } = parseReply(fenced([
      { w: 4, s: 1, text: 'The jury [[acquitted]] him.', vi: 'Bồi thẩm đoàn [[tuyên trắng án]] cho anh ta.' },
    ]), list378(), { now: NOW });
    assert.equal(sentences[0].vi, 'Bồi thẩm đoàn tuyên trắng án cho anh ta.');
  });

  test('markdown emphasis instead of [[ ]] is cleaned up when auto-bracketing', () => {
    const { sentences, problems } = parseReply(fenced([
      { w: 8, s: 1, text: 'Nobody ate the *stale* bread left on the table.' },
      { w: 4, s: 2, text: 'In her first match she _acquitted_ herself well.' },
      { w: 6, s: 1, text: 'The tram __jolted__ to a halt.' },
    ]), list378(), { now: NOW });
    assert.deepEqual(problems, []);
    assert.deepEqual(sentences.map((s) => s.text), [
      'Nobody ate the [[stale]] bread left on the table.',
      'In her first match she [[acquitted]] herself well.',
      'The tram [[jolted]] to a halt.',
    ]);
  });

  test('stray brackets and quotes around the answer are tidied', () => {
    const list = list378();
    const { sentences, problems } = parseReply(fenced([
      { w: 8, s: 1, text: 'Nobody ate the [[[stale]]] bread.' },
      { w: 4, s: 1, text: 'The jury [[‘acquitted’]] him.' },
      { w: 9, s: 1, text: 'Her dress was "[[unadorned,]]" the critic wrote.' },
      { w: 6, s: 1, text: 'The [[ ]] bus jolted forward.' },
    ]), list, { now: NOW });
    assert.deepEqual(problems, []);
    assert.deepEqual(sentences.map((s) => [s.text, s.answer]), [
      ['Nobody ate the [[stale]] bread.', 'stale'],
      ['The jury ‘[[acquitted]]’ him.', 'acquitted'],
      ['Her dress was "[[unadorned]]," the critic wrote.', 'unadorned'],
      ['The bus [[jolted]] forward.', 'jolted'],
    ]);
    assertValidSentences(sentences, list);
  });

  test('a bracket that is wider than the phrase is rejected', () => {
    const { sentences, problems } = parseReply(fenced([
      { w: 4, text: 'She [[came up with a plan]] to save the shop.' },
    ]), phraseList(), { now: NOW });
    assert.deepEqual(sentences, []);
    assert.equal(problems[0].reason, '[[came up with a plan]] is not a form of "come up with".');
  });

  test('slash headwords and be-phrases: brackets accepted, missing brackets placed on the whole phrase', () => {
    const list = phraseList();
    const { sentences, problems } = parseReply(fenced([
      { w: 1, text: 'After a year abroad she [[is used to]] working late at the hospital.' },
      { w: 1, text: 'I am used to the noise of the city by now, to be honest.' },
      { w: 2, text: 'Every morning I look for my keys while the kettle boils.' },
      { w: 3, text: "She's [[keen on]] jazz and goes to a concert every month." },
      { w: 3, text: 'My brother is keen on astronomy and owns three telescopes.' },
      { w: 5, text: 'The autumn [[colours]] in the park were spectacular this year.' },
    ]), list, { now: NOW });
    assert.deepEqual(problems, []);
    assert.deepEqual(sentences.map((s) => s.answer), ['is used to', 'am used to', 'look for', 'keen on', 'is keen on', 'colours']);
    assert.equal(sentences[1].text, 'I [[am used to]] the noise of the city by now, to be honest.');
    assertValidSentences(sentences, list);
  });

  test('a single word of a slash phrase is not accepted on its own', () => {
    const { sentences, problems } = parseReply(fenced([
      { w: 1, text: 'She [[is]] tired of working late at the hospital.' },
      { w: 2, text: 'I [[look]] at the sky.' },
    ]), phraseList(), { now: NOW });
    assert.deepEqual(sentences, []);
    assert.equal(problems.length, 2);
  });

  test('a prompt built with `only` round-trips through a reply', () => {
    const list = phraseList();
    const prompt = buildPrompt(list, { only: [{ itemId: 'i6', sense: 1 }, { itemId: 'i5' }] });
    assert.ok(prompt.includes('5. colour / color (n)\n   1) màu sắc\n6. acquit (v)\n   2) thể hiện'));
    assert.ok(prompt.includes('(2 sentences in total)'));
    const { sentences, problems, missing } = parseReply(fenced([
      { w: 5, s: 1, text: 'Pick a [[color]] that matches the walls of the living room.' },
      { w: 6, s: 2, text: 'Nervous as he was, he [[acquitted]] himself well on stage.' },
    ]), list, { now: NOW });
    assert.deepEqual(problems, []);
    assert.deepEqual(sentences.map((s) => [s.itemId, s.sense]), [['i5', 0], ['i6', 1]]);
    assert.ok(!pairsOf(missing).includes('i6:1'));
    assert.ok(pairsOf(missing).includes('i6:0'));
  });
});

// ---------------------------------------------------------------------------

describe('parseReply — odd values and spec edges', () => {
  test('number formats for "w" and "s"', () => {
    const { sentences, problems } = parseReply(JSON.stringify([
      { w: '#4', s: '1)', text: 'The jury [[acquitted]] the nurse of all charges.' },
      { w: ' 6 ', s: 'II', text: 'The news [[jolted]] the council into action.' },
      { w: 10.0, s: 'iv', text: 'A [[progressive]] tax asks more of high earners.' },
      { w: '7.', s: '2.', text: 'Asked about the budget, he [[fumbled]] for words.' },
    ]), list378(), { now: NOW });
    assert.deepEqual(problems, []);
    assert.deepEqual(sentences.map((s) => [s.itemId, s.sense]), [['i4', 0], ['i6', 1], ['i10', 3], ['i7', 1]]);
  });

  test('bad values become problems with a ref, never exceptions', () => {
    const { sentences, problems } = parseReply(JSON.stringify([
      { w: 2.5, text: 'The [[stale]] bread.' },
      { w: true, text: 'The [[stale]] bread.' },
      { w: -1, s: 1, text: 'The [[stale]] bread.' },
      { w: 4, s: 0, text: 'The jury [[acquitted]] him.' },
      { w: 4, s: 'two', text: 'The jury [[acquitted]] him.' },
      { w: 8, s: 1, text: 123 },
      { w: 8, s: 1 },
      { w: 8, s: 1, text: '   ' },
    ]), list378(), { now: NOW });
    assert.deepEqual(sentences, []);
    assert.deepEqual(problems.map((p) => p.ref), [null, null, 'w-1 s1', 'w4 s0', 'w4 stwo', 'w8 s1', 'w8 s1', 'w8 s1']);
    assert.equal(problems[4].reason, '"two" is not a meaning number.');
    assert.equal(problems[5].reason, 'The sentence is empty.');
    for (const p of problems) assert.equal(typeof p.reason, 'string');
  });

  test('a non-string "vi" is ignored', () => {
    const { sentences } = parseReply(JSON.stringify([
      { w: 8, s: 1, text: 'The [[stale]] bread went to the ducks.', vi: 42 },
      { w: 4, s: 1, text: 'The jury [[acquitted]] him.', vi: { text: 'x' } },
    ]), list378(), { now: NOW });
    assert.deepEqual(sentences.map((s) => s.vi), ['', '']);
  });

  test('JSON Lines with chatty lines in between', () => {
    const text = [
      'Here are the sentences, one per line:',
      '{"w":8,"s":1,"text":"The [[stale]] air in the office made everyone sleepy.","vi":"a"}',
      'And another one:',
      '{"w":11,"s":1,"text":"The film rests on a simple [[premise]]: a dog can talk.","vi":"b"}',
      'Hope this helps!',
    ].join('\n');
    const { sentences, problems } = parseReply(text, list378(), { now: NOW });
    assert.deepEqual(problems, []);
    assert.deepEqual(sentences.map((s) => s.vi), ['a', 'b']);
  });

  test('an empty sentences array is read, not an error', () => {
    const { sentences, problems, missing } = parseReply('```json\n{"sentences":[]}\n```', list378(), { now: NOW });
    assert.deepEqual(sentences, []);
    assert.deepEqual(problems, []);
    assert.equal(missing.length, 19);
  });

  test('unreadable inputs of every kind', () => {
    for (const text of [undefined, 42, '```\n```', '{', '}{', '[[stale]]', '{"sentences": "none"}', "{'w': 8, 'text': 'x'}"]) {
      const result = parseReply(text, list378(), { now: NOW });
      assert.deepEqual(result.problems, [{ ref: null, reason: NOT_READABLE }], String(text));
      assert.equal(result.missing.length, 19);
    }
  });

  test('a missing or empty list does not throw', () => {
    const json = fenced([{ w: 1, s: 1, text: 'A [[repository]] of books.' }]);
    for (const list of [null, undefined, {}, makeList([])]) {
      const { sentences, problems, missing } = parseReply(json, list, { now: NOW });
      assert.deepEqual(sentences, []);
      assert.deepEqual(problems.map((p) => p.ref), ['w1 s1']);
      assert.deepEqual(missing, []);
    }
  });

  test('now = 0 is respected', () => {
    const { sentences } = parseReply(fenced([{ w: 8, text: 'The [[stale]] crackers tasted of cardboard.' }]), list378(), { now: 0 });
    assert.equal(sentences[0].createdAt, 0);
  });

  test('does not modify the list it reads against', () => {
    const list = deepFreeze(list378({
      sentences: [{ id: 's', itemId: 'i8', sense: 0, text: 'The [[stale]] bread.', answer: 'stale', vi: '', origin: 'ai', createdAt: 1 }],
    }));
    const snapshot = JSON.stringify(list);
    const { sentences } = parseReply(fixture('reply-378.md'), list, { now: NOW });
    assert.equal(sentences.length, 19);
    assert.equal(JSON.stringify(list), snapshot);
  });

  test('every stored sentence keeps the ClozeSentence contract', () => {
    const list = list378();
    const text = fixture('reply-378.md') + '\n' + fenced([
      { w: 4, s: 1, text: '  The   jury\n[[ acquitted, ]] him. ' },
      { w: 6, s: 2, text: 'The warning **jolted** her into action.' },
      { w: 1, s: 1, text: 'Their [repositories] are full.' },
      { w: 3, s: 2, text: 'Concrete is cement plus [[aggregate.]]' },
    ]);
    const { sentences } = parseReply(text, list, { now: NOW });
    assert.equal(sentences.length, 23);
    assertValidSentences(sentences, list);
  });
});

// ---------------------------------------------------------------------------

describe('performance', () => {
  test('a 2,000-line JSON Lines reply parses quickly', () => {
    const words = list378().items;
    const lines = Array.from({ length: 2000 }, (_, i) => {
      const item = words[i % words.length];
      return JSON.stringify({ w: item.n, s: 1, text: `Note ${i}: the old ${item.word} came up again in today's long meeting.`, vi: `Câu ${i}` });
    });
    const { ms, result } = elapsed(() => parseReply(lines.join('\n'), list378(), { now: NOW }));
    assert.equal(result.sentences.length, 2000);
    assert.deepEqual(result.problems, []);
    assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  });

  test('2,000 sentences without brackets for a phrase are auto-bracketed quickly', () => {
    const list = makeList([makeItem(1, 'take sth for granted', 'idiom', ['coi là đương nhiên'])]);
    const lines = Array.from({ length: 2000 }, (_, i) => JSON.stringify({
      w: 1, text: `${'Honestly, in those long early years we all '.repeat(4)}took clean water number ${i} for granted.`,
    }));
    const { ms, result } = elapsed(() => parseReply(lines.join('\n'), list, { now: NOW }));
    assert.equal(result.sentences.length, 2000);
    assert.match(result.sentences[0].text, /\[\[took clean water number 0 for granted\]\]\.$/);
    assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
  });

  test('adversarial input finishes in linear time', () => {
    const big = 200_000;
    const cases = [
      () => clozeParts('[['.repeat(big / 2)),
      () => parseReply(fenced([{ w: 8, text: '[['.repeat(big / 4) }]), list378()),
      () => parseReply(fenced([{ w: 8, text: `[[${'.'.repeat(big / 4)}x]]` }]), list378()),
      () => parseReply('{'.repeat(big), list378()),
      () => parseReply(`{"text":"${'" '.repeat(big / 4)}`, list378()),
      () => parseReply('```'.repeat(big / 6), list378()),
      () => formMatchesWord('took '.repeat(big / 10), 'take sth for granted'),
      () => sentenceFromContext(makeItem(1, 'take sth for granted', '', ['a'], { context: 'took it for '.repeat(big / 20) }), NOW),
      () => formMatchesWord('x', `${'sb/'.repeat(2000)}acquit`),
      () => formMatchesWord('x', `${'a/b '.repeat(200)}acquit`),
    ];
    for (const [i, run] of cases.entries()) {
      const { ms } = elapsed(run);
      assert.ok(ms < 1500, `case ${i} took ${ms.toFixed(0)} ms`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('clozeParts — edge cases', () => {
  test('ignores single brackets and keeps text around the blank exactly', () => {
    assert.deepEqual(clozeParts('A [note] then [[stale]] bread.'), { before: 'A [note] then ', answer: 'stale', after: ' bread.' });
    assert.deepEqual(clozeParts('[[came up with]]'), { before: '', answer: 'came up with', after: '' });
    assert.equal(clozeParts('[[unclosed bracket'), null);
    assert.equal(clozeParts(42), null);
  });

  test('round-trips: before + answer + after rebuilds the sentence', () => {
    for (const s of parseReply(fixture('reply-378.md'), list378(), { now: NOW }).sentences) {
      const { before, answer, after } = clozeParts(s.text);
      assert.equal(`${before}[[${answer}]]${after}`, s.text);
    }
  });
});

// ---------------------------------------------------------------------------

describe('sentenceFromContext — edge cases', () => {
  const context = (word, text) => sentenceFromContext(makeItem(1, word, '', ['a'], { context: text }), NOW);

  test('NFD context: the whole accented word is bracketed and stored as NFC', () => {
    const s = context('café', 'We met at the café near the station.');
    assert.equal(s.text, 'We met at the [[café]] near the station.');
    assert.equal(s.answer, 'café');
  });

  test('slash headwords and be-phrases bracket the whole phrase', () => {
    assert.equal(context('be/get used to', 'I am used to the noise.').text, 'I [[am used to]] the noise.');
    assert.equal(context('look after/for', 'I look for my keys every morning.').text, 'I [[look for]] my keys every morning.');
    assert.equal(context('be keen on', "She's keen on jazz.").text, "She's [[keen on]] jazz.");
    assert.equal(context('get on/along with', 'She gets on with her boss.').text, 'She [[gets on with]] her boss.');
  });

  test('finds a phrase later in the sentence when the first try runs too long', () => {
    const s = context('take sth for granted', 'We took a long holiday last year, and I think we took the sea for granted.');
    assert.equal(s.text, 'We took a long holiday last year, and I think we [[took the sea for granted]].');
  });

  test('empty or invisible brackets never produce a blank-less sentence', () => {
    for (const text of ['[[]] The jury acquitted her.', 'The jury [[ ]] acquitted her.', `The jury [[${ZWSP}]] acquitted her.`]) {
      const s = context('acquit', text);
      assert.equal(s.text, 'The jury [[acquitted]] her.', text);
      assert.ok(clozeParts(s.text));
    }
  });

  test('line breaks, zero-width spaces and NBSP in the context are cleaned', () => {
    const s = context('acquit', `The court\n acquitted${ZWSP}${NBSP}her\r\nyesterday.`);
    assert.equal(s.text, 'The court [[acquitted]] her yesterday.');
    assert.equal(s.answer, 'acquitted');
  });

  test('does not bracket the word inside a longer word', () => {
    assert.equal(context('stale', 'The talks ended in a stalemate.'), null);
    assert.equal(context('acquit', 'His acquittal surprised everyone.'), null);
  });

  test('does not modify the item; createdAt defaults to now', () => {
    const item = deepFreeze(makeItem(4, 'acquit', 'v', ['a'], { context: 'They acquitted him.' }));
    const before = Date.now();
    const s = sentenceFromContext(item);
    assert.equal(s.text, 'They [[acquitted]] him.');
    assert.ok(s.createdAt >= before && s.createdAt <= Date.now());
    assert.equal(sentenceFromContext(null), null);
    assert.equal(sentenceFromContext(makeItem(1, '', '', ['a'], { context: 'Words here.' })), null);
  });
});

// ---------------------------------------------------------------------------

describe('buildPrompt — edge cases', () => {
  test('a multi-line source stays on the first line', () => {
    const prompt = buildPrompt(list378({ source: '  BBC 6 Minute English\n  episode 12  ' }));
    assert.ok(prompt.split('\n')[0].endsWith('I collected them from: BBC 6 Minute English episode 12 — where it fits, use similar topics.'));
  });

  test('`only` ignores unknown ids and senses, accepts string senses and counts duplicates once', () => {
    const prompt = buildPrompt(list378(), {
      only: [{ itemId: 'i4', sense: 1 }, { itemId: 'i4', sense: 1 }, { itemId: 'i4', sense: '1' }, { itemId: 'nope', sense: 0 }, { itemId: 'i4', sense: 7 }],
    });
    assert.ok(prompt.includes('1 sentence for EACH numbered meaning of each word below (1 sentence in total).'));
    assert.ok(prompt.endsWith('Words:\n4. acquit (v)\n   2) tự mình thể hiện một màn trình diễn trong công việc như thế nào đó'));
    assert.equal(buildPrompt(list378(), { only: [{ itemId: 'nope' }] }), '');
  });

  test('the last word keeps its number when asked alone', () => {
    const prompt = buildPrompt(list378(), { only: [{ itemId: 'i11', sense: 0 }] });
    assert.ok(prompt.endsWith('Words:\n11. premise (n)\n   1) tiền đề - cơ sở lập luận'));
  });

  test('sentences per sense: numeric strings, 3, and nonsense falls back to 1', () => {
    const list = makeList([makeItem(1, 'stale', 'adj', ['cũ'])]);
    assert.ok(buildPrompt(list, { sentencesPerSense: '2' }).includes('2 sentences for EACH numbered meaning of each word below (2 sentences in total).'));
    assert.ok(buildPrompt(list, { sentencesPerSense: 3 }).includes('3 sentences for EACH numbered meaning of each word below (3 sentences in total).'));
    for (const n of [0, NaN, 'abc', -2, undefined]) {
      assert.ok(buildPrompt(list, { sentencesPerSense: n }).includes('1 sentence for EACH numbered meaning of each word below (1 sentence in total).'), String(n));
    }
  });

  test('an item without senses still gets one meaning line', () => {
    const prompt = buildPrompt(makeList([makeItem(1, 'stale', 'adj', [])]));
    assert.ok(prompt.includes('(1 sentence in total)'));
    assert.ok(prompt.includes('1. stale (adj)\n   1) '));
  });

  test('the total always matches coverage().total', () => {
    for (const list of [list378(), phraseList(), makeList([makeItem(1, 'x', '', [])])]) {
      const total = coverage(list).total;
      assert.ok(buildPrompt(list).includes(`(${total} ${total === 1 ? 'sentence' : 'sentences'} in total)`));
      assert.ok(buildPrompt(list, { sentencesPerSense: 2 }).includes(`(${total * 2} sentences in total)`));
    }
  });

  test('does not modify the list or `only`', () => {
    const list = deepFreeze(list378({ sentences: [{ id: 's', itemId: 'i8', sense: 0, text: 'The [[stale]] bread.', answer: 'stale', vi: '', origin: 'ai', createdAt: 1 }] }));
    const only = deepFreeze([{ itemId: 'i8', sense: 0 }]);
    const prompt = buildPrompt(list, { fresh: true, only });
    assert.ok(prompt.endsWith('These sentences already exist — write NEW ones that are clearly different:\n- The stale bread.'));
  });

  test('the phrase hint appears for slash phrases', () => {
    assert.ok(buildPrompt(phraseList()).includes('For a phrase, bracket the whole phrase'));
    assert.ok(!buildPrompt(makeList([makeItem(1, 'colour / color', 'n', ['màu'])])).includes('For a phrase'));
  });
});

// ---------------------------------------------------------------------------

describe('coverage — edge cases', () => {
  test('ignores sentences for other lists, out-of-range senses and duplicates', () => {
    const list = list378({
      sentences: [
        { itemId: 'i8', sense: 0, text: 'a [[stale]] b' },
        { itemId: 'i8', sense: 0, text: 'c [[stale]] d' },
        { itemId: 'other', sense: 0, text: 'x [[y]]' },
        { itemId: 'i4', sense: -1, text: 'x [[acquit]]' },
        { itemId: 'i4', sense: 2, text: 'x [[acquit]]' },
      ],
    });
    const { total, covered, missing } = coverage(list);
    assert.equal(total, 19);
    assert.equal(covered, 1);
    assert.equal(missing.length, 18);
  });

  test('items without senses count as one meaning; missing input is empty', () => {
    assert.deepEqual(coverage(makeList([makeItem(1, 'stale', 'adj', [])])), { total: 1, covered: 0, missing: [{ itemId: 'i1', sense: 0 }] });
    assert.deepEqual(coverage(null), { total: 0, covered: 0, missing: [] });
    assert.deepEqual(coverage({ items: [] }), { total: 0, covered: 0, missing: [] });
  });

  test('parseReply.missing and coverage agree after saving the reply', () => {
    const list = list378();
    const lines = replyLines().map((line) => line.replace(/,$/, ''));
    const { sentences, missing } = parseReply('[' + lines.slice(0, 12).join(',') + ']', list, { now: NOW });
    const after = coverage({ ...list, sentences });
    assert.deepEqual(after.missing, missing);
    assert.equal(after.covered, 19 - missing.length);
  });

  test('does not modify the list', () => {
    const list = deepFreeze(list378({ sentences: [{ itemId: 'i8', sense: 0, text: 'a [[stale]] b' }] }));
    assert.equal(coverage(list).covered, 1);
  });
});
