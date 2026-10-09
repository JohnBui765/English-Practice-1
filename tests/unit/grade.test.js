import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkForm, checkWord, diffWords, levenshtein, similarity } from '../../js/core/grade.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

const changes = (ops) => ops.filter((op) => op.type !== 'equal' && op.type !== 'break');
const types = (ops) => ops.map((op) => op.type);

describe('levenshtein', () => {
  test('classic distances', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3);
    assert.equal(levenshtein('flaw', 'lawn'), 2);
    assert.equal(levenshtein('jolt', 'jolt'), 0);
    assert.equal(levenshtein('acquit', 'acquitted'), 3);
  });

  test('empty and missing values', () => {
    assert.equal(levenshtein('', ''), 0);
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('abc', ''), 3);
    assert.equal(levenshtein(null, 'ab'), 2);
    assert.equal(levenshtein(undefined, undefined), 0);
  });

  test('is symmetric', () => {
    assert.equal(levenshtein('repository', 'reposatry'), levenshtein('reposatry', 'repository'));
  });

  test('counts Unicode code points, not UTF-16 units', () => {
    assert.equal(levenshtein('học', 'hoc'), 1);
    assert.equal(levenshtein('ngày', 'ngay'), 1);
    assert.equal(levenshtein('a😀b', 'ab'), 1);
  });
});

