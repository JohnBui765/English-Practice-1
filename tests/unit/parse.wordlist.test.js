// Plain word lists and family roots (docs/architecture.md, "Word families from
// Claude" → Parsing).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectFormat, parseList, KIND_BY_FORMAT } from '../../js/core/parse.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

const ROOTS = { kind: 'family', roots: true };
const roots = (text, options = ROOTS) => parseList(text, options).items.map((item) => item.root);
const withoutIds = (items) => items.map(({ id, ...rest }) => rest);
const pending = (root, rootPos = '', rootMeaning = '') => ({ root, rootPos, rootMeaning, note: '', members: [] });

// ---------------------------------------------------------------------------

describe('detectFormat: plain word lists', () => {
  test('family-words.txt is a word list', () => {
    assert.equal(detectFormat(fixture('family-words.txt')), 'wordlist');
  });

  test('one word per line, numbered, bulleted, comma and semicolon lists', () => {
    for (const text of [
      'authority\ndemonstrate\nable',
      'authority\r\n\r\ndemonstrate\r\n',
      '1. authority\n2) demonstrate\n3/ able',
      '• authority\n- demonstrate\n* able\n– decide',
      'authority, demonstrate, able',
      'authority; demonstrate;able',
      '1. authority, demonstrate\n2. able',
      'acquit',
      'come up with\nlevel-headed\ncolour / color',
      'Authority\nDemonstrate\nCome up with', // iOS capitalises each line
    ]) {
      assert.equal(detectFormat(text), 'wordlist', JSON.stringify(text));
    }
  });

  test('a title line above the words', () => {
    for (const text of [
      'Families 12\nauthority\ndecide',
      '378.\n\nauthority\ndecide',
      '# Unit five\nauthority\ndecide',
      'My words:\nauthority\ndecide',
      'Travel words\n\nluggage\npassport',
    ]) {
      assert.equal(detectFormat(text), 'wordlist', JSON.stringify(text));
    }
  });

  test('a part of speech or IPA without a meaning is still a word list', () => {
    assert.equal(detectFormat('authority (n)\ndemonstrate (v) /ˈdemənstreɪt/'), 'wordlist');
    assert.equal(detectFormat('1. repository (n) /rɪˈpɑːzətɔːri/'), 'wordlist');
  });

  test('every existing format keeps its detection', () => {
    const expected = {
      'list-378.txt': 'oneline',
      'list-378-messy.txt': 'oneline',
      'list-crlf.txt': 'oneline',
      'oneline-new-terms.txt': 'oneline',
      'block-full.txt': 'block',
      'family.txt': 'family',
      'passage.txt': 'passage',
      'reply-378.md': 'passage',
      'family-reply.md': 'passage',
      'family-roots.txt': 'oneline', // the owner's one-line format: a vocabulary list
    };
    for (const [name, format] of Object.entries(expected)) assert.equal(detectFormat(fixture(name)), format, name);
  });

  test('sentences, meanings and to-do lists are not word lists', () => {
    for (const text of [
      '1. Wake up early\n2. Read the news',
      'Buy milk\nCall mom\nWalk the dog',
      'Thank you',
      'Hello everyone.',
      '# My speech\n\nHello everyone.',
      'Remember: practice makes perfect.',
      'A: How are you?\nB: Fine, thanks.',
      'First paragraph.\n\n---\n\nSecond paragraph.',
      'authority: quyền lực\ndemonstrate: chứng minh',
      'authority - quyền lực',
      'this line has far too many words to be one',
      'Families 12',
      'x - - - -',
      'room 101',
    ]) {
      assert.notEqual(detectFormat(text), 'wordlist', JSON.stringify(text));
    }
  });

  test('KIND_BY_FORMAT: a word list is a family list', () => {
    assert.equal(KIND_BY_FORMAT.wordlist, 'family');
    assert.deepEqual({ ...KIND_BY_FORMAT }, {
      oneline: 'vocab', block: 'vocab', family: 'family', passage: 'passage', wordlist: 'family',
    });
    assert.ok(Object.isFrozen(KIND_BY_FORMAT));
  });
});

// ---------------------------------------------------------------------------

