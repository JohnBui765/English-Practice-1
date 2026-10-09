import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectFormat, parseList } from '../../js/core/parse.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const byWord = (result, word) => result.items.find((item) => item.word === word);
const senses = (text) => parseList(text).items[0].senses;

describe('list-378.txt (the real list format)', () => {
  const result = parseList(fixture('list-378.txt'));

  test('list shape', () => {
    assert.equal(result.kind, 'vocab');
    assert.equal(result.format, 'oneline');
    assert.equal(result.title, '378');
    assert.equal(result.items.length, 11);
    assert.deepEqual(result.items.map((item) => item.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(result.warnings, []);
  });

  test('every item has the VocabItem fields and a unique id', () => {
    const ids = new Set(result.items.map((item) => item.id));
    assert.equal(ids.size, 11);
    for (const item of result.items) {
      assert.equal(typeof item.id, 'string');
      assert.ok(item.id.length > 0);
      assert.ok(item.senses.length >= 1);
      assert.deepEqual(item.examples, []);
      assert.equal(item.family, '');
      assert.equal(item.context, '');
    }
  });

  test('repository: pos, ipa and two senses without markers or trailing dots', () => {
    const item = result.items[0];
    assert.equal(item.word, 'repository');
    assert.equal(item.pos, 'n');
    assert.equal(item.ipa, 'rɪˈpɑːzətɔːri');
    assert.deepEqual(item.senses, [
      'nơi lưu trữ đồ đạc số lượng lớn',
      'người nắm được nhiều kiến thức hay thông tin',
    ]);
    assert.deepEqual(item.synonyms, []);
  });

  test('acquit: separator right after the pos, no ipa', () => {
    const item = byWord(result, 'acquit');
    assert.equal(item.pos, 'v');
    assert.equal(item.ipa, '');
    assert.equal(item.senses.length, 2);
    assert.equal(item.senses[0], 'tuyên chính thức vô tội tại tòa');
  });

  test('understudy: one sense that keeps " - "', () => {
    const item = byWord(result, 'understudy');
    assert.equal(item.senses.length, 1);
    assert.ok(item.senses[0].includes(' - chuẩn bị khâu công việc'));
    assert.ok(item.senses[0].endsWith('cho toàn bộ dự án'));
  });

  test('jolt: first sense without "i)" marker', () => {
    assert.deepEqual(byWord(result, 'jolt').senses, [
      'làm chuyển động mạnh bạo và bất ngờ',
      'khiến ai sốc và bắt đầu hành động',
    ]);
  });

  test('stale: a single marked sense', () => {
    assert.deepEqual(byWord(result, 'stale').senses, ['tính cũ, không được tươi mới nữa']);
  });

  test('unadorned: [=plain] becomes a synonym', () => {
    const item = byWord(result, 'unadorned');
    assert.deepEqual(item.senses, ['tính không hoa lá màu mè - chỉ giản đơn mộc mạc']);
    assert.deepEqual(item.synonyms, ['plain']);
  });

  test('progressive: four senses', () => {
    assert.deepEqual(byWord(result, 'progressive').senses, [
      'có tính ủng hộ cái mới',
      'có tính xảy ra hay phát triển ổn định',
      'liên quan đến thì tiếp diễn',
      'có tính thuế bị tính cao hơn',
    ]);
  });

  test('premise: ipa and one sense containing " - "', () => {
    const item = byWord(result, 'premise');
    assert.equal(item.ipa, 'ˈpremɪs');
    assert.deepEqual(item.senses, ['tiền đề - cơ sở lập luận']);
  });
});

describe('sense markers', () => {
  test('words that merely contain "i" are not markers', () => {
    assert.deepEqual(senses('1. x (n): đi taxi) hoặc Hawaii) và hi). ii) nghĩa hai'), [
      'đi taxi) hoặc Hawaii) và hi)',
      'nghĩa hai',
    ]);
    assert.deepEqual(senses('1. x (n): ví dụ i.e. điều này'), ['ví dụ i.e. điều này']);
  });

  test('markers after punctuation without a space', () => {
    assert.deepEqual(senses('1. x (n): i) một.ii) hai,iii) ba'), ['một', 'hai', 'ba']);
  });

  test('"(i)" style markers', () => {
    assert.deepEqual(senses('1. x (n): (i) một (ii) hai; (iii) ba.'), ['một', 'hai', 'ba']);
  });

  test('digit markers', () => {
    assert.deepEqual(senses('1. x (v): 1) một. 2) hai. 3) ba'), ['một', 'hai', 'ba']);
    assert.deepEqual(senses('1. x (v): (1) một (2) hai'), ['một', 'hai']);
  });

  test('roman numerals up to x', () => {
    const meaning = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x']
      .map((r, k) => `${r}) nghĩa ${k + 1}.`)
      .join(' ');
    assert.equal(senses(`1. x (n): ${meaning}`).length, 10);
  });

  test('never splits inside parentheses', () => {
    assert.deepEqual(senses('1. x (n): một (gồm i) cái này, ii) cái kia) thôi'), [
      'một (gồm i) cái này, ii) cái kia) thôi',
    ]);
  });

  test('a stray "(v)" or "v)" in the meaning is not a marker', () => {
    assert.deepEqual(senses('1. x (n): i) dùng như (n, v). ii) dùng như (v) nữa'), [
      'dùng như (n, v)',
      'dùng như (v) nữa',
    ]);
    assert.deepEqual(senses('1. x (n): xem thêm (v) ở trên'), ['xem thêm (v) ở trên']);
  });

  test('several synonyms in [=...]', () => {
    const item = parseList('1. plain (adj): đơn giản [= simple, unadorned; basic]').items[0];
    assert.deepEqual(item.senses, ['đơn giản']);
    assert.deepEqual(item.synonyms, ['simple', 'unadorned', 'basic']);
  });

  test('sense lines numbered "1)" "2)" under an entry ending with ":"', () => {
    const result = parseList('1. repository (n):\n1) nơi lưu trữ.\n2) người nắm thông tin.\n2. acquit (v): tha bổng');
    assert.deepEqual(result.warnings, []);
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items[0].senses, ['nơi lưu trữ', 'người nắm thông tin']);
  });

  test('bulleted sense lines under an entry ending with ":"', () => {
    const result = parseList('1. repository (n):\n- nơi lưu trữ\n- người nắm thông tin');
    assert.deepEqual(result.items[0].senses, ['nơi lưu trữ', 'người nắm thông tin']);
  });
});

describe('list-378-messy.txt', () => {
  const result = parseList(fixture('list-378-messy.txt'));

  test('no title, four items, no warnings', () => {
    assert.equal(result.title, '');
    assert.equal(result.format, 'oneline');
    assert.deepEqual(result.items.map((item) => item.word), ['repository', 'interoperability', 'aggregate', 'acquit']);
    assert.deepEqual(result.items.map((item) => item.n), [1, 2, 3, 4]);
    assert.deepEqual(result.warnings, []);
  });

  test('IPA containing ":" is not the separator', () => {
    assert.equal(result.items[0].ipa, 'rɪˈpɑ:zətɔ:ri');
    assert.equal(result.items[0].pos, 'n');
  });

  test('continuation lines join the previous entry with one space', () => {
    assert.deepEqual(result.items[0].senses, [
      'nơi lưu trữ đồ đạc số lượng lớn',
      'người nắm được nhiều kiến thức hay thông tin',
    ]);
    assert.deepEqual(result.items[1].senses, [
      'khả năng các hệ thống hay thiết bị khác nhau hoạt động cùng nhau',
    ]);
  });

  test('"2)" numbering and extra spaces', () => {
    assert.equal(result.items[1].ipa, 'ˌɪntərˌɑːpərəˈbɪləti');
    assert.deepEqual(result.items[2].senses, ['kết quả tổng từ các phần nhỏ hơn', 'cát xây dựng được trộn với xi măng']);
    assert.equal(result.items[3].pos, 'v');
    assert.equal(result.items[3].senses.length, 2);
  });
});

test('list-crlf.txt: CRLF line endings and "–" inside a sense', () => {
  const result = parseList(fixture('list-crlf.txt'));
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.items[0].senses, ['tính cũ, không được tươi mới nữa']);
  assert.equal(result.items[1].ipa, 'ˈpremɪs');
  assert.deepEqual(result.items[1].senses, ['tiền đề – cơ sở lập luận']);
  for (const item of result.items) assert.ok(!/\r/.test(JSON.stringify(item)));
});