describe('checkWord', () => {
  test('exact answer, ignoring case, spaces and edge punctuation', () => {
    assert.deepEqual(checkWord('acquit', 'acquit'), { correct: true, close: false, expected: 'acquit' });
    assert.equal(checkWord('  Acquit. ', 'acquit').correct, true);
    assert.equal(checkWord('come   up  with', 'come up with').correct, true);
    assert.equal(checkWord('LEVEL-HEADED', 'level-headed').correct, true);
  });

  test('curly apostrophes and dashes match straight ones', () => {
    assert.equal(checkWord('don’t', "don't").correct, true);
    assert.equal(checkWord("rock'n'roll", 'rock’n’roll').correct, true);
    assert.equal(checkWord('level–headed', 'level-headed').correct, true);
  });

  test('expected is the answer exactly as written', () => {
    assert.equal(checkWord('x', 'accuse (sb) of (sth)').expected, 'accuse (sb) of (sth)');
    assert.equal(checkWord('', 'Colour / color').expected, 'Colour / color');
  });

  test('empty input is neither correct nor close', () => {
    for (const input of ['', '   ', '...', null, undefined]) {
      assert.deepEqual(checkWord(input, 'jolt'), { correct: false, close: false, expected: 'jolt' });
    }
  });

  test('alternatives separated by " / ", "/", "," and ";"', () => {
    for (const answer of ['colour / color', 'colour/color', 'colour, color', 'colour; color']) {
      assert.equal(checkWord('colour', answer).correct, true, answer);
      assert.equal(checkWord('color', answer).correct, true, answer);
      assert.equal(checkWord('colour / color', answer).correct, false, answer);
    }
    assert.equal(checkWord('think of', 'come up with / think of').correct, true);
  });

  test('spelling variants in parentheses and optional letters', () => {
    assert.equal(checkWord('color', 'colour (color)').correct, true);
    assert.equal(checkWord('colour', 'colour (color)').correct, true);
    assert.equal(checkWord('color', 'colo(u)r').correct, true);
    assert.equal(checkWord('colour', 'colo(u)r').correct, true);
  });

  test('a part-of-speech or placeholder in parentheses is not a stand-alone answer', () => {
    assert.equal(checkWord('v', 'go (v)').correct, false);
    assert.equal(checkWord('sb', 'accuse (sb)').correct, false);
    assert.equal(checkWord('of', 'die (of)').correct, false);
  });

  test('numbers and URLs are not split into alternatives', () => {
    assert.equal(checkWord('1,000', '1,000').correct, true);
    assert.equal(checkWord('1', '1,000').correct, false);
    assert.equal(checkWord('1/2', '1/2').correct, true);
    assert.equal(checkWord('1', '1/2').correct, false);
    assert.equal(checkWord('https://example.com/a', 'https://example.com/a').correct, true);
    assert.equal(checkWord('a', 'https://example.com/a').correct, false);
    assert.equal(checkWord('www.example.com/a', 'www.example.com/a').correct, true);
  });

  test('optional parts in parentheses', () => {
    const answer = 'accuse (sb) of (sth)';
    for (const input of ['accuse sb of sth', 'accuse of', 'accuse sb of', 'accuse of sth']) {
      assert.equal(checkWord(input, answer).correct, true, input);
    }
    assert.equal(checkWord('accuse at', answer).correct, false);
    assert.equal(checkWord('(be) fed up (with)', '(be) fed up (with)').correct, false);
    for (const input of ['fed up', 'be fed up', 'fed up with', 'be fed up with']) {
      assert.equal(checkWord(input, '(be) fed up (with)').correct, true, input);
    }
  });

  test('someone / something may be typed for sb / sth', () => {
    const answer = 'accuse (sb) of (sth)';
    assert.equal(checkWord('accuse someone of something', answer).correct, true);
    assert.equal(checkWord('accuse somebody of something', answer).correct, true);
    assert.equal(checkWord("pull someone's leg", "pull sb's leg").correct, true);
    assert.equal(checkWord('remind sb. of sth.', 'remind someone of something').correct, true);
  });

  test('a slash inside a word list is a word-level choice', () => {
    assert.equal(checkWord('look after sb', 'look after sb/sth').correct, true);
    assert.equal(checkWord('look after something', 'look after sb/sth').correct, true);
    assert.equal(checkWord('accuse sth of', 'accuse (sb / sth) of').correct, true);
    assert.equal(checkWord('sth', 'look after sb/sth').correct, false);
  });

  test('leading "to" is accepted for verbs', () => {
    for (const pos of ['v', 'verb', 'phr v', 'v phr', 'modal v', 'n/v']) {
      assert.equal(checkWord('to acquit', 'acquit', { pos }).correct, true, pos);
    }
    for (const pos of ['n', 'adj', 'adv', '']) {
      assert.equal(checkWord('to acquit', 'acquit', { pos }).correct, false, pos);
    }
    assert.equal(checkWord('To come up with', 'come up with', { pos: 'phr v' }).correct, true);
    assert.equal(checkWord('to', 'acquit', { pos: 'v' }).correct, false);
  });

  test('leading "to" is accepted for verb phrases without a part of speech', () => {
    assert.equal(checkWord('to accuse someone of something', 'accuse (sb) of (sth)').correct, true);
    assert.equal(checkWord('acquit', 'to acquit').correct, true);
    assert.equal(checkWord('to acquit', 'to acquit').correct, true);
    assert.equal(checkWord('to', 'to', { pos: 'prep' }).correct, true);
    assert.equal(checkWord('date', 'to date', { pos: 'idiom' }).correct, false);
  });

  test('close: 1 edit for answers of up to 4 letters', () => {
    assert.deepEqual(checkWord('jolr', 'jolt'), { correct: false, close: true, expected: 'jolt' });
    assert.equal(checkWord('jlt', 'jolt').close, true);
    assert.equal(checkWord('jlr', 'jolt').close, false);
    assert.equal(checkWord('jolts', 'jolt').close, true);
  });

  test('close: 2 edits for longer answers', () => {
    assert.equal(checkWord('repositry', 'repository').close, true);
    assert.equal(checkWord('reposatry', 'repository').close, true);
    assert.equal(checkWord('rpsatry', 'repository').close, false);
    assert.equal(checkWord('stael', 'stale').close, true);
    assert.equal(checkWord('come up wiht', 'come up with').close, true);
  });

  test('close is false when the answer is correct', () => {
    assert.equal(checkWord('stale', 'stale').close, false);
  });

  test('close is measured against the nearest alternative', () => {
    assert.equal(checkWord('colr', 'colour / color').close, true);
    assert.equal(checkWord('acuse sb of', 'accuse (sb) of (sth)').close, true);
  });

  test('Vietnamese accents: strict by default, optional ignore', () => {
    assert.equal(checkWord('hoc', 'học').correct, false);
    assert.equal(checkWord('hoc', 'học').close, true);
    assert.equal(checkWord('hoc', 'học', { ignoreAccents: true }).correct, true);
    assert.equal(checkWord('di hoc', 'đi học', { ignoreAccents: true }).correct, true);
    assert.equal(checkWord('nơi lưu trữ', 'nơi lưu trữ').correct, true);
  });

  test('decomposed (NFD) input matches a composed (NFC) answer', () => {
    const nfd = 'học'.normalize('NFD');
    assert.notEqual(nfd, 'học');
    assert.equal(checkWord(nfd, 'học').correct, true);
  });

  test('does not throw on odd answers', () => {
    assert.equal(checkWord('x', null).correct, false);
    assert.equal(checkWord('accuse sb', 'accuse (sb').correct, true);
    assert.equal(checkWord('a', '///').correct, false);
  });
});

