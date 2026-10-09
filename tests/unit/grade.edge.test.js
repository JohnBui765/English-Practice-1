// Adversarial tests for js/core/grade.js: realistic iPhone input from a
// Vietnamese learner, Unicode oddities, spec edge cases, invariants and speed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkForm, checkWord, diffWords, levenshtein, similarity } from '../../js/core/grade.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const changes = (ops) => ops.filter((op) => op.type !== 'equal' && op.type !== 'break');
const types = (ops) => ops.map((op) => op.type);
const count = (ops, type) => ops.filter((op) => op.type === type).length;

// Invisible characters that arrive with text copied from web pages.
const INVISIBLE = {
  'soft hyphen': '\u00ad',
  'zero-width space': '\u200b',
  'zero-width joiner': '\u200d',
  'word joiner': '\u2060',
  'left-to-right mark': '\u200e',
  BOM: '\ufeff',
};
const SPACES = {
  'no-break space': '\u00a0',
  'narrow no-break space': '\u202f',
  'ideographic space': '\u3000',
  tab: '\t',
  newline: '\n',
  CRLF: '\r\n',
  'double space': '  ',
};

// Deterministic PRNG so the fuzz tests are reproducible.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function timed(fn) {
  const started = performance.now();
  const result = fn();
  return { result, ms: performance.now() - started };
}

// "N. word (pos) ..." lines of the real list format.
function listEntries(text) {
  return [...text.matchAll(/^(\d+)\.[ \t]+([^(\n]+?)[ \t]*\(([^)]*)\)/gm)].map((m) => ({ word: m[2], pos: m[3] }));
}

function lcsLength(a, b) {
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  return L[0][0];
}

describe('checkWord: invisible and unusual characters', () => {
  test('invisible characters in the typed answer are ignored', () => {
    for (const [name, ch] of Object.entries(INVISIBLE)) {
      assert.deepEqual(checkWord(`acq${ch}uit`, 'acquit'), { correct: true, close: false, expected: 'acquit' }, name);
      assert.equal(checkWord(`acquit${ch}`, 'acquit').correct, true, name);
      assert.equal(checkWord(`${ch}acquit`, 'acquit').correct, true, name);
    }
  });

  test('invisible characters in the stored answer are ignored; expected stays as written', () => {
    const answer = 'inter\u00adoperability';
    assert.deepEqual(checkWord('interoperability', answer), { correct: true, close: false, expected: answer });
    assert.equal(checkWord('come up with', 'come\u200b up with').correct, true);
  });

  test('Unicode spaces and line breaks between words', () => {
    for (const [name, sp] of Object.entries(SPACES)) {
      assert.equal(checkWord(`come${sp}up${sp}with`, 'come up with').correct, true, name);
      assert.equal(checkWord('come up with', `come${sp}up${sp}with`).correct, true, name);
    }
  });

  test('iPhone autocapitalisation, auto-period and smart punctuation', () => {
    assert.equal(checkWord('Acquit', 'acquit').correct, true);
    assert.equal(checkWord('Acquit. ', 'acquit').correct, true); // double-space shortcut
    assert.equal(checkWord('Don’t', "don't").correct, true);
    assert.equal(checkWord('level—headed', 'level-headed').correct, true);
    assert.equal(checkWord('“break a leg”', 'break a leg').correct, true);
    assert.equal(checkWord('Pull someone’s leg', "pull sb's leg").correct, true);
  });

  test('decomposed (NFD) Vietnamese in the answer, the input or both', () => {
    const nfd = 'học'.normalize('NFD');
    assert.equal(checkWord('học', nfd).correct, true);
    assert.equal(checkWord(nfd, nfd).correct, true);
    assert.equal(checkWord('hoc', nfd, { ignoreAccents: true }).correct, true);
    assert.equal(checkWord('hoc', nfd).close, true);
  });

  test('đ / Đ with and without ignoreAccents', () => {
    assert.equal(checkWord('Da Nang', 'Đà Nẵng', { ignoreAccents: true }).correct, true);
    assert.equal(checkWord('Da Nang', 'Đà Nẵng').correct, false);
    assert.equal(checkWord('đà nẵng', 'Đà Nẵng').correct, true);
  });
});