describe('parseList: a detected word list becomes pending families', () => {
  test('family-words.txt', () => {
    const result = parseList(fixture('family-words.txt'));
    assert.equal(result.kind, 'family');
    assert.equal(result.format, 'roots');
    assert.equal(result.title, '');
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(withoutIds(result.items), [
      pending('authority'), pending('demonstrate'), pending('able'), pending('decide'), pending('come up with'),
    ]);
  });

  test('FamilyItem has exactly the documented fields, with unique string ids', () => {
    const { items } = parseList(fixture('family-roots.txt'), ROOTS);
    for (const item of items) {
      assert.deepEqual(Object.keys(item).sort(), ['id', 'members', 'note', 'root', 'rootMeaning', 'rootPos']);
      assert.equal(typeof item.id, 'string');
    }
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
    assert.deepEqual(Object.keys(parseList('authority')).sort(), ['format', 'items', 'kind', 'title', 'warnings']);
  });

  test('detectFormat and parseList agree', () => {
    for (const text of ['authority\ndecide', fixture('family-words.txt'), 'Families 12\nable', fixture('passage.txt')]) {
      assert.equal(detectFormat(text) === 'wordlist', parseList(text).format === 'roots', JSON.stringify(text));
    }
  });

  test('kind "family" without roots keeps the written-out family parser', () => {
    const written = parseList(fixture('family.txt'), { kind: 'family' });
    assert.equal(written.format, 'family');
    assert.equal(written.items.length, 2);
    assert.equal(parseList(fixture('family.txt')).format, 'family');
    assert.equal(parseList('authority\ndecide', { kind: 'family' }).format, 'family');
    assert.equal(parseList('authority\ndecide', { kind: 'family', roots: false }).format, 'family');
  });

  test('roots: true alone means family roots; a forced vocab or passage kind wins', () => {
    const alone = parseList(fixture('family-roots.txt'), { roots: true });
    assert.equal(alone.kind, 'family');
    assert.equal(alone.format, 'roots');
    assert.equal(parseList('authority\ndecide', { kind: 'vocab' }).kind, 'vocab');
    assert.equal(parseList('authority\ndecide', { kind: 'passage', roots: true }).format, 'passage');
    assert.equal(parseList(fixture('family-roots.txt')).kind, 'vocab');
  });
});

// ---------------------------------------------------------------------------