describe('oneline-new-terms.txt', () => {
  const result = parseList(fixture('oneline-new-terms.txt'));

  test('numbering that does not start at 1', () => {
    assert.equal(result.items.length, 5);
    assert.deepEqual(result.items.map((item) => item.n), [1, 2, 3, 4, 5]);
    assert.deepEqual(result.warnings, []);
  });

  test('pos is the last parenthesised group that is a part of speech', () => {
    const item = byWord(result, 'accuse (sb) of (sth)');
    assert.ok(item, 'word keeps (sb) and (sth)');
    assert.equal(item.pos, 'v');
    assert.deepEqual(item.senses, ['buộc tội ai về điều gì']);
  });

  test('phrasal verb pos', () => {
    const item = byWord(result, 'come up with');
    assert.equal(item.pos, 'phr v');
    assert.deepEqual(item.senses, ['nghĩ ra, nảy ra (ý tưởng)']);
  });

  test('a single slash is not IPA', () => {
    const item = byWord(result, 'colour / color');
    assert.ok(item);
    assert.equal(item.ipa, '');
    assert.equal(item.pos, 'n');
  });

  test('resurrection: ipa followed directly by ":"', () => {
    const item = byWord(result, 'resurrection');
    assert.equal(item.ipa, 'ˌrezəˈrekʃn');
    assert.equal(item.senses.length, 2);
  });
});

