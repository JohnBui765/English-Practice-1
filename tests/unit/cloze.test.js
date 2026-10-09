import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildPrompt, clozeParts, coverage, formMatchesWord, parseReply, sentenceFromContext,
} from '../../js/core/cloze.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

const NOW = 1_760_000_000_000;
const NOT_READABLE = 'Could not read the reply — copy the whole JSON block from Claude.';

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

// tests/fixtures/list-378.txt, built by hand (parse.js is tested separately).
function list378(extra = {}) {
  return makeList([
    makeItem(1, 'repository', 'n', ['nơi lưu trữ đồ đạc số lượng lớn.', 'người nắm được nhiều kiến thức hay thông tin.'], { ipa: 'rɪˈpɑːzətɔːri' }),
    makeItem(2, 'interoperability', 'n', ['khả năng các hệ thống hay thiết bị khác nhau hoạt động cùng nhau.']),
    makeItem(3, 'aggregate', 'n', ['kết quả tổng từ các phần nhỏ hơn.', 'cát xây dựng được trộn với xi măng.']),
    makeItem(4, 'acquit', 'v', ['tuyên chính thức vô tội tại tòa.', 'tự mình thể hiện một màn trình diễn trong công việc như thế nào đó.']),
    makeItem(5, 'understudy', 'v', ['học phần lời thoại của diễn viên khác như một phương án dự phòng nếu có vấn đề gì xảy ra với diễn viên đó - chuẩn bị khâu công việc của người khác như một sự dự phòng cho toàn bộ dự án.']),
    makeItem(6, 'jolt', 'v', ['làm chuyển động mạnh bạo và bất ngờ.', 'khiến ai sốc và bắt đầu hành động.']),
    makeItem(7, 'fumble', 'v', ['sử dụng tay một cách vụng về loay hoay khi làm gì.', 'khó khăn trong việc tìm từ ngữ phù hợp.']),
    makeItem(8, 'stale', 'adj', ['tính cũ, không được tươi mới nữa.']),
    makeItem(9, 'unadorned', 'adj', ['tính không hoa lá màu mè - chỉ giản đơn mộc mạc'], { synonyms: ['plain'] }),
    makeItem(10, 'progressive', 'adj', ['có tính ủng hộ cái mới.', 'có tính xảy ra hay phát triển ổn định.', 'liên quan đến thì tiếp diễn.', 'có tính thuế bị tính cao hơn.']),
    makeItem(11, 'premise', 'n', ['tiền đề - cơ sở lập luận']),
  ], { title: '378', ...extra });
}

function existing(itemId, sense, text, origin = 'ai') {
  return { id: `${itemId}-${sense}-${text.length}`, itemId, sense, text, answer: clozeParts(text).answer, vi: '', origin, createdAt: 1 };
}

const fenced = (objects) => '```json\n' + JSON.stringify({ sentences: objects }) + '\n```';

const pairsOf = (missing) => missing.map((m) => `${m.itemId}:${m.sense}`);

// ---------------------------------------------------------------------------