describe('checkWord: alternatives and optional parts', () => {
  test('an idiom with a comma is accepted as written, with or without the comma', () => {
    for (const idiom of ['first come, first served', 'so far, so good', 'no pain, no gain', 'easy come, easy go']) {
      assert.equal(checkWord(idiom, idiom).correct, true, idiom);
      assert.equal(checkWord(idiom.replace(',', ''), idiom).correct, true, idiom);
      assert.equal(checkWord(`${idiom[0].toUpperCase()}${idiom.slice(1)}.`, idiom).correct, true, idiom);
    }
  });

  test('comma alternatives and numbers still behave', () => {
    assert.equal(checkWord('color', 'colour, color').correct, true);
    assert.equal(checkWord('colour', 'colour, color').correct, true);
    assert.equal(checkWord('1,000', '1,000').correct, true);
    assert.equal(checkWord('1', '1,000').correct, false);
  });

  test('a word-level slash choice typed exactly as written is accepted', () => {
    assert.equal(checkWord('and/or', 'and/or').correct, true);
    assert.equal(checkWord('look after sb/sth', 'look after sb/sth').correct, true);
    assert.equal(checkWord('look after someone/something', 'look after sb/sth').correct, true);
    assert.equal(checkWord('colour/color', 'colour/color').correct, true);
    assert.equal(checkWord('look after sb', 'look after sb/sth').correct, true);
  });

  test('a particle in parentheses is optional, never a spelling variant', () => {
    for (const [answer, particle, full, base] of [
      ['opt (out)', 'out', 'opt out', 'opt'],
      ['move (over)', 'over', 'move over', 'move'],
      ['bow (down)', 'down', 'bow down', 'bow'],
      ['eat (out)', 'out', 'eat out', 'eat'],
    ]) {
      assert.equal(checkWord(particle, answer).correct, false, answer);
      assert.equal(checkWord(full, answer).correct, true, answer);
      assert.equal(checkWord(base, answer).correct, true, answer);
    }
  });

  test('real spelling variants in parentheses still count', () => {
    assert.equal(checkWord('math', 'maths (math)').correct, true);
    assert.equal(checkWord('gray', 'grey (gray)').correct, true);
    assert.equal(checkWord('airplane', 'aeroplane (airplane)').correct, true);
    assert.equal(checkWord('realize', 'realise (realize)').correct, true);
  });

  test('nested optional groups', () => {
    for (const input of ['a', 'a b', 'a b c']) assert.equal(checkWord(input, 'a (b (c))').correct, true, input);
    assert.equal(checkWord('a c', 'a (b (c))').correct, false);
  });

  test('many optional groups stay bounded and fast', () => {
    const answer = `go ${Array.from({ length: 14 }, (_, i) => `(w${i})`).join(' ')}`;
    const { result, ms } = timed(() => checkWord('go', answer));
    assert.equal(result.correct, true);
    assert.ok(ms < 200, `took ${ms} ms`);
  });
});