describe('checkForm', () => {
  test('the exact form is correct', () => {
    assert.deepEqual(checkForm('acquitted', 'acquitted', 'acquit'), { correct: true, rightWordWrongForm: false });
    assert.equal(checkForm('  Acquitted ', 'acquitted', 'acquit').correct, true);
  });

  test('the lemma is the right word in the wrong form', () => {
    assert.deepEqual(checkForm('acquit', 'acquitted', 'acquit'), { correct: false, rightWordWrongForm: true });
    assert.equal(checkForm('come up with', 'came up with', 'come up with').rightWordWrongForm, true);
    assert.equal(checkForm('go', 'went', 'go').rightWordWrongForm, true);
  });

  test('another inflection of the lemma is the right word in the wrong form', () => {
    assert.equal(checkForm('jolts', 'jolted', 'jolt').rightWordWrongForm, true);
    assert.equal(checkForm('acquitting', 'acquitted', 'acquit').rightWordWrongForm, true);
    assert.equal(checkForm('understudies', 'understudied', 'understudy').rightWordWrongForm, true);
    assert.equal(checkForm('fumbling', 'fumbled', 'fumble').rightWordWrongForm, true);
    assert.equal(checkForm('comes up with', 'came up with', 'come up with').rightWordWrongForm, true);
  });

  test('stem shorter than 4 letters or too many edits is just wrong', () => {
    assert.equal(checkForm('goes', 'went', 'go').rightWordWrongForm, false);
    assert.equal(checkForm('interoperable', 'interoperability', 'interoperability').rightWordWrongForm, false);
    assert.equal(checkForm('stalwart', 'stale', 'stale').rightWordWrongForm, false);
    // The stem heuristic is deliberately loose: a near-miss on a shared stem counts.
    assert.equal(checkForm('stall', 'stale', 'stale').rightWordWrongForm, true);
  });

  test('an unrelated word is wrong', () => {
    assert.deepEqual(checkForm('premise', 'jolted', 'jolt'), { correct: false, rightWordWrongForm: false });
  });

  test('empty input', () => {
    assert.deepEqual(checkForm('', 'jolted', 'jolt'), { correct: false, rightWordWrongForm: false });
    assert.deepEqual(checkForm('  ', 'jolted', 'jolt'), { correct: false, rightWordWrongForm: false });
  });

  test('without a lemma the answer stands in for it', () => {
    assert.equal(checkForm('jolting', 'jolted', '').rightWordWrongForm, true);
    assert.equal(checkForm('jolted', 'jolted').correct, true);
  });

  test('ignoreAccents is passed through', () => {
    assert.equal(checkForm('cafe', 'café', 'café').correct, false);
    assert.equal(checkForm('cafe', 'café', 'café', { ignoreAccents: true }).correct, true);
  });

  test('every cloze answer in the realistic Claude reply for list 378', () => {
    const lemmas = new Map();
    for (const m of fixture('list-378.txt').matchAll(/^(\d+)\.[ \t]+(.+?)[ \t]*\(/gm)) {
      lemmas.set(Number(m[1]), m[2]);
    }
    const json = /```json\s*([\s\S]*?)```/.exec(fixture('reply-378.md'))[1];
    const { sentences } = JSON.parse(json);
    assert.equal(sentences.length, 19);
    for (const { w, text } of sentences) {
      const answer = /\[\[(.+?)\]\]/.exec(text)[1];
      const lemma = lemmas.get(w);
      assert.equal(checkForm(answer, answer, lemma).correct, true, answer);
      assert.equal(checkForm(answer.toUpperCase(), answer, lemma).correct, true, answer);
      const typedLemma = checkForm(lemma, answer, lemma);
      assert.ok(typedLemma.correct || typedLemma.rightWordWrongForm, `${lemma} → ${answer}`);
      const other = lemmas.get(w === 1 ? 2 : 1);
      assert.deepEqual(checkForm(other, answer, lemma), { correct: false, rightWordWrongForm: false }, `${other} → ${answer}`);
    }
  });
});

describe('diffWords', () => {
  test('identical text', () => {
    const r = diffWords('She acquitted herself well.', 'She acquitted herself well.');
    assert.equal(r.correct, true);
    assert.equal(r.score, 1);
    assert.deepEqual(types(r.ops), ['equal', 'equal', 'equal', 'equal']);
  });

  test('display tokens keep their punctuation', () => {
    const r = diffWords('Every day, she reads.', 'every day she reads');
    assert.equal(r.correct, true);
    assert.deepEqual(r.ops[1], { type: 'equal', expected: 'day,', actual: 'day' });
    assert.deepEqual(r.ops[3], { type: 'equal', expected: 'reads.', actual: 'reads' });
  });

  test('one missing word in the middle does not cascade', () => {
    const expected = 'The best way to learn a language is to use it every day, even when you make mistakes.';
    const actual = 'The best way to learn a language is use it every day, even when you make mistakes.';
    const r = diffWords(expected, actual);
    assert.deepEqual(changes(r.ops), [{ type: 'missing', expected: 'to' }]);
    assert.equal(r.ops.filter((op) => op.type === 'equal').length, 17);
    assert.equal(r.correct, false);
    assert.equal(r.score, 0.944);
    // Every word after the gap is still matched with itself.
    const after = r.ops.slice(r.ops.findIndex((op) => op.type === 'missing') + 1);
    assert.ok(after.every((op) => op.type === 'equal' && op.expected === op.actual));
  });

  test('one extra word in the middle does not cascade', () => {
    const r = diffWords('The bus jolted to a stop.', 'The bus suddenly jolted to a stop.');
    assert.deepEqual(changes(r.ops), [{ type: 'extra', actual: 'suddenly' }]);
    assert.equal(r.score, 0.857);
  });

  test('one wrong word becomes a single wrong op', () => {
    const r = diffWords('He fumbled with his keys in the dark.', 'He fumbles with his keys in the dark.');
    assert.deepEqual(changes(r.ops), [{ type: 'wrong', expected: 'fumbled', actual: 'fumbles' }]);
    assert.equal(r.ops.length, 8);
    assert.equal(r.score, 0.875);
  });

  test('missing and extra runs pair 1:1, leftovers stay', () => {
    const fewer = diffWords('a b c d', 'a x d');
    assert.deepEqual(fewer.ops, [
      { type: 'equal', expected: 'a', actual: 'a' },
      { type: 'wrong', expected: 'b', actual: 'x' },
      { type: 'missing', expected: 'c' },
      { type: 'equal', expected: 'd', actual: 'd' },
    ]);
    const more = diffWords('a b d', 'a x y d');
    assert.deepEqual(more.ops, [
      { type: 'equal', expected: 'a', actual: 'a' },
      { type: 'wrong', expected: 'b', actual: 'x' },
      { type: 'extra', actual: 'y' },
      { type: 'equal', expected: 'd', actual: 'd' },
    ]);
    assert.equal(more.score, 0.5);
  });

  test('missing words at the start and end', () => {
    const r = diffWords('Yesterday I went home early', 'I went home');
    assert.deepEqual(changes(r.ops), [
      { type: 'missing', expected: 'Yesterday' },
      { type: 'missing', expected: 'early' },
    ]);
    assert.equal(r.score, 0.6);
  });

  test('case: ignored by default, counted with ignoreCase false', () => {
    assert.equal(diffWords('Hello World', 'hello world').correct, true);
    const r = diffWords('Hello World', 'hello World', { ignoreCase: false });
    assert.deepEqual(changes(r.ops), [{ type: 'wrong', expected: 'Hello', actual: 'hello' }]);
    assert.equal(diffWords('Hello, World', 'Hello World', { ignoreCase: false }).correct, true);
  });

  test('punctuation: ignored by default, counted with ignorePunctuation false', () => {
    const r = diffWords('Wait, really?', 'Wait really', { ignorePunctuation: false });
    assert.deepEqual(changes(r.ops), [
      { type: 'wrong', expected: 'Wait,', actual: 'Wait' },
      { type: 'wrong', expected: 'really?', actual: 'really' },
    ]);
    assert.equal(diffWords('Wait, really?', 'wait, REALLY?', { ignorePunctuation: false }).correct, true);
    assert.equal(diffWords('Wait, really?', 'wait, REALLY?', { ignorePunctuation: false, ignoreCase: false }).correct, false);
  });

  test('curly quotes and apostrophes equal straight ones', () => {
    const expected = '“Don’t worry,” she said — it’s fine.';
    const actual = '"Don\'t worry," she said - it\'s fine.';
    assert.equal(diffWords(expected, actual).correct, true);
    assert.equal(diffWords(expected, actual, { ignorePunctuation: false }).correct, true);
    assert.equal(diffWords(expected, 'dont worry she said its fine').correct, false);
  });

  test('lone punctuation tokens are not words', () => {
    const r = diffWords('Wait — what? …', 'wait what');
    assert.equal(r.correct, true);
    assert.deepEqual(types(r.ops), ['equal', 'equal']);
    assert.equal(diffWords('Wait — what?', 'wait what', { ignorePunctuation: false }).correct, false);
  });

  test('multiple spaces, tabs and non-breaking spaces', () => {
    const r = diffWords('a  quick\tbrown\u00a0fox', '  a quick   brown fox  ');
    assert.equal(r.correct, true);
    assert.equal(r.ops.length, 4);
  });

  test('line breaks in expected become break ops; blank lines count once', () => {
    const r = diffWords('line one,\nline two\n\n\nline three\n', 'line one line two line three');
    assert.deepEqual(types(r.ops), ['equal', 'equal', 'break', 'equal', 'equal', 'break', 'equal', 'equal']);
    assert.equal(r.correct, true);
    assert.equal(r.score, 1);
  });

  test('CRLF and leading blank lines', () => {
    const r = diffWords('\r\n\r\nfirst line\r\nsecond line\r\n', 'first line second line');
    assert.deepEqual(types(r.ops), ['equal', 'equal', 'break', 'equal', 'equal']);
  });

  test('line breaks in the typed text are ignored', () => {
    const r = diffWords('one two three', 'one\ntwo\n\nthree');
    assert.deepEqual(types(r.ops), ['equal', 'equal', 'equal']);
  });

  test('break stays before the first word of a line even if it is missing or wrong', () => {
    const missing = diffWords('one\ntwo three', 'one three');
    assert.deepEqual(missing.ops, [
      { type: 'equal', expected: 'one', actual: 'one' },
      { type: 'break' },
      { type: 'missing', expected: 'two' },
      { type: 'equal', expected: 'three', actual: 'three' },
    ]);
    const wrong = diffWords('one\ntwo three', 'one too three');
    assert.deepEqual(types(wrong.ops), ['equal', 'break', 'wrong', 'equal']);
  });

  test('a break before a dropped punctuation token moves to the next word', () => {
    const r = diffWords('Hello\n— world', 'hello world');
    assert.deepEqual(types(r.ops), ['equal', 'break', 'equal']);
  });

  test('ops carry only the documented fields', () => {
    const r = diffWords('a\nb c d', 'x b d e');
    for (const op of r.ops) {
      const allowed = { equal: ['type', 'expected', 'actual'], wrong: ['type', 'expected', 'actual'],
        missing: ['type', 'expected'], extra: ['type', 'actual'], break: ['type'] }[op.type];
      assert.deepEqual(Object.keys(op).sort(), allowed.slice().sort(), JSON.stringify(op));
    }
  });

  test('Vietnamese with accents', () => {
    const expected = 'Tôi đi học mỗi ngày.';
    assert.equal(diffWords(expected, 'tôi đi học mỗi ngày').correct, true);
    const strict = diffWords(expected, 'toi di hoc moi ngay');
    assert.equal(changes(strict.ops).length, 5);
    assert.ok(changes(strict.ops).every((op) => op.type === 'wrong'));
    assert.equal(strict.score, 0);
    const relaxed = diffWords(expected, 'toi di hoc moi ngay', { ignoreAccents: true });
    assert.equal(relaxed.correct, true);
    assert.equal(relaxed.ops[0].expected, 'Tôi');
    const oneTypo = diffWords(expected, 'Tôi đi hoc mỗi ngày.');
    assert.deepEqual(changes(oneTypo.ops), [{ type: 'wrong', expected: 'học', actual: 'hoc' }]);
    assert.equal(diffWords(expected, 'toi di hoc moi ngay', { ignoreAccents: true, ignorePunctuation: false }).correct, false);
    assert.equal(diffWords('Tôi đi học.', 'toi di hoc.', { ignoreAccents: true, ignorePunctuation: false }).correct, true);
  });

  test('composed and decomposed Unicode compare equal', () => {
    assert.equal(diffWords('Tôi đi học', 'Tôi đi học'.normalize('NFD')).correct, true);
    assert.equal(diffWords('Tôi đi học', 'Tôi đi học'.normalize('NFD'), { ignorePunctuation: false }).correct, true);
  });

  test('empty inputs', () => {
    assert.deepEqual(diffWords('', ''), { ops: [], score: 1, correct: true });
    const nothingTyped = diffWords('a b', '');
    assert.deepEqual(types(nothingTyped.ops), ['missing', 'missing']);
    assert.equal(nothingTyped.score, 0);
    assert.equal(nothingTyped.correct, false);
    const nothingExpected = diffWords('', 'a b');
    assert.deepEqual(types(nothingExpected.ops), ['extra', 'extra']);
    assert.equal(nothingExpected.score, 0);
    assert.deepEqual(diffWords(null, undefined), { ops: [], score: 1, correct: true });
  });

  test('score counts extra words and is rounded to 3 decimals', () => {
    assert.equal(diffWords('a b c', 'a b c d').score, 0.75);
    assert.equal(diffWords('a b c', 'a x c').score, 0.667);
  });

  test('passage fixture keeps its paragraph and line breaks', () => {
    const passage = fixture('passage.txt');
    const typed = passage.replace('every day', 'everyday').replace(/\s+/g, ' ');
    const r = diffWords(passage, typed);
    assert.equal(types(r.ops).filter((t) => t === 'break').length, 2);
    assert.deepEqual(changes(r.ops), [
      { type: 'wrong', expected: 'every', actual: 'everyday,' },
      { type: 'missing', expected: 'day,' },
    ]);
  });

  test('long texts fall back to a fast alignment without cascading', () => {
    const words = Array.from({ length: 1500 }, (_, i) => (i % 7 === 0 ? 'the' : `word${i}`));
    const typed = words.slice();
    typed.splice(1300, 1, 'oops'); // wrong word near the end
    typed.splice(800, 0, 'extra1', 'extra2'); // insertion in the middle
    typed.splice(100, 1); // missing word near the start
    const started = performance.now();
    const r = diffWords(words.join(' '), typed.join(' '));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `took ${elapsed} ms`);
    assert.deepEqual(changes(r.ops), [
      { type: 'missing', expected: 'word100' },
      { type: 'extra', actual: 'extra1' },
      { type: 'extra', actual: 'extra2' },
      { type: 'wrong', expected: 'word1300', actual: 'oops' },
    ]);
    assert.equal(r.ops.filter((op) => op.type === 'equal').length, 1498);
  });

  test('long, completely different texts still finish quickly', () => {
    const a = Array.from({ length: 1200 }, (_, i) => `a${i}`).join(' ');
    const b = Array.from({ length: 1200 }, (_, i) => `b${i}`).join(' ');
    const started = performance.now();
    const r = diffWords(a, b);
    assert.ok(performance.now() - started < 2000);
    assert.equal(r.score, 0);
    assert.equal(changes(r.ops).length, 1200);
  });
});