describe('buildPrompt', () => {
  test('produces the full prompt for list 378', () => {
    const prompt = buildPrompt(list378());
    const lines = prompt.split('\n');
    assert.equal(lines[0], "I'm a Vietnamese learner of English at about B2 level. Please help me practise these words in context.");
    assert.equal(lines[1], '');
    assert.equal(lines[2], 'Write fill-in-the-blank sentences: 1 sentence for EACH numbered meaning of each word below (19 sentences in total).');
    assert.ok(prompt.includes([
      'Rules:',
      '1. Each sentence must clearly use the word in that specific meaning.',
      '2. Natural, modern English at B2 level, 12–25 words. Vary the situations (work, news, science, daily life, culture...).',
      '3. Put the target word in double square brackets exactly once, in the form the sentence needs, e.g. [[acquitted]], [[repositories]].',
      '4. The context should make the answer guessable: only this word from my list should fit the blank. Do not define or translate the word inside the sentence.',
      '5. "vi" is a natural Vietnamese translation of the whole sentence.',
      '6. Reply with ONLY one JSON code block in exactly this format, where "w" is the word number and "s" the meaning number:',
      '{"sentences":[{"w":1,"s":1,"text":"... [[word]] ...","vi":"..."}]}',
      '',
      'Words:',
      '1. repository (n)',
      '   1) nơi lưu trữ đồ đạc số lượng lớn',
      '   2) người nắm được nhiều kiến thức hay thông tin',
      '2. interoperability (n)',
      '   1) khả năng các hệ thống hay thiết bị khác nhau hoạt động cùng nhau',
    ].join('\n')));
    assert.ok(prompt.includes([
      '10. progressive (adj)',
      '   1) có tính ủng hộ cái mới',
      '   2) có tính xảy ra hay phát triển ổn định',
      '   3) liên quan đến thì tiếp diễn',
      '   4) có tính thuế bị tính cao hơn',
      '11. premise (n)',
      '   1) tiền đề - cơ sở lập luận',
    ].join('\n')));
    assert.ok(prompt.endsWith('   1) tiền đề - cơ sở lập luận'));
    assert.ok(!prompt.includes('collected'));
    assert.ok(!prompt.includes('already exist'));
    assert.ok(!prompt.includes('For a phrase'), 'no phrase hint without phrases');
  });

  test('uses the level and the list source', () => {
    const prompt = buildPrompt(list378({ source: 'The Economist podcast' }), { level: 'C1' });
    assert.ok(prompt.startsWith("I'm a Vietnamese learner of English at about C1 level. Please help me practise these words in context. I collected them from: The Economist podcast — where it fits, use similar topics.\n"));
    assert.ok(prompt.includes('2. Natural, modern English at C1 level, 12–25 words.'));
    assert.ok(!buildPrompt(list378({ source: '   ' })).includes('collected'));
  });

  test('two sentences per sense', () => {
    const prompt = buildPrompt(list378(), { sentencesPerSense: 2 });
    assert.ok(prompt.includes('Write fill-in-the-blank sentences: 2 sentences for EACH numbered meaning of each word below (38 sentences in total).'));
    assert.ok(prompt.includes('(one object per sentence, so each meaning gets 2 objects with the same "w" and "s"):'));
  });

  test('omits a missing pos, adds the context line and the phrase hint', () => {
    const list = makeList([
      makeItem(1, 'come up with', '', ['nghĩ ra, nảy ra (ý tưởng)'], { context: 'She  [[came up with]] a plan.' }),
      makeItem(2, 'slacker', 'n', ['những kẻ lười biếng']),
    ]);
    const prompt = buildPrompt(list);
    assert.ok(prompt.includes('Words:\n1. come up with\n   1) nghĩ ra, nảy ra (ý tưởng)\n   Seen in: “She came up with a plan.”\n2. slacker (n)\n   1) những kẻ lười biếng'));
    assert.ok(prompt.includes('For a phrase, bracket the whole phrase, including any words that come between its parts, e.g. [[took it for granted]].'));
    assert.ok(prompt.includes('(2 sentences in total)'));
  });

  test('`only` keeps the original word and meaning numbers', () => {
    const list = list378();
    const prompt = buildPrompt(list, { only: [{ itemId: 'i4', sense: 1 }, { itemId: 'i10', sense: 2 }] });
    assert.ok(prompt.includes('(2 sentences in total)'));
    assert.ok(prompt.includes('Words:\n4. acquit (v)\n   2) tự mình thể hiện một màn trình diễn trong công việc như thế nào đó\n10. progressive (adj)\n   3) liên quan đến thì tiếp diễn'));
    assert.ok(!prompt.includes('1. repository'));
    assert.ok(!prompt.includes('tuyên chính thức'));
    assert.ok(!prompt.includes('có tính ủng hộ'));

    // A reply that follows those numbers lands on the right item and sense.
    const { sentences, problems } = parseReply(fenced([
      { w: 4, s: 2, text: 'Nervous as she was, she [[acquitted]] herself well in the final interview.', vi: '' },
      { w: 10, s: 3, text: 'We use the present [[progressive]] for actions happening right now.', vi: '' },
    ]), list, { now: NOW });
    assert.deepEqual(problems, []);
    assert.deepEqual(sentences.map((s) => [s.itemId, s.sense]), [['i4', 1], ['i10', 2]]);
  });

  test('`only` without a sense asks for every meaning of that word; nothing left → ""', () => {
    const prompt = buildPrompt(list378(), { only: [{ itemId: 'i6' }] });
    assert.ok(prompt.includes('6. jolt (v)\n   1) làm chuyển động mạnh bạo và bất ngờ\n   2) khiến ai sốc và bắt đầu hành động'));
    assert.ok(prompt.includes('(2 sentences in total)'));
    assert.equal(buildPrompt(list378(), { only: [] }), '');
    assert.equal(buildPrompt(makeList([])), '');
  });

  test('`fresh` lists the existing AI sentences without brackets', () => {
    const list = list378({
      sentences: [
        existing('i4', 0, 'The jury [[acquitted]] him of all charges.'),
        existing('i8', 0, 'The bread had gone [[stale]].', 'user'),
        existing('i1', 1, 'She is a walking [[repository]] of facts.'),
      ],
    });
    const prompt = buildPrompt(list, { fresh: true });
    assert.ok(prompt.endsWith('\n\nThese sentences already exist — write NEW ones that are clearly different:\n- The jury acquitted him of all charges.\n- She is a walking repository of facts.'));
    assert.ok(!prompt.includes('The bread had gone'), 'user sentences are not listed');
    assert.ok(!buildPrompt(list).includes('already exist'));

    const onlyAcquit = buildPrompt(list, { fresh: true, only: [{ itemId: 'i4', sense: 0 }] });
    assert.ok(onlyAcquit.includes('- The jury acquitted him of all charges.'));
    assert.ok(!onlyAcquit.includes('walking repository'));

    assert.ok(!buildPrompt(list378(), { fresh: true }).includes('already exist'), 'no section when nothing exists');
  });

  test('`fresh` lists at most 40 sentences', () => {
    const sentences = Array.from({ length: 50 }, (_, i) => existing('i2', 0, `Sentence number ${i} needs [[interoperability]].`));
    const prompt = buildPrompt(list378({ sentences }), { fresh: true });
    const listed = prompt.split('\n').filter((line) => line.startsWith('- Sentence number'));
    assert.equal(listed.length, 40);
    assert.ok(!listed.some((line) => line.includes('[[')));
  });
});