describe('parseList roots: every list format', () => {
  test('family-roots.txt: one-line format with a "Families 12" title', () => {
    const result = parseList(fixture('family-roots.txt'), ROOTS);
    assert.equal(result.kind, 'family');
    assert.equal(result.format, 'roots');
    assert.equal(result.title, 'Families 12');
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(withoutIds(result.items), [
      pending('authority', 'n', 'quyền lực, thẩm quyền'),
      pending('demonstrate', 'v', 'chứng minh, cho thấy rõ'),
      pending('able', 'adj', 'có thể, có khả năng'),
      pending('decide', 'v', 'quyết định'),
      pending('come up with', 'phr v', 'nghĩ ra, nảy ra (ý tưởng)'),
    ]);
  });

  test('the owner\'s list-378 format: senses joined with "; ", synonyms left out', () => {
    const result = parseList(fixture('list-378.txt'), ROOTS);
    assert.equal(result.title, '378');
    assert.deepEqual(result.warnings, []);
    assert.equal(result.items.length, 11);
    const [repository, , , acquit] = result.items;
    assert.deepEqual(withoutIds([repository, acquit]), [
      pending('repository', 'n', 'nơi lưu trữ đồ đạc số lượng lớn; người nắm được nhiều kiến thức hay thông tin'),
      pending('acquit', 'v', 'tuyên chính thức vô tội tại tòa; tự mình thể hiện một màn trình diễn trong công việc như thế nào đó'),
    ]);
    const unadorned = result.items.find((item) => item.root === 'unadorned');
    assert.equal(unadorned.rootMeaning, 'tính không hoa lá màu mè - chỉ giản đơn mộc mạc');
    assert.equal(result.items.find((item) => item.root === 'progressive').rootMeaning.split('; ').length, 4);
  });

  test('messy list-378: wrapped lines continue the meaning', () => {
    const result = parseList(fixture('list-378-messy.txt'), ROOTS);
    assert.deepEqual(result.items.map((item) => item.root), ['repository', 'interoperability', 'aggregate', 'acquit']);
    assert.equal(result.items[0].rootMeaning, 'nơi lưu trữ đồ đạc số lượng lớn; người nắm được nhiều kiến thức hay thông tin');
    assert.deepEqual(result.warnings, []);
  });

  test('block format: the Definition is the meaning', () => {
    const result = parseList(fixture('block-full.txt'), ROOTS);
    assert.deepEqual(withoutIds(result.items), [
      pending('level-headed', '', 'Calm and rational when facing difficulties or stressful situations'),
      pending('Decipher', '', 'To convert secret codes or encrypted messages back into readable text'),
    ]);
  });

  test('written-out families: every member becomes a root', () => {
    const result = parseList(fixture('family.txt'), ROOTS);
    assert.deepEqual(result.items.map((item) => [item.root, item.rootPos]), [
      ['poorness', 'n'], ['impoverish', 'v'], ['poor', 'adj'], ['poorly', 'adv'],
      ['creation', 'n'], ['creator', 'n'], ['creativity', 'n'], ['create', 'v'], ['creative', 'adj'],
    ]);
    assert.equal(result.items[1].rootMeaning, 'to make poor; to reduce to poverty');
  });

  test('plain, numbered and bulleted lines', () => {
    const expected = ['authority', 'demonstrate', 'able'];
    assert.deepEqual(roots('authority\ndemonstrate\nable'), expected);
    assert.deepEqual(roots('1. authority\n2) demonstrate\n3/ able'), expected);
    assert.deepEqual(roots('• authority\n- demonstrate\n* able'), expected);
    assert.deepEqual(roots('  authority  \n\n\tdemonstrate\n\n\nable  '), expected);
  });

  test('comma and semicolon lists, also inside numbered lines', () => {
    assert.deepEqual(roots('authority, demonstrate; able ,decide'), ['authority', 'demonstrate', 'able', 'decide']);
    assert.deepEqual(roots('1. authority, demonstrate\n2. able'), ['authority', 'demonstrate', 'able']);
    // A comma inside brackets is not a separator.
    assert.deepEqual(roots('present (n, v), gift'), ['present', 'gift']);
    assert.equal(parseList('present (n, v), gift', ROOTS).items[0].rootPos, 'n/v');
  });

  test('part of speech and IPA on plain lines', () => {
    const result = parseList('authority (n) /əˈθɔːrəti/\ndemonstrate (verb)\nable', ROOTS);
    assert.deepEqual(withoutIds(result.items), [pending('authority', 'n'), pending('demonstrate', 'v'), pending('able')]);
  });

  test('a meaning after ":", a spaced dash, "=" or "→" on plain lines', () => {
    const result = parseList('authority (n): quyền lực\ndemonstrate\nable - có thể\ndecide: quyết định\njolt = giật\nfumble → lóng ngóng', ROOTS);
    assert.deepEqual(withoutIds(result.items), [
      pending('authority', 'n', 'quyền lực'),
      pending('demonstrate'),
      pending('able', '', 'có thể'),
      pending('decide', '', 'quyết định'),
      pending('jolt', '', 'giật'),
      pending('fumble', '', 'lóng ngóng'),
    ]);
  });

  test('numbered words without a meaning next to ones with a meaning', () => {
    const result = parseList('378.\n1. acquit (v): tha bổng\n2. understudy (v)\n3. jolt (v): xóc', ROOTS);
    assert.equal(result.title, '378');
    assert.deepEqual(withoutIds(result.items), [
      pending('acquit', 'v', 'tha bổng'), pending('understudy', 'v'), pending('jolt', 'v', 'xóc'),
    ]);
    assert.deepEqual(result.warnings, []);
  });

  test('a word on its own line after a blank line, below a numbered list', () => {
    assert.deepEqual(roots('1. authority (n): quyền lực\n\ndemonstrate'), ['authority', 'demonstrate']);
  });

  test('case-insensitive duplicates are dropped, the first one is kept', () => {
    assert.deepEqual(roots('Decide\ndecide\nDECIDE\nable\n  decide  \n1. able'), ['Decide', 'able']);
    assert.deepEqual(roots('authority (n): quyền lực\nauthority: thẩm quyền'), ['authority']);
    assert.equal(parseList('authority (n): quyền lực\nauthority: thẩm quyền', ROOTS).items[0].rootMeaning, 'quyền lực');
  });

  test('a title line works as usual', () => {
    const titles = {
      'Families 12\nauthority\ndecide': 'Families 12',
      '378.\n\nauthority\ndecide': '378',
      '#378\nauthority': '378',
      '## Unit five\nauthority\ndecide': 'Unit five',
      'My words:\nauthority\ndecide': 'My words',
      'Travel words\n\nluggage\npassport': 'Travel words',
    };
    for (const [text, title] of Object.entries(titles)) {
      const result = parseList(text, ROOTS);
      assert.equal(result.title, title, text);
      assert.equal(result.items.length, text.includes('luggage') ? 2 : text.includes('decide') ? 2 : 1, text);
      assert.deepEqual(result.warnings, [], text);
      assert.equal(parseList(text).title, title, `${text} (auto)`);
    }
    // Words set apart by blank lines are words, not a title.
    assert.deepEqual(roots('authority\n\ndemonstrate\n\nable'), ['authority', 'demonstrate', 'able']);
    assert.deepEqual(roots('Authority\n\nDemonstrate\nAble'), ['Authority', 'Demonstrate', 'Able']);
  });

  test('a number heading between two lists is skipped', () => {
    const result = parseList('378.\nauthority\n\n379.\ndecide', ROOTS);
    assert.equal(result.title, '378');
    assert.deepEqual(result.items.map((item) => item.root), ['authority', 'decide']);
    assert.deepEqual(result.warnings, []);
  });

  test('phrases, slashes, markdown and quotes', () => {
    assert.deepEqual(
      roots('accuse (sb) of (sth)\ncolour / color\nlevel-headed\n**authority**\n“come up with”\nsb\'s'),
      ['accuse (sb) of (sth)', 'colour / color', 'level-headed', 'authority', 'come up with', "sb's"],
    );
  });

  test('lines that are not words are reported, not turned into roots', () => {
    const long = parseList('1. This is a long sentence about nothing at all.\n2. able', ROOTS);
    assert.deepEqual(long.items.map((item) => item.root), ['able']);
    assert.deepEqual(long.warnings.map((w) => w.line), [1]);
    assert.ok(long.warnings[0].reason.length > 0);

    const passage = parseList(fixture('passage.txt'), ROOTS);
    assert.deepEqual(passage.items, []);
    assert.ok(passage.warnings.length > 0);
  });

  test('a to-do list forced into roots still works', () => {
    assert.deepEqual(roots('1. Wake up early\n2. Read the news'), ['Wake up early', 'Read the news']);
  });

  test('empty and odd input', () => {
    for (const value of ['', '   \n\n', null, undefined, 378, {}]) {
      const result = parseList(value, ROOTS);
      assert.equal(result.kind, 'family');
      assert.equal(result.format, 'roots');
      assert.deepEqual(result.items, []);
    }
  });

  test('NFD text, invisible characters and CRLF', () => {
    const text = 'quyết định\r\nauto\u00ADmatic\u200B\r\nnaïve'.normalize('NFD');
    assert.deepEqual(roots(text), ['quyết định', 'automatic', 'naïve']);
  });
});