describe('similarity', () => {
  test('identical, empty and disjoint', () => {
    assert.equal(similarity('the jury acquitted him', 'the jury acquitted him'), 1);
    assert.equal(similarity('', ''), 1);
    assert.equal(similarity('  ', '...'), 1);
    assert.equal(similarity('word', ''), 0);
    assert.equal(similarity('', 'word'), 0);
    assert.equal(similarity('alpha beta', 'gamma delta'), 0);
  });

  test('2 * LCS / (lenA + lenB)', () => {
    assert.equal(similarity('a b c', 'a x c'), 2 * 2 / 6);
    assert.equal(similarity('a b c d', 'a b'), 2 * 2 / 6);
    assert.equal(similarity('one two three', 'three two one'), 2 * 1 / 6);
  });

  test('ignores case, punctuation and quote style', () => {
    assert.equal(similarity('“Don’t stop,” he said.', "don't stop he said"), 1);
  });

  test('accents are kept unless ignored', () => {
    assert.ok(similarity('Tôi đi học', 'toi di hoc') < 1);
    assert.equal(similarity('Tôi đi học', 'toi di hoc', { ignoreAccents: true }), 1);
  });

  test('is symmetric', () => {
    const a = 'The bus jolted to a stop';
    const b = 'the bus stopped with a jolt';
    assert.equal(similarity(a, b), similarity(b, a));
  });
});
