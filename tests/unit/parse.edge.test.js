// Adversarial tests for js/core/parse.js: realistic iPhone pastes, Unicode
// oddities, spec edge cases and performance. The happy paths live in
// parse.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectFormat, parseList } from '../../js/core/parse.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const first = (text, options) => parseList(text, options).items[0];
const words = (text, options) => parseList(text, options).items.map((item) => item.word);
const withoutIds = (result) => ({
  ...result,
  items: result.items.map(({ id, ...rest }) => rest),
});

// Times one parse in milliseconds (the best of three, to smooth out GC pauses).
function timeParse(text) {
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const start = performance.now();
    parseList(text);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe('Unicode spacing and invisible characters', () => {
  test('NBSP, narrow NBSP, ideographic space and tabs act as plain spaces', () => {
    const item = first('1.\u00A0acquit\u00A0(v)\u202F:\u3000i)\ttha bổng.\u00A0ii) thể hiện');
    assert.equal(item.word, 'acquit');
    assert.equal(item.pos, 'v');
    assert.deepEqual(item.senses, ['tha bổng', 'thể hiện']);
  });

  test('NFD-decomposed Vietnamese is normalised to NFC everywhere', () => {
    const text = 'Từ vựng tuần 3:\n1. acquit (v): tuyên vô tội tại tòa'.normalize('NFD');
    const result = parseList(text);
    assert.equal(result.title, 'Từ vựng tuần 3'.normalize('NFC'));
    assert.equal(result.items[0].senses[0], 'tuyên vô tội tại tòa'.normalize('NFC'));
  });

  test('zero-width, bidi marks, soft hyphens and a stray BOM never reach the word', () => {
    const text = [
      '\uFEFF378.',
      '1. \u200Eacq\u200Buit (v): tha bổng',
      '2. repos\u00ADitory (n): kho',
      '3. jo\uFEFFlt (v): xóc\u200C',
      '4. sta\u2060le (adj): cũ\u200F',
    ].join('\n');
    const result = parseList(text);
    assert.equal(result.title, '378');
    assert.deepEqual(result.items.map((item) => item.word), ['acquit', 'repository', 'jolt', 'stale']);
    assert.deepEqual(result.items.map((item) => item.senses[0]), ['tha bổng', 'kho', 'xóc', 'cũ']);
  });

  test('U+2028 / U+2029 line separators split lines like "\\n"', () => {
    // Without this, "1. acquit" became the word and the next entry joined the meaning.
    const result = parseList('378.\u20291. acquit (v): tha bổng\u20282. jolt (v): xóc');
    assert.equal(result.title, '378');
    assert.deepEqual(result.items.map((item) => item.word), ['acquit', 'jolt']);
    assert.deepEqual(result.items[0].senses, ['tha bổng']);
  });

  test('lone CR (old Mac line endings) splits lines and keeps warning line numbers', () => {
    const result = parseList('378.\r1. acquit (v): tha bổng\r2. jolt (v) xóc');
    assert.equal(result.title, '378');
    assert.deepEqual(result.items.map((item) => item.word), ['acquit']);
    assert.deepEqual(result.warnings.map((w) => w.line), [3]);
  });

  test('BOM + CRLF: warning lines count lines of the original text', () => {
    const result = parseList('\uFEFF378.\r\n\r\n1. acquit (v): tha bổng\r\n2. jolt (v) xóc');
    assert.deepEqual(result.warnings.map((w) => [w.line, w.text]), [[4, '2. jolt (v) xóc']]);
  });

  test('whitespace-only lines made of NBSP / ideographic spaces count as empty', () => {
    assert.deepEqual(parseList('\u00A0\n \u3000\n\t'), {
      kind: 'vocab', format: 'oneline', title: '', items: [], warnings: [],
    });
  });

  test('fullwidth colon "：" is a separator', () => {
    const item = first('1. acquit (v)：tha bổng');
    assert.equal(item.word, 'acquit');
    assert.deepEqual(item.senses, ['tha bổng']);
  });

  test('smart punctuation from the iOS keyboard stays inside the sense', () => {
    const item = first('1. jolt (v): làm chuyển động — mạnh bạo… ii) khiến ai “sốc”');
    assert.deepEqual(item.senses, ['làm chuyển động — mạnh bạo…', 'khiến ai “sốc”']);
  });

  test('quotes wrapped around the word (straight or iOS curly) are removed', () => {
    const text = '1. “come up with” (phr v): nghĩ ra\n2. "jolt" (v): xóc\n3. ‘stale’ (adj): cũ';
    assert.deepEqual(words(text), ['come up with', 'jolt', 'stale']);
    assert.equal(first("1. one's cup of tea (idiom): sở thích").word, "one's cup of tea");
  });
});

describe('heads: IPA, part of speech, numbering', () => {
  test('IPA written right after the word without a space (contains ":")', () => {
    const item = first('1. repository/rɪˈpɑ:zətɔ:ri/(n): kho');
    assert.equal(item.word, 'repository');
    assert.equal(item.ipa, 'rɪˈpɑ:zətɔ:ri');
    assert.equal(item.pos, 'n');
    assert.deepEqual(item.senses, ['kho']);
  });

  test('IPA right after the pos without a space', () => {
    const item = first('1. premise (n)/ˈpremɪs/: tiền đề');
    assert.equal(item.word, 'premise');
    assert.equal(item.ipa, 'ˈpremɪs');
  });

  test('spaces just inside the slashes "/ ˈpremɪs /"', () => {
    const item = first('1. premise (n) / ˈpremɪs /: tiền đề');
    assert.equal(item.word, 'premise');
    assert.equal(item.ipa, 'ˈpremɪs');
  });

  test('slashes that are not IPA stay in the word or the meaning', () => {
    assert.equal(first('1. colour / color (n): màu').word, 'colour / color');
    assert.equal(first('1. remind sb/sth of sth (v): nhắc').word, 'remind sb/sth of sth');
    assert.deepEqual(first('1. either (det): cái này và/hoặc cái kia').senses, ['cái này và/hoặc cái kia']);
    assert.equal(first('1. colour/color /ˈkʌlər/ (n): màu').word, 'colour/color');
  });

  test('a slash in the word and a phonetic letter later never hide the separator', () => {
    // "/or (conj): đọc ən/" holds a phonetic letter but also the ": " separator.
    const item = first('1. and/or (conj): đọc ən/ɔːr');
    assert.equal(item.word, 'and/or');
    assert.equal(item.pos, 'conj');
    assert.deepEqual(item.senses, ['đọc ən/ɔːr']);
  });

  test('Oxford-style optional sound "(r)" inside IPA', () => {
    const item = first('1. colour (n) /ˈkʌlə(r)/: màu');
    assert.equal(item.word, 'colour');
    assert.equal(item.ipa, 'ˈkʌlə(r)');
    assert.equal(item.pos, 'n');
  });

  test('UK / US labels copied from a dictionary do not end up in the word', () => {
    const item = first('1. repository (n) UK /rɪˈpɒz.ɪ.tər.i/ US /rɪˈpɑː.zə.tɔːr.i/: kho');
    assert.equal(item.word, 'repository');
    assert.equal(item.ipa, 'rɪˈpɒz.ɪ.tər.i');
    assert.equal(first('1. the US (n): nước Mỹ').word, 'the US');
  });

  test('two pos groups "(n) (v)" / "(n)(v)" are combined, not left in the word', () => {
    for (const text of ['1. access (n) (v): truy cập', '1. access (n)(v): truy cập', '1. access (n, v): truy cập']) {
      const item = first(text);
      assert.equal(item.word, 'access', text);
      assert.equal(item.pos, 'n/v', text);
    }
    // A non-pos group between them still keeps the earlier text in the word.
    assert.equal(first('1. accuse (sb) of (sth) (v): buộc tội').word, 'accuse (sb) of (sth)');
  });

  test('pos written before the word', () => {
    const item = first('1. (v) acquit: tha bổng');
    assert.equal(item.word, 'acquit');
    assert.equal(item.pos, 'v');
  });

  test('"1/" numbering (common in Vietnam) does not leak into the word', () => {
    const result = parseList('378.\n1/ acquit (v): tha bổng\n2/ jolt (v): xóc');
    assert.equal(result.title, '378');
    assert.deepEqual(result.items.map((item) => item.word), ['acquit', 'jolt']);
    assert.equal(first('1. x (n): 24/7 trực').senses[0], '24/7 trực');
  });

  test('a bullet in front of the number does not leave the number in the word', () => {
    const result = parseList('• 1. acquit (v): tha bổng\n• 2. jolt (v): xóc\n- 3) stale (adj): cũ');
    assert.deepEqual(result.items.map((item) => item.word), ['acquit', 'jolt', 'stale']);
    assert.deepEqual(result.warnings, []);
  });

  test('numbering quirks: no space after the dot, space before it, 4 digits, ")"', () => {
    const text = '1.acquit (v): a\n2 . jolt (v): b\n1000. stale (adj): c\n1001) fumble (v): d';
    assert.deepEqual(words(text), ['acquit', 'jolt', 'stale', 'fumble']);
    assert.deepEqual(parseList(text).items.map((item) => item.n), [1, 2, 3, 4]);
  });

  test('n stays contiguous when entries in the middle are rejected', () => {
    const result = parseList('1. a (n): x\n2. b (n)\n3. c (n):\n4. d (n): y\n5. e (n): z');
    assert.deepEqual(result.items.map((item) => [item.n, item.word]), [[1, 'a'], [2, 'd'], [3, 'e']]);
    assert.deepEqual(result.warnings.map((w) => w.line), [2, 3]);
  });

  test('uppercase pos with a dot and Vietnamese pos names', () => {
    assert.equal(first('1. Acquit (V.): tha bổng').pos, 'v');
    assert.equal(first('1. Acquit (V.): tha bổng').word, 'Acquit');
    assert.equal(first('1. acquit (động từ): tha bổng').pos, 'v');
  });
});

describe('sense splitting', () => {
  test('uppercase roman markers', () => {
    assert.deepEqual(first('1. x (n): I) một. II) hai').senses, ['một', 'hai']);
  });

  test('marker right after the separator without a space', () => {
    assert.deepEqual(first('1. x (n):i) một ii) hai').senses, ['một', 'hai']);
  });

  test('nested brackets inside a sense are never split', () => {
    assert.deepEqual(first('1. x (n): i) một (cái (này)) ii) hai').senses, ['một (cái (này))', 'hai']);
    assert.deepEqual(first('1. x (n): i) một [ghi chú ii) abc] ii) hai').senses, ['một [ghi chú ii) abc]', 'hai']);
  });

  test('Vietnamese "vi" inside parentheses is not a marker', () => {
    assert.deepEqual(first('1. scope (n): i) phạm vi (của phạm vi) ii) tầm nhìn').senses, [
      'phạm vi (của phạm vi)',
      'tầm nhìn',
    ]);
  });

  test('"1)" "2)" sense lines may contain ":" themselves', () => {
    const result = parseList('1. repository (n):\n1) nơi lưu trữ: kho\n2) người nắm thông tin\n2. acquit (v): tha bổng');
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.items.map((item) => item.word), ['repository', 'acquit']);
    assert.deepEqual(result.items[0].senses, ['nơi lưu trữ: kho', 'người nắm thông tin']);
  });

  test('a "2)" entry with its own pos is still a new entry (messy numbering)', () => {
    const result = parseList('1) repository (n): 1) nơi lưu trữ\n2) acquit (v): tha bổng');
    assert.deepEqual(result.items.map((item) => item.word), ['repository', 'acquit']);
  });

  test('synonym tags anywhere in a multi-sense meaning', () => {
    const item = first('1. x (adj): i) đơn giản [=plain, simple]. ii) trơn [= bare]');
    assert.deepEqual(item.senses, ['đơn giản', 'trơn']);
    assert.deepEqual(item.synonyms, ['plain', 'simple', 'bare']);
  });

  test('duplicate synonyms are removed case-insensitively', () => {
    const item = first('1. x (adj): đơn giản [=plain, Plain; simple]');
    assert.deepEqual(item.synonyms, ['plain', 'simple']);
  });
});