describe('checkWord: leading "to"', () => {
  test('raw or spelled-out verb tags', () => {
    for (const pos of ['(v)', 'V.', 'Verb', 'động từ', 'vt', 'phrasal verb', 'v (transitive)']) {
      assert.equal(checkWord('to acquit', 'acquit', { pos }).correct, true, pos);
    }
    for (const pos of ['adv', 'adv phr', '(adj)', 'noun']) {
      assert.equal(checkWord('to acquit', 'acquit', { pos }).correct, false, pos);
    }
  });

  test('list 378: verbs accept a leading "to", other parts of speech do not', () => {
    const entries = listEntries(fixture('list-378.txt'));
    assert.equal(entries.length, 11);
    for (const { word, pos } of entries) {
      assert.equal(checkWord(word, word, { pos }).correct, true, word);
      assert.equal(checkWord(`${word.toUpperCase()}.`, word, { pos }).correct, true, word);
      assert.equal(checkWord(`to ${word}`, word, { pos }).correct, pos === 'v', `${word} (${pos})`);
    }
  });

  test('new-terms list: placeholders, phrasal verbs and slash alternatives', () => {
    const text = fixture('oneline-new-terms.txt');
    for (const line of ['accuse (sb) of (sth) (v)', 'come up with (phr v)', 'colour / color (n)']) {
      assert.ok(text.includes(line), line);
    }
    assert.equal(checkWord('to accuse someone of something', 'accuse (sb) of (sth)', { pos: 'v' }).correct, true);
    assert.equal(checkWord('To come up with', 'come up with', { pos: 'phr v' }).correct, true);
    assert.equal(checkWord('color', 'colour / color', { pos: 'n' }).correct, true);
    assert.equal(checkWord('to colour', 'colour / color', { pos: 'n' }).correct, false);
  });

  test('family list: "(verb)" accepts a leading "to"', () => {
    assert.ok(fixture('family.txt').includes('impoverish (verb)'));
    assert.equal(checkWord('to impoverish', 'impoverish', { pos: 'verb' }).correct, true);
    assert.equal(checkWord('to poorness', 'poorness', { pos: 'noun' }).correct, false);
  });
});

describe('checkWord: close boundaries', () => {
  test('answers of up to 4 letters allow exactly 1 edit', () => {
    assert.equal(checkWord('jolts', 'jolt').close, true);
    assert.equal(checkWord('jo', 'jolt').close, false);
    assert.equal(checkWord('b', 'a').close, true);
  });

  test('answers of 5 or more letters allow exactly 2 edits', () => {
    assert.equal(checkWord('sale', 'stale').close, true);
    assert.equal(checkWord('sal', 'stale').close, true);
    assert.equal(checkWord('sa', 'stale').close, false);
    assert.equal(checkWord('stlae', 'stale').close, true); // a swap is 2 edits
  });

  test('an accent counts as one edit', () => {
    assert.equal(checkWord('ngay', 'ngày').close, true);
    assert.equal(checkWord('ngay', 'ngày'.normalize('NFD')).close, true);
  });

  test('multi-word answers count letters, not spaces', () => {
    assert.equal(checkWord('a c', 'a b').close, true);
    assert.equal(checkWord('x c', 'a b').close, false);
  });

  test('close is never true together with correct', () => {
    for (const [input, answer] of [['acquit', 'acquit'], ['color', 'colour / color'], ['to jolt', 'jolt']]) {
      const r = checkWord(input, answer, { pos: 'v' });
      assert.equal(r.correct, true, input);
      assert.equal(r.close, false, input);
    }
  });
});

describe('checkWord: robustness', () => {
  test('frozen options are fine and stay untouched', () => {
    const opts = Object.freeze({ pos: 'v', ignoreAccents: true });
    assert.equal(checkWord('to acquit', 'acquit', opts).correct, true);
    assert.deepEqual(opts, { pos: 'v', ignoreAccents: true });
  });

  test('non-string answers', () => {
    assert.deepEqual(checkWord('3', 3), { correct: true, close: false, expected: '3' });
    assert.deepEqual(checkWord('x', undefined), { correct: false, close: false, expected: '' });
    assert.deepEqual(checkWord('x', ''), { correct: false, close: false, expected: '' });
  });

  test('huge input or answer finishes quickly', () => {
    const huge = timed(() => checkWord('x'.repeat(100000), 'colour / color / colo(u)r'));
    assert.equal(huge.result.correct, false);
    assert.ok(huge.ms < 1000, `took ${huge.ms} ms`);
    const many = timed(() => checkWord('w1999', Array.from({ length: 2000 }, (_, i) => `w${i}`).join(', ')));
    assert.equal(many.result.correct, true);
    assert.ok(many.ms < 1000, `took ${many.ms} ms`);
  });
});