// ---------------------------------------------------------------------------

describe('parseReply', () => {
  test('reads the realistic reply for list 378', () => {
    const list = list378();
    const { sentences, problems, missing } = parseReply(fixture('reply-378.md'), list, { now: NOW });
    assert.equal(sentences.length, 19);
    assert.deepEqual(problems, []);
    assert.deepEqual(missing, []);

    const acquit = sentences.find((s) => s.itemId === 'i4' && s.sense === 0);
    assert.deepEqual({ ...acquit, id: 'x' }, {
      id: 'x', itemId: 'i4', sense: 0,
      text: 'After a two-week trial, the jury [[acquitted]] him of all charges.',
      answer: 'acquitted',
      vi: 'Sau phiên tòa kéo dài hai tuần, bồi thẩm đoàn tuyên anh ta vô tội với mọi cáo buộc.',
      origin: 'ai', createdAt: NOW,
    });
    assert.equal(typeof acquit.id, 'string');
    assert.equal(new Set(sentences.map((s) => s.id)).size, 19);
    assert.equal(sentences.find((s) => s.itemId === 'i5').answer, 'understudied');
    assert.deepEqual(
      sentences.filter((s) => s.itemId === 'i10').map((s) => s.sense),
      [0, 1, 2, 3],
    );
  });

  test('repairs smart quotes used as delimiters and trailing commas', () => {
    const text = [
      '{“sentences”:[',
      '{“w”:4,“s”:1,“text”:“The jury [[acquitted]] him after a short trial.”,“vi”:“Bồi thẩm đoàn tuyên anh ấy “vô tội”.”},',
      '{“w”:8,“text”:“Nobody ate the [[stale]] biscuits left on the table.”,“vi”:“”,},',
      ']}',
    ].join('\n');
    const { sentences, problems } = parseReply(text, list378(), { now: NOW });
    assert.deepEqual(problems, []);
    assert.deepEqual(sentences.map((s) => s.answer), ['acquitted', 'stale']);
    assert.equal(sentences[0].vi, 'Bồi thẩm đoàn tuyên anh ấy “vô tội”.');
    assert.equal(sentences[1].vi, '');
  });

  test('reads JSON inside a fence surrounded by prose', () => {
    const json = '{"sentences":[{"w":6,"s":1,"text":"The train [[jolted]] forward and my coffee spilled.","vi":"Tàu giật mạnh."}]}';
    for (const text of [
      `Sure! Each word is wrapped like [[this]].\n\n\`\`\`json\n${json}\n\`\`\`\n\nWant more?`,
      `Here you go:\n\`\`\`\n${json}\n\`\`\``,
      `Here you go: ${json} — enjoy!`,
    ]) {
      const { sentences, problems } = parseReply(text, list378(), { now: NOW });
      assert.deepEqual(problems, [], text);
      assert.equal(sentences.length, 1);
      assert.equal(sentences[0].text, 'The train [[jolted]] forward and my coffee spilled.');
    }
  });

  test('accepts a bare array, JSON Lines and a BOM', () => {
    const a = { w: 7, s: 1, text: 'He [[fumbled]] for the light switch in the dark.', vi: 'x' };
    const b = { w: 7, s: 2, text: 'Asked about the budget, the spokesman [[fumbled]] for words.', vi: 'y' };
    const bom = String.fromCharCode(0xfeff);
    const inputs = [
      JSON.stringify([a, b]),
      `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`,
      '```jsonl\n' + JSON.stringify(a) + ',\n' + JSON.stringify(b) + '\n```',
      bom + JSON.stringify({ sentences: [a, b] }),
    ];
    for (const text of inputs) {
      const { sentences, problems } = parseReply(text, list378(), { now: NOW });
      assert.deepEqual(problems, [], text);
      assert.deepEqual(sentences.map((s) => [s.itemId, s.sense, s.vi]), [['i7', 0, 'x'], ['i7', 1, 'y']]);
    }
  });

  test('accepts key aliases, numeric strings and the word itself', () => {
    const text = JSON.stringify({ sentences: [
      { word: '4', sense: '2', sentence: 'On her first day as captain she [[acquitted]] herself with real confidence.', translation: 'Cô ấy thể hiện tốt.' },
      { word: 'jolt', sense: 'ii', sentence: 'The news [[jolted]] the government into action.' },
    ] });
    const { sentences, problems } = parseReply(text, list378(), { now: NOW });
    assert.deepEqual(problems, []);
    assert.deepEqual(sentences.map((s) => [s.itemId, s.sense, s.vi]), [['i4', 1, 'Cô ấy thể hiện tốt.'], ['i6', 1, '']]);
  });

  test('"s" defaults to 1 only when the word has one meaning', () => {
    const text = fenced([
      { w: 2, text: 'Better [[interoperability]] lets the two banking apps share data.' },
      { w: 4, text: 'The judge [[acquitted]] both defendants.' },
    ]);
    const { sentences, problems } = parseReply(text, list378(), { now: NOW });
    assert.deepEqual(sentences.map((s) => [s.itemId, s.sense]), [['i2', 0]]);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].ref, 'w4');
    assert.match(problems[0].reason, /meaning number/);
  });

  test('reports unknown word and meaning numbers', () => {
    const text = fenced([
      { w: 15, s: 1, text: 'This [[word]] is not in the list.' },
      { w: 4, s: 3, text: 'The court [[acquitted]] the nurse.' },
      { w: 0, s: 1, text: 'Zero is [[nothing]].' },
      { s: 1, text: 'No word number [[here]].' },
    ]);
    const { sentences, problems } = parseReply(text, list378(), { now: NOW });
    assert.deepEqual(sentences, []);
    assert.deepEqual(problems.map((p) => p.ref), ['w15 s1', 'w4 s3', 'w0 s1', 's1']);
    assert.match(problems[0].reason, /no word number 15/);
    assert.match(problems[1].reason, /no meaning number 3/);
    assert.equal(problems[1].text, 'The court [[acquitted]] the nurse.');
  });

  test('brackets the word itself when Claude forgot the [[ ]]', () => {
    const text = fenced([
      { w: 4, s: 1, text: 'The jury acquitted him because the evidence was weak.' },
      { w: 6, s: 2, text: 'The warning **jolted** her into action.' },
      { w: 1, s: 1, text: 'The archive is a [repository] for old maps.' },
    ]);
    const { sentences, problems } = parseReply(text, list378(), { now: NOW });
    assert.deepEqual(problems, []);
    assert.deepEqual(sentences.map((s) => s.text), [
      'The jury [[acquitted]] him because the evidence was weak.',
      'The warning [[jolted]] her into action.',
      'The archive is a [[repository]] for old maps.',
    ]);
    assert.deepEqual(sentences.map((s) => s.answer), ['acquitted', 'jolted', 'repository']);
  });

  test('auto-brackets phrases too', () => {
    const list = makeList([
      makeItem(1, 'take sth for granted', 'idiom', ['coi là đương nhiên']),
      makeItem(2, 'come up with', 'phr v', ['nghĩ ra']),
    ]);
    const text = fenced([
      { w: 1, text: 'We took clean water for granted until the pipes burst.' },
      { w: 2, text: 'Who came up with this brilliant idea?' },
    ]);
    const { sentences, problems } = parseReply(text, list, { now: NOW });
    assert.deepEqual(problems, []);
    assert.deepEqual(sentences.map((s) => s.text), [
      'We [[took clean water for granted]] until the pipes burst.',
      'Who [[came up with]] this brilliant idea?',
    ]);
  });

  test('rejects sentences without the word, with two [[ ]] or with the wrong word', () => {
    const text = fenced([
      { w: 4, s: 1, text: 'The jury found him not guilty.' },
      { w: 4, s: 2, text: 'She [[acquitted]] herself well and [[acquitted]] again.' },
      { w: 4, s: 1, text: 'The company [[acquired]] a smaller rival.' },
      { w: 10, s: 2, text: 'We made slow [[progress]] on the report.' },
      { w: 8, s: 1, text: 'The [[]] bread went to the ducks.' },
    ]);
    const { sentences, problems } = parseReply(text, list378(), { now: NOW });
    assert.deepEqual(sentences, []);
    assert.deepEqual(problems.map((p) => p.ref), ['w4 s1', 'w4 s2', 'w4 s1', 'w10 s2', 'w8 s1']);
    assert.match(problems[0].reason, /not marked with \[\[ \]\]/);
    assert.match(problems[1].reason, /more than one/);
    assert.equal(problems[2].reason, '[[acquired]] is not a form of "acquit".');
    assert.equal(problems[3].reason, '[[progress]] is not a form of "progressive".');
    assert.equal(problems[2].text, 'The company [[acquired]] a smaller rival.');
  });

  test('drops duplicates silently (case-insensitive), also against saved sentences', () => {
    const list = list378({ sentences: [existing('i8', 0, 'The bread had gone [[stale]].')] });
    const text = fenced([
      { w: 4, s: 1, text: 'The jury [[acquitted]] him.' },
      { w: 4, s: 1, text: 'the jury [[ACQUITTED]] him.' },
      { w: 8, s: 1, text: 'The bread had gone stale.' },
    ]);
    const { sentences, problems, missing, duplicates } = parseReply(text, list, { now: NOW });
    assert.deepEqual(problems, []);
    assert.deepEqual(sentences.map((s) => s.text), ['The jury [[acquitted]] him.']);
    assert.equal(duplicates, 2);
    assert.ok(!pairsOf(missing).includes('i8:0'), 'a repeated sentence still answers its meaning');
  });

  test('normalises spacing and the bracket content', () => {
    const text = fenced([
      { w: 4, s: 1, text: '  The   jury\n[[ acquitted ]]   him. ', vi: '  Họ   tuyên  ' },
      { w: 9, s: 1, text: 'Her style was simple and [[unadorned.]]' },
    ]);
    const { sentences } = parseReply(text, list378(), { now: NOW });
    assert.equal(sentences[0].text, 'The jury [[acquitted]] him.');
    assert.equal(sentences[0].answer, 'acquitted');
    assert.equal(sentences[0].vi, 'Họ tuyên');
    assert.equal(sentences[1].text, 'Her style was simple and [[unadorned]].');
    assert.equal(sentences[1].vi, '');
  });

  test('lists the meanings this reply did not cover', () => {
    const text = fenced([
      { w: 1, s: 1, text: 'The library is a [[repository]] of local history.' },
      { w: 10, s: 4, text: 'A [[progressive]] tax takes more from higher earners.' },
    ]);
    const { missing } = parseReply(text, list378(), { now: NOW });
    assert.equal(missing.length, 17);
    assert.deepEqual(pairsOf(missing).slice(0, 3), ['i1:1', 'i2:0', 'i3:0']);
    assert.ok(!pairsOf(missing).includes('i10:3'));
    assert.ok(pairsOf(missing).includes('i10:2'));
  });

  test('explains when nothing can be read', () => {
    for (const text of ['Sorry, I cannot help with that.', '', null, '{"note": "hi"}', '[1, 2]']) {
      const result = parseReply(text, list378(), { now: NOW });
      assert.deepEqual(result.sentences, []);
      assert.deepEqual(result.problems, [{ ref: null, reason: NOT_READABLE }], String(text));
      assert.equal(result.missing.length, 19);
    }
  });

  test('salvages the complete sentences of a reply that was cut off', () => {
    const full = fixture('reply-378.md');
    const cut = full.slice(0, full.indexOf('"w":6'));
    const { sentences, problems } = parseReply(cut, list378(), { now: NOW });
    assert.deepEqual(problems, []);
    assert.equal(sentences.length, 8);
  });

  test('survives line breaks and unescaped quotes inside strings', () => {
    const text = '```json\n{"sentences":[{"w":11,"s":1,"text":"His whole talk rested on the\n[[premise]] that "growth" is always good.","vi":"Tiền đề"}]}\n```';
    const { sentences, problems } = parseReply(text, list378(), { now: NOW });
    assert.deepEqual(problems, []);
    assert.equal(sentences[0].text, 'His whole talk rested on the [[premise]] that "growth" is always good.');
  });

  test('createdAt defaults to the current time', () => {
    const before = Date.now();
    const { sentences } = parseReply(fenced([{ w: 8, text: 'The [[stale]] air in the room made everyone sleepy.' }]), list378());
    assert.ok(sentences[0].createdAt >= before && sentences[0].createdAt <= Date.now());
  });
});