// ---------------------------------------------------------------------------

describe('roots: robustness', () => {
  function rng(seed) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pieces = [
    '1.', '2)', '•', '-', '*', '---', '\n', '\n\n', '\r\n', ' ', ',', ';', ':', ' - ', ' = ', '378.', '#',
    'acquit', 'come up with', 'level-headed', '“quoted”', '(n)', '(v)', '(phr v)', '(sb)', '/əˈθɔːrəti/',
    'colour / color', 'nơi lưu trữ', 'tha bổng.', 'Authority', 'Families 12', 'Definition:', 'Example:', '**',
  ];

  test('2,000 random pastes: valid, unique roots with sorted warnings', () => {
    const random = rng(12);
    for (let round = 0; round < 2000; round++) {
      const length = 1 + Math.floor(random() * 30);
      const text = Array.from({ length }, () => pieces[Math.floor(random() * pieces.length)]).join(random() < 0.5 ? ' ' : '');
      const context = JSON.stringify(text);
      const result = parseList(text, ROOTS);
      assert.equal(result.format, 'roots', context);
      const keys = new Set();
      for (const item of result.items) {
        assert.ok(item.root.length > 0 && item.root === item.root.trim(), `root "${item.root}": ${context}`);
        assert.ok(/\p{L}/u.test(item.root), `no letter in root "${item.root}": ${context}`);
        assert.deepEqual(item.members, [], context);
        assert.equal(item.note, '', context);
        for (const key of ['rootPos', 'rootMeaning']) assert.equal(typeof item[key], 'string', context);
        assert.ok(!keys.has(item.root.toLowerCase()), `duplicate "${item.root}": ${context}`);
        keys.add(item.root.toLowerCase());
      }
      const lines = result.warnings.map((w) => w.line);
      assert.deepEqual(lines, [...lines].sort((a, b) => a - b), context);
      if (detectFormat(text) === 'wordlist') assert.equal(parseList(text).format, 'roots', context);
    }
  });

  test('a 2,000-word paste and pathological lines stay fast', () => {
    const time = (text, options) => {
      const start = performance.now();
      parseList(text, options);
      return performance.now() - start;
    };
    const words = Array.from({ length: 2000 }, (_, k) => `word${String.fromCharCode(97 + (k % 26))}${k}`.replace(/\d/g, (d) => 'abcdefghij'[d]));
    const big = parseList(words.join('\n'));
    assert.equal(big.format, 'roots');
    assert.equal(big.items.length, 2000);
    assert.ok(time(words.join('\n')) < 1000);
    assert.ok(time(words.join(', ')) < 1000);
    for (const text of [`x${' '.repeat(50000)}y`, `x${' - '.repeat(20000)}`, `${'a, '.repeat(5000)}`, `1. ${'(a '.repeat(10000)}`]) {
      assert.ok(time(text, {}) < 500, `${text.slice(0, 12)} (auto)`);
      assert.ok(time(text, ROOTS) < 500, `${text.slice(0, 12)} (roots)`);
    }
  });
});