describe('titles', () => {
  test('a 60-character first line is a title, 61 characters is not', () => {
    const sixty = 'x'.repeat(60);
    assert.equal(parseList(`${sixty}\n1. acquit (v): tha bổng`).title, sixty);
    const result = parseList(`${'x'.repeat(61)}\n1. acquit (v): tha bổng`);
    assert.equal(result.title, '');
    assert.deepEqual(result.warnings.map((w) => w.line), [1]);
  });

  test('leading blank lines before the title', () => {
    assert.equal(parseList('\n\n  378.  \n1. acquit (v): tha bổng').title, '378');
  });

  test('a title with an emoji and one with a colon inside', () => {
    assert.equal(parseList('📚 378\n1. acquit (v): tha bổng').title, '📚 378');
    assert.equal(parseList('Unit 5: Crime\n1. acquit (v): tha bổng').title, 'Unit 5: Crime');
  });

  test('a heading after the entries is not the title', () => {
    const result = parseList('1. acquit (v): tha bổng\n378.');
    assert.equal(result.title, '');
    assert.equal(result.items.length, 1);
  });
});

describe('Markdown-ish pastes (AI replies, notes apps)', () => {
  test('"---" rules between block entries do not leak into a field', () => {
    const text = '1. calm (adj) /kɑːm/\nDefinition: not excited\nSynonyms: quiet, still\n---\n2. steady (adj)\nDefinition: firm';
    const result = parseList(text);
    assert.deepEqual(result.items[0].synonyms, ['quiet', 'still']);
    assert.deepEqual(result.items.map((item) => item.word), ['calm', 'steady']);
    assert.deepEqual(result.warnings, []);
  });

  test('"---" / "***" rules surrounded by blank lines give no warning', () => {
    const result = parseList('1. acquit (v): tha bổng\n\n---\n\n2. jolt (v): xóc\n\n* * *\n\n3. stale (adj): cũ');
    assert.deepEqual(result.items.map((item) => item.word), ['acquit', 'jolt', 'stale']);
    assert.deepEqual(result.warnings, []);
  });

  test('markdown heading on unnumbered block headers', () => {
    const text = '### Level-headed\nDefinition: calm\n\n## **Decipher** /dɪˈsaɪfər/\nDefinition: read a code';
    assert.deepEqual(words(text), ['Level-headed', 'Decipher']);
    assert.equal(parseList(text).items[1].ipa, 'dɪˈsaɪfər');
  });

  test('bold labels, italic labels and bulleted labels', () => {
    const item = first('1. **calm** (adj) /kɑːm/\n**Definition:** not excited\n*Example:* Stay calm.\n- **Synonyms:** quiet, still');
    assert.equal(item.word, 'calm');
    assert.deepEqual(item.senses, ['not excited']);
    assert.deepEqual(item.examples, ['Stay calm.']);
    assert.deepEqual(item.synonyms, ['quiet', 'still']);
  });

  test('"## 1. word" headings in block format', () => {
    const result = parseList('## 1. level-headed /ˈlevəl ˌhedɪd/\nDefinition: calm\n## 2. steady\nMeaning: firm');
    assert.deepEqual(result.items.map((item) => item.word), ['level-headed', 'steady']);
  });

  test('a Claude sentence reply pasted by mistake gives no vocab items', () => {
    const reply = fixture('reply-378.md');
    assert.equal(detectFormat(reply), 'passage');
    const forced = parseList(reply, { kind: 'vocab' });
    assert.deepEqual(forced.items, []);
    assert.ok(forced.warnings.length > 0);
  });
});