// ---------------------------------------------------------------------------

describe('clozeParts', () => {
  test('splits around the first [[ ]]', () => {
    assert.deepEqual(clozeParts('The jury [[acquitted]] him.'), { before: 'The jury ', answer: 'acquitted', after: ' him.' });
    assert.deepEqual(clozeParts('[[Stale]] bread.'), { before: '', answer: 'Stale', after: ' bread.' });
    assert.deepEqual(clozeParts('a [[b]] c [[d]] e'), { before: 'a ', answer: 'b', after: ' c [[d]] e' });
  });

  test('returns null without an answer', () => {
    assert.equal(clozeParts('No blank here.'), null);
    assert.equal(clozeParts('Empty [[ ]] blank.'), null);
    assert.equal(clozeParts(undefined), null);
  });
});

// ---------------------------------------------------------------------------

describe('formMatchesWord', () => {
  const yes = (pairs) => {
    for (const [form, word] of pairs) assert.equal(formMatchesWord(form, word), true, `${form} ~ ${word}`);
  };
  const no = (pairs) => {
    for (const [form, word] of pairs) assert.equal(formMatchesWord(form, word), false, `${form} !~ ${word}`);
  };

  test('exact, ignoring case, accents and edge punctuation', () => {
    yes([['acquit', 'acquit'], ['Acquit', 'acquit'], ['café', 'cafe'], ['Cafe', 'café'], ['stale,', 'stale'], ['[[jolt]]', 'jolt']]);
  });

  test('regular inflections', () => {
    yes([
      ['repositories', 'repository'], ['aggregates', 'aggregate'], ['boxes', 'box'], ['jolted', 'jolt'],
      ['fumbled', 'fumble'], ['jolting', 'jolt'], ['fumbling', 'fumble'], ['staler', 'stale'], ['stalest', 'stale'],
      ['quickly', 'quick'], ['understudied', 'understudy'], ['understudies', 'understudy'], ['happier', 'happy'],
      ['happiest', 'happy'], ['happily', 'happy'], ['acquitted', 'acquit'], ['acquitting', 'acquit'],
      ['stopping', 'stop'], ['bigger', 'big'], ['dying', 'die'], ['lying', 'lie'], ['panicked', 'panic'],
      ['panicking', 'panic'], ['simply', 'simple'], ['basically', 'basic'], ['knives', 'knife'], ['leaves', 'leaf'],
      ['company\'s', 'company'], ['students’', 'student'], ['progressively', 'progressive'],
    ]);
  });

  test('irregular verbs, also behind a prefix', () => {
    yes([
      ['went', 'go'], ['gone', 'go'], ['was', 'be'], ['were', 'be'], ['is', 'be'], ['had', 'have'], ['has', 'have'],
      ['took', 'take'], ['taken', 'take'], ['bought', 'buy'], ['thought', 'think'], ['caught', 'catch'],
      ['wrote', 'write'], ['written', 'write'], ['began', 'begin'], ['begun', 'begin'], ['lay', 'lie'], ['lain', 'lie'],
      ['laid', 'lay'], ['sought', 'seek'], ['struck', 'strike'], ['shrank', 'shrink'], ['learnt', 'learn'], ['learned', 'learn'],
      ['undertook', 'undertake'], ['undertaken', 'undertake'], ['overcame', 'overcome'], ['overcome', 'overcome'],
      ['misunderstood', 'misunderstand'], ['withdrew', 'withdraw'], ['foresaw', 'foresee'], ['became', 'become'],
      ['misled', 'mislead'], ['upheld', 'uphold'], ['undertakes', 'undertake'], ['undertaking', 'undertake'],
    ]);
  });

  test('irregular plurals and comparatives', () => {
    yes([
      ['crises', 'crisis'], ['analyses', 'analysis'], ['hypotheses', 'hypothesis'], ['phenomena', 'phenomenon'],
      ['criteria', 'criterion'], ['children', 'child'], ['men', 'man'], ['women', 'woman'], ['people', 'person'],
      ['chairmen', 'chairman'], ['grandchildren', 'grandchild'], ['data', 'datum'], ['stimuli', 'stimulus'],
      ['better', 'good'], ['worst', 'bad'], ['further', 'far'],
    ]);
  });

  test('phrasal verbs and phrases with placeholders', () => {
    yes([
      ['came up with', 'come up with'], ['comes up with', 'come up with'], ['coming up with', 'come up with'],
      ['accused him of', 'accuse (sb) of (sth)'], ['accused the former mayor of', 'accuse (sb) of (sth)'],
      ['took it for granted', 'take sth for granted'], ['takes everything for granted', 'take something for granted'],
      ['made up her mind', "make up one's mind"], ['prided himself on', 'pride oneself on'],
      ['was fed up with', '(be) fed up with'], ['fed up with', '(be) fed up with'],
      ['looked forward to', 'look forward to'], ['gave up', 'give sb/sth up'], ['gave the habit up', 'give sb/sth up'],
      ['acquitted', 'to acquit'], ['rules of thumb', 'rule of thumb'],
    ]);
    no([
      ['came up', 'come up with'], ['up with', 'come up with'], ['came', 'come up with'],
      ['accused', 'accuse (sb) of (sth)'], ['took it', 'take sth for granted'], ['the repository', 'repository'],
    ]);
  });

  test('hyphenated words and slash alternatives', () => {
    yes([
      ['level-headed', 'level-headed'], ['level-headedly', 'level-headed'], ['well-dressed', 'well-dressed'],
      ['follow-ups', 'follow-up'], ['mothers-in-law', 'mother-in-law'],
      ['colour', 'colour / color'], ['colors', 'colour / color'], ['coloured', 'colour/color'],
    ]);
    no([['level', 'level-headed'], ['headed', 'level-headed'], ['level-minded', 'level-headed'], ['shade', 'colour / color']]);
  });

  test('rejects other words', () => {
    no([
      ['progress', 'progressive'], ['acquire', 'acquit'], ['acquired', 'acquit'], ['stall', 'stale'], ['jilted', 'jolt'],
      ['premises', 'promise'], ['adorned', 'unadorned'], ['', 'acquit'], ['acquit', ''], [null, 'acquit'],
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('sentenceFromContext', () => {
  test('brackets the word form found in the context', () => {
    const item = makeItem(4, 'acquit', 'v', ['a', 'b'], { context: 'In the end, the court  acquitted her of fraud.' });
    const s = sentenceFromContext(item, NOW);
    assert.deepEqual({ ...s, id: 'x' }, {
      id: 'x', itemId: 'i4', sense: 0, text: 'In the end, the court [[acquitted]] her of fraud.',
      answer: 'acquitted', vi: '', origin: 'user', createdAt: NOW,
    });
  });

  test('uses brackets that are already there', () => {
    const item = makeItem(1, 'repository', 'n', ['a'], { context: 'Our wiki is the team’s [[ repository ]] of know-how.' });
    const s = sentenceFromContext(item, NOW);
    assert.equal(s.text, 'Our wiki is the team’s [[repository]] of know-how.');
    assert.equal(s.answer, 'repository');
  });

  test('handles phrases', () => {
    const item = makeItem(6, 'accuse (sb) of (sth)', 'v', ['buộc tội ai về điều gì'], { context: 'They accused the mayor of lying.' });
    assert.equal(sentenceFromContext(item, NOW).text, 'They [[accused the mayor of]] lying.');
  });

  test('returns null when the word is not there', () => {
    assert.equal(sentenceFromContext(makeItem(1, 'jolt', 'v', ['a'], { context: 'Nothing to see here.' }), NOW), null);
    assert.equal(sentenceFromContext(makeItem(1, 'jolt', 'v', ['a']), NOW), null);
    assert.equal(sentenceFromContext(makeItem(1, 'jolt', 'v', ['a'], { context: '   ' }), NOW), null);
  });
});

// ---------------------------------------------------------------------------

describe('coverage', () => {
  test('counts every meaning that has a sentence of any origin', () => {
    const list = list378({
      sentences: [
        existing('i1', 0, 'A [[repository]] of books.'),
        existing('i1', 0, 'Another [[repository]] of tools.'),
        existing('i4', 1, 'She [[acquitted]] herself well.', 'user'),
        existing('i10', 9, 'Out of range [[progressive]].'),
      ],
    });
    const { total, covered, missing } = coverage(list);
    assert.equal(total, 19);
    assert.equal(covered, 2);
    assert.equal(missing.length, 17);
    assert.deepEqual(missing[0], { itemId: 'i1', sense: 1 });
    assert.ok(!pairsOf(missing).includes('i4:1'));
  });

  test('empty list', () => {
    assert.deepEqual(coverage(makeList([])), { total: 0, covered: 0, missing: [] });
  });

  test('a fully answered reply covers the whole list', () => {
    const list = list378();
    list.sentences = parseReply(fixture('reply-378.md'), list, { now: NOW }).sentences;
    assert.deepEqual(coverage(list), { total: 19, covered: 19, missing: [] });
  });
});