describe('checkForm: edge cases', () => {
  test('a leading "to" in the typed answer is the right word in the wrong form', () => {
    assert.deepEqual(checkForm('to acquit', 'acquitted', 'acquit'), { correct: false, rightWordWrongForm: true });
    assert.deepEqual(checkForm('to acquitted', 'acquitted', 'acquit'), { correct: false, rightWordWrongForm: true });
  });

  test('a list word written with "to"', () => {
    assert.equal(checkForm('acquit', 'acquitted', 'to acquit').rightWordWrongForm, true);
    assert.equal(checkForm('to acquit', 'acquitted', 'to acquit').rightWordWrongForm, true);
    assert.equal(checkForm('acquitting', 'acquitted', 'to acquit').rightWordWrongForm, true);
  });

  test('invisible characters and decomposed letters', () => {
    assert.equal(checkForm('acquit\u00adted', 'acquitted', 'acquit').correct, true);
    assert.equal(checkForm('\u200bacquitted', 'acquitted', 'acquit').correct, true);
    assert.equal(checkForm('học', 'học'.normalize('NFD'), 'học').correct, true);
  });

  test('iPhone input: capitalised, auto-period, curly apostrophe', () => {
    assert.equal(checkForm('Acquitted.', 'acquitted', 'acquit').correct, true);
    assert.equal(checkForm('Didn’t', "didn't", 'do').correct, true);
  });

  test('empty or missing answer and lemma never throw', () => {
    assert.deepEqual(checkForm('x', '', ''), { correct: false, rightWordWrongForm: false });
    assert.deepEqual(checkForm('x', null, undefined), { correct: false, rightWordWrongForm: false });
    assert.deepEqual(checkForm('', '', ''), { correct: false, rightWordWrongForm: false });
    assert.deepEqual(checkForm(undefined, 'jolted', 'jolt'), { correct: false, rightWordWrongForm: false });
  });

  test('multi-word forms and placeholder lemmas', () => {
    assert.equal(checkForm('look after', 'looked after', 'look after sb/sth').rightWordWrongForm, true);
    assert.equal(checkForm('accuse', 'accused', 'accuse (sb) of (sth)').rightWordWrongForm, true);
    assert.equal(checkForm('came up with', 'came up with', 'come up with').correct, true);
  });

  test('frozen options', () => {
    assert.equal(checkForm('cafe', 'café', 'café', Object.freeze({ ignoreAccents: true })).correct, true);
  });
});

describe('diffWords: invisible characters and Unicode', () => {
  test('invisible characters in either text are ignored', () => {
    for (const [name, ch] of Object.entries(INVISIBLE)) {
      const r = diffWords(`inter${ch}operability matters`, `interoperability matters${ch}`);
      assert.equal(r.correct, true, name);
      assert.equal(r.ops.length, 2, name);
      assert.equal(diffWords('acquit him', `acq${ch}uit him`).correct, true, name);
    }
  });

  test('decomposed text with ignoreCase false', () => {
    assert.equal(diffWords('Học tiếng Anh', 'Học tiếng Anh'.normalize('NFD'), { ignoreCase: false }).correct, true);
    assert.equal(diffWords('Học', 'học'.normalize('NFD'), { ignoreCase: false }).correct, false);
  });

  test('Vietnamese with đ and ignoreAccents; display keeps the accents', () => {
    const expected = 'Đà Nẵng là thành phố đẹp.';
    const r = diffWords(expected, 'Da Nang la thanh pho dep', { ignoreAccents: true });
    assert.equal(r.correct, true);
    assert.deepEqual(r.ops[0], { type: 'equal', expected: 'Đà', actual: 'Da' });
    assert.equal(diffWords(expected, 'Da Nang la thanh pho dep').score, 0);
  });

  test('U+2028, U+2029 and a lone CR are line breaks', () => {
    const r = diffWords('one\u2028two\u2029three\rfour', 'one two three four');
    assert.deepEqual(types(r.ops), ['equal', 'break', 'equal', 'break', 'equal', 'break', 'equal']);
  });

  test('whitespace-only lines between paragraphs count as one break', () => {
    const r = diffWords('one\n \t \n\u00a0\n\u3000\ntwo', 'one two');
    assert.deepEqual(types(r.ops), ['equal', 'break', 'equal']);
  });

  test('Unicode spaces separate words', () => {
    const r = diffWords('a\u00a0b\u202fc\u3000d\te', 'a b c d e');
    assert.equal(r.correct, true);
    assert.equal(r.ops.length, 5);
  });
});