describe('word families', () => {
  test('a "---" line between families still separates them and stays out of definitions', () => {
    const result = parseList('1. strong (adj): mạnh\n2. strength (n): sức mạnh\n---\n1. poor (adj): nghèo\n2. poverty (n): sự nghèo', { kind: 'family' });
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].members[1].definition, 'sức mạnh');
  });

  test('title line before the families', () => {
    const result = parseList('Word families\n\n1. strong (adj): mạnh\n2. strength (n): sức mạnh\n\n1. poor (adj): nghèo\n2. poverty (n): sự nghèo');
    assert.equal(result.kind, 'family');
    assert.equal(result.title, 'Word families');
    assert.deepEqual(result.warnings, []);
  });

  test('"Ví dụ:" examples, IPA after the colon and a missing pos', () => {
    const result = parseList([
      '1. strength: /streŋkθ/ sức mạnh',
      'Ví dụ: She has great strength.',
      '2. strong (adj): mạnh',
      '',
      '1. poor (adj): nghèo',
      '2. poverty (n): sự nghèo',
    ].join('\n'));
    const [member] = result.items[0].members;
    assert.deepEqual(member, {
      word: 'strength', pos: '', ipa: 'streŋkθ', definition: 'sức mạnh', example: 'She has great strength.',
    });
  });

  test('numbering that restarts at 1 without a blank line starts a new family', () => {
    const result = parseList('1. a (n): x\n2. b (v): y\n1. c (n): z\n2. d (v): w', { kind: 'family' });
    assert.deepEqual(result.items.map((f) => f.members.map((m) => m.word)), [['a', 'b'], ['c', 'd']]);
  });

  test('blank-separated single entries are a vocab list, not families', () => {
    assert.equal(detectFormat('1. a (n): x\n\n2. b (v): y\n\n3. c (n): z'), 'oneline');
  });
});