describe('unnumbered and bulleted entries', () => {
  test('bullets •, -, *, – and plain "word (pos): meaning" lines', () => {
    const result = parseList([
      '• repository (n) /rɪˈpɑːzətɔːri/: nơi lưu trữ',
      '- acquit (v): tuyên vô tội',
      '* jolt: làm chuyển động mạnh',
      '– stale (adj): cũ',
      'premise (n): tiền đề',
    ].join('\n'));
    assert.equal(result.format, 'oneline');
    assert.deepEqual(result.items.map((item) => item.word), ['repository', 'acquit', 'jolt', 'stale', 'premise']);
    assert.equal(result.items[0].ipa, 'rɪˈpɑːzətɔːri');
    assert.equal(result.items[2].pos, '');
    assert.deepEqual(result.warnings, []);
  });

  test('heads longer than six words are not entries', () => {
    const result = parseList('- quick (adj): nhanh\n\n- this is a long sentence with many words: really');
    assert.deepEqual(result.items.map((item) => item.word), ['quick']);
    assert.deepEqual(result.warnings.map((w) => w.line), [3]);
  });

  test('a wrapped "- ..." line inside a numbered list stays in the sense', () => {
    const result = parseList('1. unadorned (adj): tính không hoa lá\n- chỉ giản đơn: mộc mạc');
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0].senses, ['tính không hoa lá - chỉ giản đơn: mộc mạc']);
  });
});

describe('titles', () => {
  for (const line of ['378.', '378', '#378', '# 378', 'No. 378', 'No.378:']) {
    test(`"${line}" → "378"`, () => {
      assert.equal(parseList(`${line}\n1. stale (adj): cũ`).title, '378');
    });
  }

  test('a short first line is the title', () => {
    const result = parseList('Unit 5 – Crime:\n\n1. acquit (v): tha bổng');
    assert.equal(result.title, 'Unit 5 – Crime');
    assert.deepEqual(result.warnings, []);
  });

  test('a long first line is not a title', () => {
    const long = 'These are the words I collected while reading the news this whole week';
    const result = parseList(`${long}\n1. acquit (v): tha bổng`);
    assert.equal(result.title, '');
    assert.deepEqual(result.warnings.map((w) => w.line), [1]);
  });
});