describe('diffWords: punctuation', () => {
  test('an em dash between two words separates them', () => {
    const expected = 'She wasn’t angry—just tired.';
    for (const typed of [
      "She wasn't angry, just tired.",
      "She wasn't angry — just tired",
      "she wasn't angry just tired",
      "She wasn't angry--just tired.",
      'She wasn’t angry—just tired.',
    ]) {
      assert.equal(diffWords(expected, typed).correct, true, typed);
    }
    const r = diffWords(expected, "She wasn't angry, just tired.");
    assert.deepEqual(r.ops[2], { type: 'equal', expected: 'angry—', actual: 'angry,' });
    assert.equal(r.ops.length, 5);
  });

  test('"--", the horizontal bar and an unspaced ellipsis also separate words', () => {
    assert.equal(diffWords('cold--very cold', 'cold very cold').correct, true);
    assert.equal(diffWords('yes\u2015no', 'yes no').correct, true);
    assert.equal(diffWords('Wait…what?', 'wait what').correct, true);
    assert.equal(diffWords('Wait...what?', 'wait what').correct, true);
  });

  test('hyphens and en-dash ranges stay inside one word', () => {
    assert.deepEqual(changes(diffWords('level-headed', 'level headed').ops), [
      { type: 'wrong', expected: 'level-headed', actual: 'level' },
      { type: 'extra', actual: 'headed' },
    ]);
    assert.equal(diffWords('1990–2000', '1990-2000').correct, true);
    assert.equal(diffWords('e.g. U.S.A.', 'e.g. U.S.A.').ops.length, 2);
  });

  test('dashes and markup at word edges are punctuation', () => {
    assert.equal(diffWords('I was—', 'I was').correct, true);
    assert.equal(diffWords('—and then', 'and then').correct, true);
    assert.equal(diffWords('a **bold** and _quiet_ word', 'a bold and quiet word').correct, true);
    assert.equal(diffWords('I was—', 'I was', { ignorePunctuation: false }).correct, false);
  });

  test('with ignorePunctuation false, "…" equals "..." and curly quotes equal straight ones', () => {
    assert.equal(diffWords('Wait…', 'Wait...', { ignorePunctuation: false }).correct, true);
    assert.equal(diffWords('‘Hi,’ she said.', "'Hi,' she said.", { ignorePunctuation: false }).correct, true);
    assert.equal(diffWords('it\u2032s', "it's", { ignorePunctuation: false }).correct, true);
  });
});