describe('passages', () => {
  test('"---" rules between paragraphs are not passages', () => {
    const result = parseList('First paragraph.\n\n---\n\nSecond paragraph.');
    assert.deepEqual(result.items.map((p) => p.text), ['First paragraph.', 'Second paragraph.']);
  });

  test('U+2028 inside a passage is kept as a line break', () => {
    const result = parseList('Line one.\u2028Line two.');
    assert.deepEqual(result.items.map((p) => p.text), ['Line one.\nLine two.']);
  });

  test('a dialogue "A: ..." is a passage, not a vocab list', () => {
    assert.equal(detectFormat('A: How are you?\nB: Fine, thanks.'), 'passage');
  });
});

describe('API robustness', () => {
  test('result has exactly the documented keys', () => {
    for (const text of [fixture('list-378.txt'), fixture('family.txt'), fixture('passage.txt'), '']) {
      assert.deepEqual(Object.keys(parseList(text)).sort(), ['format', 'items', 'kind', 'title', 'warnings']);
    }
  });

  test('VocabItem has exactly the documented fields with the right types', () => {
    for (const item of parseList(fixture('block-full.txt')).items) {
      assert.deepEqual(Object.keys(item).sort(), ['context', 'examples', 'family', 'id', 'ipa', 'n', 'pos', 'senses', 'synonyms', 'word']);
      for (const key of ['id', 'word', 'ipa', 'pos', 'family', 'context']) assert.equal(typeof item[key], 'string', key);
      for (const key of ['senses', 'synonyms', 'examples']) assert.ok(Array.isArray(item[key]), key);
    }
  });

  test('options: null, {}, unknown kind and "vocab" on a family layout', () => {
    const text = '1. a (n): x\n2. b (v): y\n\n1. c (n): z\n2. d (v): w';
    assert.equal(parseList('1. a (n): x', null).kind, 'vocab');
    assert.equal(parseList('1. a (n): x', { kind: 'bogus' }).kind, 'vocab');
    const vocab = parseList(text, { kind: 'vocab' });
    assert.equal(vocab.kind, 'vocab');
    assert.equal(vocab.format, 'oneline');
    assert.equal(vocab.items.length, 4);
  });

  test('does not mutate the options object', () => {
    const options = Object.freeze({ kind: 'family' });
    assert.doesNotThrow(() => parseList(fixture('family.txt'), options));
  });

  test('non-string input does not throw', () => {
    for (const value of [null, undefined, 378, {}, []]) assert.doesNotThrow(() => parseList(value));
    assert.equal(parseList(null).kind, 'vocab');
  });

  test('parsing is deterministic apart from ids, and ids are unique', () => {
    const text = fixture('list-378.txt');
    const a = parseList(text);
    const b = parseList(text);
    assert.deepEqual(withoutIds(a), withoutIds(b));
    const ids = new Set([...a.items, ...b.items].map((item) => item.id));
    assert.equal(ids.size, a.items.length + b.items.length);
  });

  test('detectFormat agrees with the format parseList uses', () => {
    for (const name of ['list-378.txt', 'list-378-messy.txt', 'list-crlf.txt', 'oneline-new-terms.txt', 'block-full.txt', 'family.txt', 'passage.txt']) {
      const text = fixture(name);
      assert.equal(parseList(text).format, detectFormat(text), name);
    }
  });
});