describe('block-full.txt', () => {
  const result = parseList(fixture('block-full.txt'));

  test('format and items', () => {
    assert.equal(result.kind, 'vocab');
    assert.equal(result.format, 'block');
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.warnings, []);
  });

  test('first entry word has no number prefix', () => {
    const item = result.items[0];
    assert.equal(item.word, 'level-headed');
    assert.equal(item.n, 1);
    assert.equal(item.ipa, 'ˈlevəl ˌhedɪd');
    assert.deepEqual(item.senses, ['Calm and rational when facing difficulties or stressful situations']);
    assert.deepEqual(item.examples, [
      'Even when the project deadline was moved up by two weeks, Sarah remained level-headed and organized the team efficiently.',
    ]);
    assert.equal(item.family, 'level-headedness (noun), level-headedly (adverb)');
    assert.deepEqual(item.synonyms, ['calm', 'composed', 'rational', 'sensible', 'steady']);
  });

  test('second entry keeps its capitalised word', () => {
    const item = result.items[1];
    assert.equal(item.word, 'Decipher');
    assert.equal(item.ipa, 'dɪˈsaɪfər');
    assert.deepEqual(item.senses, ['To convert secret codes or encrypted messages back into readable text']);
    assert.deepEqual(item.examples, ['Cryptographers work to decipher enemy communications during wartime']);
  });

  test('label aliases and case-insensitive labels', () => {
    const text = [
      '1. steady (adj) /ˈstedi/',
      'MEANING: firm and not shaking',
      'examples: Hold the ladder steady.',
      'Synonym: stable',
      '2. calm',
      'definition: not excited',
      'Example: Stay calm.',
      'Example: Keep calm.',
    ].join('\n');
    assert.equal(detectFormat(text), 'block');
    const result = parseList(text);
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].pos, 'adj');
    assert.deepEqual(result.items[0].senses, ['firm and not shaking']);
    assert.deepEqual(result.items[0].examples, ['Hold the ladder steady.']);
    assert.deepEqual(result.items[0].synonyms, ['stable']);
    assert.deepEqual(result.items[1].examples, ['Stay calm.', 'Keep calm.']);
  });

  test('a definition wrapped onto the next line', () => {
    const result = parseList('1. calm\nDefinition: not excited\nor nervous\nExample: Stay calm.');
    assert.deepEqual(result.items[0].senses, ['not excited or nervous']);
  });

  test('unnumbered block headers', () => {
    const result = parseList('Decipher /dɪˈsaɪfər/\nDefinition: to read a code\n\nCalm\nMeaning: not excited');
    assert.deepEqual(result.items.map((item) => item.word), ['Decipher', 'Calm']);
  });

  test('an entry without any definition is skipped with a warning', () => {
    const result = parseList('1. calm\nDefinition: not excited\n2. lonely\nExample: He felt lonely.');
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.warnings.map((w) => w.line), [3]);
  });
});

describe('family.txt', () => {
  const result = parseList(fixture('family.txt'));

  test('two families', () => {
    assert.equal(result.kind, 'family');
    assert.equal(result.format, 'family');
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.warnings, []);
    assert.equal(typeof result.items[0].id, 'string');
    assert.notEqual(result.items[0].id, result.items[1].id);
  });

  test('first family: four members with ipa, definition and example', () => {
    const { members } = result.items[0];
    assert.deepEqual(members.map((m) => m.word), ['poorness', 'impoverish', 'poor', 'poorly']);
    assert.deepEqual(members.map((m) => m.pos), ['n', 'v', 'adj', 'adv']);
    assert.deepEqual(members[0], {
      word: 'poorness',
      pos: 'n',
      ipa: 'ˈpʊrnəs',
      definition: 'the state or condition of being poor',
      example: "The family's poorness became evident when they couldn't afford basic necessities.",
    });
    assert.equal(members[3].example, 'The students performed poorly on the test due to inadequate preparation.');
  });

  test('second family: five members, IPA optional', () => {
    const { members } = result.items[1];
    assert.equal(members.length, 5);
    assert.equal(members[0].ipa, '');
    assert.equal(members[0].definition, 'the act of creating');
    assert.equal(members[0].example, '');
    assert.equal(members[3].word, 'create');
    assert.equal(members[3].ipa, 'kriˈeɪt');
  });

  test('unknown pos text is kept as written', () => {
    const result = parseList('1. swimming (gerund): bơi\n2. swim (verb): bơi', { kind: 'family' });
    assert.deepEqual(result.items[0].members.map((m) => m.pos), ['gerund', 'v']);
  });

  test('kind "family" on a single block yields one family', () => {
    const result = parseList('1. strength (noun) /streŋkθ/: the quality of being strong\n2. strong (adjective): having power', { kind: 'family' });
    assert.equal(detectFormat('1. strength (noun): x\n2. strong (adjective): y'), 'oneline');
    assert.equal(result.kind, 'family');
    assert.equal(result.format, 'family');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].members.length, 2);
    assert.equal(result.items[0].members[0].ipa, 'streŋkθ');
  });

  test('members without a definition are skipped with a warning', () => {
    const result = parseList('1. a (n): x\n2. b (v)\n3. c (adj): z', { kind: 'family' });
    assert.deepEqual(result.items[0].members.map((m) => m.word), ['a', 'c']);
    assert.deepEqual(result.warnings.map((w) => w.line), [2]);
  });
});