describe('diffWords: alignment does not cascade', () => {
  test('a missing first word', () => {
    const r = diffWords('The jury acquitted him of all charges.', 'jury acquitted him of all charges.');
    assert.deepEqual(changes(r.ops), [{ type: 'missing', expected: 'The' }]);
    assert.equal(count(r.ops, 'equal'), 6);
  });

  test('a wrong first and last word', () => {
    const r = diffWords('The jury acquitted him of all charges.', 'A jury acquitted him of all charge');
    assert.deepEqual(changes(r.ops), [
      { type: 'wrong', expected: 'The', actual: 'A' },
      { type: 'wrong', expected: 'charges.', actual: 'charge' },
    ]);
  });

  test('a doubled word that the learner typed once', () => {
    const r = diffWords('I think that that is right', 'I think that is right');
    assert.equal(changes(r.ops).length, 1);
    assert.equal(changes(r.ops)[0].type, 'missing');
    assert.equal(count(r.ops, 'equal'), 5);
  });

  test('two swapped words cost two changes, not the rest of the line', () => {
    const r = diffWords('he quickly ran home after school today', 'he ran quickly home after school today');
    assert.equal(changes(r.ops).length, 2);
    assert.ok(r.ops.slice(-4).every((op) => op.type === 'equal'));
  });

  test('a whole skipped line is missing; the next line still matches', () => {
    const passage = fixture('passage.txt');
    const lines = passage.split('\n');
    const skipped = lines[2];
    const typed = [lines[0], lines[3]].join(' ');
    const r = diffWords(passage, typed);
    assert.deepEqual(changes(r.ops), skipped.split(' ').map((w) => ({ type: 'missing', expected: w })));
    assert.equal(count(r.ops, 'break'), 2);
    const lastLine = r.ops.slice(r.ops.lastIndexOf(r.ops.findLast((op) => op.type === 'break')) + 1);
    assert.ok(lastLine.every((op) => op.type === 'equal'));
  });

  test('long realistic passage (fast path): typos at both ends and one skipped sentence', () => {
    const reply = fixture('reply-378.md');
    const { sentences } = JSON.parse(/```json\s*([\s\S]*?)```/.exec(reply)[1]);
    const lines = sentences.flatMap((s) => [s.text.replace(/\[\[|\]\]/g, ''), s.vi]);
    assert.ok(lines.join(' ').split(' ').length > 500); // beyond the exact LCS limit
    const typed = lines.slice();
    typed[0] = typed[0].replace('warehouse', 'warehose');
    typed[typed.length - 1] = typed[typed.length - 1].replace('lý trí', 'ly tri');
    const [skipped] = typed.splice(18, 1);
    const r = diffWords(lines.join('\n'), typed.join(' '));
    assert.deepEqual(changes(r.ops), [
      { type: 'wrong', expected: 'warehouse', actual: 'warehose' },
      ...skipped.split(' ').map((w) => ({ type: 'missing', expected: w })),
      { type: 'wrong', expected: 'lý', actual: 'ly' },
      { type: 'wrong', expected: 'trí.', actual: 'tri.' },
    ]);
    assert.equal(count(r.ops, 'break'), lines.length - 1);
  });

  test('exact and fast alignment agree around the 400-word limit', () => {
    for (const n of [399, 400, 401, 1000]) {
      const words = Array.from({ length: n }, (_, i) => `w${i}`);
      const typed = words.slice();
      typed[0] = 'x0';
      typed[n - 1] = 'xlast';
      typed.splice(Math.floor(n / 2), 1);
      const r = diffWords(words.join(' '), typed.join(' '));
      assert.deepEqual(changes(r.ops), [
        { type: 'wrong', expected: 'w0', actual: 'x0' },
        { type: 'missing', expected: `w${Math.floor(n / 2)}` },
        { type: 'wrong', expected: `w${n - 1}`, actual: 'xlast' },
      ], `n = ${n}`);
    }
  });
});