describe('fuzz: random pastes keep the output well-formed', () => {
  // Small deterministic PRNG (mulberry32) so failures are reproducible.
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
    '1.', '2)', '3/', '378.', '#378', '•', '-', '*', '–', '---', '\n', '\n\n', '\r\n', '\u2028', ' ', '\u00A0', '\t',
    'acquit', 'come up with', 'level-headed', '“quoted”', '(n)', '(v)', '(phr v)', '(sb)', '(n, v)',
    '/rɪˈpɑːzətɔːri/', '/rɪˈpɑ:zətɔ:ri/', '/ ˈpremɪs /', 'colour / color', ':', '：', ' : ', ' - ', ' = ',
    'i)', 'ii)', '(iii)', '1)', '2)', 'v)', 'nơi lưu trữ', 'tha bổng.', 'Hawaii)', '(gồm', ')', '[=plain]', '[',
    'Definition:', 'Meaning:', 'Example:', 'Synonyms:', 'Word family:', 'Ví dụ:', '**', '##', '\u200B', '\u00AD',
  ];
  const ENTRY_PREFIX = /^(?:#+\s*|[*_]+)?\d{1,4}\s*[.)/]\s/;

  test('2,000 random pastes: no throw, valid items and warnings', () => {
    const random = rng(378);
    for (let round = 0; round < 2000; round++) {
      const length = 1 + Math.floor(random() * 40);
      const text = Array.from({ length }, () => pieces[Math.floor(random() * pieces.length)]).join(random() < 0.5 ? ' ' : '');
      const lineCount = text.split(/\r\n?|\n|\u2028/).length;
      for (const kind of [undefined, 'vocab', 'family', 'passage']) {
        const result = parseList(text, { kind });
        const context = `${JSON.stringify(text)} kind=${kind}`;
        assert.ok(['vocab', 'family', 'passage'].includes(result.kind), context);
        assert.equal(typeof result.title, 'string', context);
        for (const w of result.warnings) {
          assert.ok(Number.isInteger(w.line) && w.line >= 1 && w.line <= lineCount, `warning line ${w.line}: ${context}`);
          assert.equal(typeof w.reason, 'string', context);
        }
        assert.deepEqual(result.warnings.map((w) => w.line), result.warnings.map((w) => w.line).sort((a, b) => a - b), context);
        if (result.kind === 'vocab') {
          result.items.forEach((item, k) => {
            assert.equal(item.n, k + 1, context);
            assert.ok(item.word.length > 0, `empty word: ${context}`);
            assert.ok(!ENTRY_PREFIX.test(item.word), `number left in word "${item.word}": ${context}`);
            assert.ok(item.senses.length >= 1, context);
            for (const sense of item.senses) assert.ok(sense.trim() === sense && sense.length > 0, `sense "${sense}": ${context}`);
            assert.ok(!/[\r\n\u2028\u200B\u00AD]/.test(JSON.stringify(item)), `control char in item: ${context}`);
          });
        }
        if (result.kind === 'family') {
          for (const family of result.items) {
            if (result.format === 'roots') {
              // A plain word list: families still empty until Claude builds them
              // (docs/architecture.md, "Word families from Claude").
              assert.ok(family.root.length > 0 && family.members.length === 0, context);
              continue;
            }
            assert.ok(family.members.length >= 1, context);
            for (const m of family.members) assert.ok(m.word.length > 0, context);
          }
        }
        if (result.kind === 'passage') {
          for (const p of result.items) assert.ok(p.text.length > 0 && p.text === p.text.trim(), context);
        }
      }
    }
  });
});