describe('passages', () => {
  test('passage.txt: one item per paragraph, line breaks kept', () => {
    const result = parseList(fixture('passage.txt'));
    assert.equal(result.kind, 'passage');
    assert.equal(result.format, 'passage');
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].text, 'The best way to learn a language is to use it every day, even when you make mistakes.');
    assert.equal(
      result.items[1].text,
      'Reading the news in English helps you notice how words are used in context,\nand listening to podcasts trains your ear to the rhythm of natural speech.',
    );
    assert.deepEqual(result.warnings, []);
  });

  test('paragraph text is trimmed and CRLF handled', () => {
    const result = parseList('  First line.  \r\nSecond line.\r\n\r\n\r\n  Another one.  ');
    assert.deepEqual(result.items.map((p) => p.text), ['First line.\nSecond line.', 'Another one.']);
  });

  test('kind "passage" forces passages', () => {
    const result = parseList(fixture('list-378-messy.txt'), { kind: 'passage' });
    assert.equal(result.kind, 'passage');
    assert.equal(result.format, 'passage');
    assert.equal(result.items.length, 2);
    assert.ok(result.items[0].text.startsWith('1. repository'));
  });

  test('a heading line becomes the passage title', () => {
    const result = parseList('# My speech\n\nHello everyone.');
    assert.equal(result.title, 'My speech');
    assert.deepEqual(result.items.map((p) => p.text), ['Hello everyone.']);
  });
});

describe('detectFormat', () => {
  test('fixtures', () => {
    assert.equal(detectFormat(fixture('list-378.txt')), 'oneline');
    assert.equal(detectFormat(fixture('list-378-messy.txt')), 'oneline');
    assert.equal(detectFormat(fixture('list-crlf.txt')), 'oneline');
    assert.equal(detectFormat(fixture('oneline-new-terms.txt')), 'oneline');
    assert.equal(detectFormat(fixture('block-full.txt')), 'block');
    assert.equal(detectFormat(fixture('family.txt')), 'family');
    assert.equal(detectFormat(fixture('passage.txt')), 'passage');
  });

  test('block wins as soon as one line starts with Definition:/Meaning:', () => {
    assert.equal(detectFormat('1. a (n): b\nMeaning: c'), 'block');
    assert.equal(detectFormat('1. a (n): b\n  definition : c'), 'block');
  });

  test('family needs every numbered block to start at 1 with >= 2 entries', () => {
    assert.equal(detectFormat('1. a (n): x\n2. b (v): y\n\n1. c (n): z\n2. d (v): w'), 'family');
    assert.equal(detectFormat('1. a (n): x\n2. b (v): y\n\n3. c (n): z\n4. d (v): w'), 'oneline');
    assert.equal(detectFormat('1. a (n): x\n2. b (v): y\n\n1. c (n): z'), 'oneline');
    assert.equal(detectFormat('Title\n\n1. a (n): x\n2. b (v): y'), 'oneline');
  });

  test('text without entries is a passage', () => {
    assert.equal(detectFormat('Remember: practice makes perfect.'), 'passage');
    assert.equal(detectFormat('1. Wake up early\n2. Read the news'), 'passage');
  });
});

describe('warnings', () => {
  test('numbered lines without a separator are skipped with a warning', () => {
    const result = parseList('378.\n1. acquit (v): tha bổng\n2. understudy (v) đóng thế\n3. jolt (v): xóc');
    assert.deepEqual(result.items.map((item) => item.word), ['acquit', 'jolt']);
    assert.deepEqual(result.items.map((item) => item.n), [1, 2]);
    assert.equal(result.warnings.length, 1);
    const [warning] = result.warnings;
    assert.equal(warning.line, 3);
    assert.equal(warning.text, '2. understudy (v) đóng thế');
    assert.equal(typeof warning.reason, 'string');
    assert.ok(warning.reason.length > 0);
  });

  test('continuation lines of a skipped entry are dropped', () => {
    const result = parseList('1. acquit (v): tha bổng\n2. understudy (v)\nđóng thế cho ai\n3. jolt (v): xóc');
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items[0].senses, ['tha bổng']);
    assert.deepEqual(result.warnings.map((w) => w.line), [2]);
  });

  test('an entry with ":" but no meaning is skipped with a warning', () => {
    const result = parseList('1. acquit (v):\n2. jolt (v): xóc');
    assert.deepEqual(result.items.map((item) => item.word), ['jolt']);
    assert.deepEqual(result.warnings.map((w) => w.line), [1]);
  });

  test('stray text after a blank line is reported', () => {
    const result = parseList('1. acquit (v): tha bổng\n\nnguồn: sách');
    assert.deepEqual(result.items[0].senses, ['tha bổng']);
    assert.deepEqual(result.warnings.map((w) => w.line), [3]);
  });
});

test('empty input', () => {
  for (const text of ['', '   \n\n  ', undefined]) {
    assert.deepEqual(parseList(text), { kind: 'vocab', format: 'oneline', title: '', items: [], warnings: [] });
  }
});