describe('diffWords: invariants (seeded fuzz)', () => {
  const VOCAB = ['the', 'jury', 'acquitted', 'him', 'of', 'all', 'charges', 'she', 'fumbled', 'keys', 'bus', 'jolted'];

  function randomText(rng, length) {
    const parts = [];
    for (let i = 0; i < length; i++) {
      let word = VOCAB[Math.floor(rng() * VOCAB.length)];
      if (rng() < 0.2) word = word[0].toUpperCase() + word.slice(1);
      if (rng() < 0.15) word += rng() < 0.5 ? ',' : '.';
      parts.push(word);
      if (rng() < 0.05) parts.push('—');
      parts.push(rng() < 0.1 ? (rng() < 0.5 ? '\n' : '\n\n') : ' ');
    }
    return parts.join('');
  }

  function mutate(rng, text) {
    const words = text.split(/\s+/).filter(Boolean);
    const edits = Math.floor(rng() * 6);
    for (let e = 0; e < edits; e++) {
      const at = Math.floor(rng() * (words.length + 1));
      const kind = rng();
      if (kind < 0.33) words.splice(at, 1);
      else if (kind < 0.66) words.splice(at, 0, VOCAB[Math.floor(rng() * VOCAB.length)]);
      else words[at] = 'oops';
    }
    return words.join(' ');
  }

  const wordTokens = (text) => text.split(/\s+/).filter((t) => /[a-z]/i.test(t));
  // The comparison key of the generated tokens: edge punctuation (incl. a glued "—") ignored.
  const norm = (t) => t.toLowerCase().replace(/[.,—]+$/, '');

  function checkInvariants(expected, typed, label) {
    const r = diffWords(expected, typed);
    const exp = wordTokens(expected);
    const act = wordTokens(typed);
    // Every expected word appears exactly once, in order; same for typed words.
    assert.deepEqual(r.ops.filter((op) => 'expected' in op).map((op) => op.expected), exp, label);
    assert.deepEqual(r.ops.filter((op) => 'actual' in op).map((op) => op.actual), act, label);
    // correct, score and rounding.
    const changed = changes(r.ops).length;
    assert.equal(r.correct, changed === 0, label);
    assert.ok(r.score >= 0 && r.score <= 1, label);
    assert.equal(Math.round(r.score * 1000) / 1000, r.score, label);
    if (r.correct) assert.equal(r.score, 1, label);
    // Breaks: never first or last, never doubled, always before an expected word.
    r.ops.forEach((op, k) => {
      if (op.type !== 'break') return;
      assert.ok(k > 0 && k < r.ops.length - 1, label);
      assert.ok('expected' in r.ops[k + 1], label);
    });
    // After pairing, one run of changes never holds both missing and extra.
    let run = new Set();
    for (const op of [...r.ops, { type: 'equal' }]) {
      if (op.type === 'equal') {
        assert.ok(!(run.has('missing') && run.has('extra')), label);
        run = new Set();
      } else if (op.type !== 'break') run.add(op.type);
    }
    return { r, exp, act };
  }

  test('short texts: invariants hold and equal words = LCS length', () => {
    const rng = makeRng(378);
    for (let round = 0; round < 300; round++) {
      const expected = randomText(rng, 1 + Math.floor(rng() * 30));
      const typed = rng() < 0.1 ? randomText(rng, Math.floor(rng() * 20)) : mutate(rng, expected);
      const { r, exp, act } = checkInvariants(expected, typed, `round ${round}`);
      assert.equal(count(r.ops, 'equal'), lcsLength(exp.map(norm), act.map(norm)), `round ${round}`);
    }
  });

  test('long texts on the fast path keep the invariants', () => {
    const rng = makeRng(2024);
    for (let round = 0; round < 6; round++) {
      const expected = randomText(rng, 500 + Math.floor(rng() * 400));
      checkInvariants(expected, mutate(rng, expected), `long round ${round}`);
    }
  });
});

describe('diffWords: immutability and determinism', () => {
  test('frozen options, repeatable results, results not shared between calls', () => {
    const opts = Object.freeze({ ignoreCase: true, ignorePunctuation: true, ignoreAccents: false });
    const a = diffWords('one two\nthree', 'one too three', opts);
    const b = diffWords('one two\nthree', 'one too three', opts);
    assert.deepEqual(a, b);
    a.ops[0].type = 'tampered';
    a.ops.length = 0;
    assert.deepEqual(diffWords('one two\nthree', 'one too three', opts), b);
    assert.equal(b.ops[0].type, 'equal');
  });
});