describe('performance (no catastrophic backtracking)', () => {
  const lines = fixture('list-378.txt').split('\n').filter((line) => /^\d+\.\s+\S/.test(line));

  test('a 2,000-line list parses quickly and completely', () => {
    const text = Array.from({ length: 2000 }, (_, k) => lines[k % lines.length].replace(/^\d+/, String(k + 1))).join('\n');
    const result = parseList(text);
    assert.equal(result.items.length, 2000);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.items[1999].n, 2000);
    assert.ok(timeParse(text) < 1500, 'parse took too long');
  });

  test('pathological single lines stay fast', () => {
    const cases = {
      spaces: `x${' '.repeat(50000)}y`,
      spacesAfterHead: `1. x (n)${' '.repeat(20000)}y`,
      openParens: `1. x (n): ${'('.repeat(20000)}`,
      markers: `1. x (n): ${'a) '.repeat(10000)}`,
      slashes: `1. x (n) ${' /a'.repeat(20000)}: y`,
      equals: `x ${'= '.repeat(20000)}`,
      dashes: `x (n)${' -'.repeat(20000)}`,
      longMeaning: `1. x (n): ${'nghĩa '.repeat(50000)}`,
    };
    for (const [name, text] of Object.entries(cases)) {
      assert.ok(timeParse(text) < 500, `${name} took too long`);
    }
  });
});

test('two pasted word lists with number headings stay vocabulary, not families', async () => {
  const { parseList, detectFormat } = await import('../../js/core/parse.js');
  const text = '378.\n1. stale (adj): cũ\n2. jolt (v): làm chuyển động mạnh\n\n379.\n1. premise (n): tiền đề\n2. acquit (v): tuyên vô tội\n';
  assert.equal(detectFormat(text), 'oneline');
  const r = parseList(text);
  assert.equal(r.kind, 'vocab');
  assert.equal(r.title, '378');
  assert.deepEqual(r.items.map((i) => i.word), ['stale', 'jolt', 'premise', 'acquit']);
});