describe('large inputs stay fast (2,000 lines)', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `Line ${i}: the quick brown fox number ${i} jumps over the lazy dog, again.`);
  const passage = lines.join('\n');
  const typed = passage.replace('number 5 ', 'numbr 5 ').replace('number 1995 ', 'numbr 1995 ');
  const unrelated = Array.from({ length: 2000 }, (_, i) => `zz${i} yy${i} xx${i} ww${i} vv${i} uu${i}`).join('\n');

  test('diffWords: two typos far apart', () => {
    const { result, ms } = timed(() => diffWords(passage, typed));
    assert.ok(ms < 1500, `took ${ms} ms`);
    assert.deepEqual(changes(result.ops), [
      { type: 'wrong', expected: 'number', actual: 'numbr' },
      { type: 'wrong', expected: 'number', actual: 'numbr' },
    ]);
    assert.equal(count(result.ops, 'break'), 1999);
    assert.equal(result.correct, false);
  });

  test('diffWords: completely unrelated text', () => {
    const { result, ms } = timed(() => diffWords(passage, unrelated));
    assert.ok(ms < 1500, `took ${ms} ms`);
    assert.equal(result.score, 0);
    assert.equal(count(result.ops, 'equal'), 0);
  });

  test('similarity: near-identical and unrelated', () => {
    const near = timed(() => similarity(passage, typed));
    assert.ok(near.ms < 1500, `took ${near.ms} ms`);
    assert.ok(near.result > 0.999 && near.result < 1);
    const far = timed(() => similarity(passage, unrelated));
    assert.ok(far.ms < 1500, `took ${far.ms} ms`);
    assert.equal(far.result, 0);
  });

  test('long runs of punctuation do not backtrack', () => {
    const run = `a${'. '.repeat(20000)}b`;
    const sim = timed(() => similarity(run, 'a b'));
    assert.equal(sim.result, 1);
    assert.ok(sim.ms < 500, `took ${sim.ms} ms`);
    const diff = timed(() => diffWords(run, 'a b'));
    assert.equal(diff.result.correct, true);
    assert.ok(diff.ms < 500, `took ${diff.ms} ms`);
  });
});

describe('similarity: edge cases', () => {
  test('an em dash separates words, a hyphen does not', () => {
    assert.equal(similarity('angry—just tired', 'angry just tired'), 1);
    assert.equal(similarity('level-headed', 'level headed'), 0);
    assert.equal(similarity('level\u2011headed', 'level-headed'), 1); // non-breaking hyphen
  });

  test('invisible characters, NFD and curly quotes', () => {
    assert.equal(similarity('inter\u00adoperability', 'interoperability'), 1);
    assert.equal(similarity('acq\u200buit him', 'acquit him'), 1);
    assert.equal(similarity('Tôi đi học', 'Tôi đi học'.normalize('NFD')), 1);
    assert.equal(similarity('it’s fine', "it's fine"), 1);
  });

  test('seeded fuzz: symmetric, within 0..1, 1 for identical text', () => {
    const rng = makeRng(7);
    const vocab = ['a', 'b', 'c', 'học', 'đi', 'Don’t', 'x-y'];
    const text = () => Array.from({ length: Math.floor(rng() * 12) }, () => vocab[Math.floor(rng() * vocab.length)]).join(' ');
    for (let round = 0; round < 200; round++) {
      const a = text();
      const b = text();
      const s = similarity(a, b);
      assert.ok(s >= 0 && s <= 1);
      assert.equal(s, similarity(b, a));
      assert.equal(similarity(a, a), 1);
    }
  });
});

describe('levenshtein: properties', () => {
  test('canonically equal strings have distance 0', () => {
    assert.equal(levenshtein('học', 'học'.normalize('NFD')), 0);
    assert.equal(levenshtein('ngày', 'ngay'.normalize('NFD')), 1);
    assert.equal(levenshtein('ộ'.normalize('NFD'), 'o'), 1);
  });

  test('seeded fuzz: metric properties', () => {
    const rng = makeRng(11);
    const alphabet = ['a', 'b', 'ộ', '😀', 'đ'];
    const word = () => Array.from({ length: Math.floor(rng() * 8) }, () => alphabet[Math.floor(rng() * alphabet.length)]).join('');
    const len = (s) => Array.from(s).length;
    for (let round = 0; round < 300; round++) {
      const [a, b, c] = [word(), word(), word()];
      const d = levenshtein(a, b);
      assert.equal(d, levenshtein(b, a));
      assert.equal(d === 0, a === b);
      assert.ok(d <= Math.max(len(a), len(b)) && d >= Math.abs(len(a) - len(b)));
      assert.ok(levenshtein(a, c) <= d + levenshtein(b, c));
    }
  });

  test('3,000 × 3,000 characters finishes quickly', () => {
    const { result, ms } = timed(() => levenshtein('a'.repeat(3000), 'b'.repeat(3000)));
    assert.equal(result, 3000);
    assert.ok(ms < 1500, `took ${ms} ms`);
  });
});
