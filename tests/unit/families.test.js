// Word families from Claude (docs/architecture.md, "Word families from Claude").
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyFamilies, buildFamilyPrompt, checkFormation, familyStatus, isFamilyReady, memberBlank, memberForms,
  modelIndex, parseFamilyReply, rootsText,
} from '../../js/core/families.js';
import { formMatchesWord } from '../../js/core/cloze.js';
import { parseList } from '../../js/core/parse.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

const NOT_READABLE = 'Could not read the reply — copy the whole JSON block from Claude.';
const MEMBER_KEYS = ['definition', 'example', 'exampleVi', 'hint', 'ipa', 'pos', 'vi', 'word'];

// tests/fixtures/family-roots.txt as pending families, ids f1..f5.
function rootsList(extra = {}) {
  const parsed = parseList(fixture('family-roots.txt'), { kind: 'family', roots: true });
  return {
    id: 'list', kind: 'family', title: parsed.title, source: '', rawText: '', sentences: [],
    items: parsed.items.map((item, i) => ({ ...item, id: `f${i + 1}` })),
    createdAt: 0, updatedAt: 0, lastPracticedAt: null, ...extra,
  };
}

// The same list with Claude's families from tests/fixtures/family-reply.md saved.
function readyList() {
  const list = rootsList();
  return { ...list, items: applyFamilies(list.items, parseFamilyReply(fixture('family-reply.md'), list).families) };
}

const fenced = (value) => '```json\n' + JSON.stringify(value) + '\n```';
const member = (word, example, extra = {}) => ({ word, pos: 'n', ipa: 'x', vi: 'v', example, example_vi: 'e', ...extra });

// Two valid members for a family, so a test can focus on one more member.
const decideBase = [
  member('decide', 'After weeks of talks, the board finally [[decided]] to close the factory.', { pos: 'v' }),
  member('decision', 'The board\'s [[decision]] to close the factory surprised everyone.'),
];

// ---------------------------------------------------------------------------

describe('buildFamilyPrompt', () => {
  const RULES = [
    'For each word:',
    '1. List the common members of its family (usually 3–6 words across noun, verb, adjective and adverb) that share the same core meaning. Include the word itself. Leave out rare or technical forms (e.g. "authoritativeness") and words that only look related but mean something different (e.g. "author" for "authority"). Include a negative form only if it is very common (e.g. "unauthorized"), and at most one.',
    '2. If I give a meaning, build the family around that meaning.',
    '3. For each member give: part of speech, American IPA (like /rɪˈpɑːzətɔːri/), a short Vietnamese meaning, and – only when two members share a part of speech – a 1–3 word English hint that tells them apart ("permission" vs "power"). If US and UK spelling differ, write both: "authorize / authorise".',
    '4. Write one example sentence per member: natural, everyday English, 10–20 words, using the word\'s most typical collocations ("local authorities", "authorize a payment"). Where it feels natural, set the family\'s sentences in one situation, so I can see the same idea said in different ways ("She has the authority to sign" / "She is authorized to sign"). Don\'t force it: if a form doesn\'t fit, use another everyday situation. Never write stiff sentences just to fit a word in.',
    '5. Put the member in its example in double square brackets, in the form the sentence needs: [[authorized]].',
    '6. If a word has no real family (e.g. a phrasal verb), return only that word and add a short "note".',
  ];
  const WORDS = [
    'Words:',
    '1. authority (n) — quyền lực, thẩm quyền',
    '2. demonstrate (v) — chứng minh, cho thấy rõ',
    '3. able (adj) — có thể, có khả năng',
    '4. decide (v) — quyết định',
    '5. come up with (phr v) — nghĩ ra, nảy ra (ý tưởng)',
  ];

  test('the agreed prompt, word for word (with Vietnamese translations)', () => {
    assert.equal(buildFamilyPrompt(rootsList()), [
      "I'm a Vietnamese learner of English at about B2 level. For each word below, give me its word family so I can practise word formation.",
      '',
      ...RULES,
      '7. "example_vi" is a natural Vietnamese translation of the example.',
      '',
      'Reply with ONLY one JSON code block in this format, where "w" is the word number below:',
      '{"families":[{"w":1,"note":"","members":[{"word":"authority","pos":"n","ipa":"əˈθɔːrəti","hint":"power to decide","vi":"quyền lực, thẩm quyền","example":"Only the director has the [[authority]] to approve overtime.","example_vi":"…"}]}]}',
      '',
      ...WORDS,
    ].join('\n'));
  });

  test('without translations: no rule 7 and no "example_vi" in the format', () => {
    assert.equal(buildFamilyPrompt(rootsList(), { level: 'C1', translate: false }), [
      "I'm a Vietnamese learner of English at about C1 level. For each word below, give me its word family so I can practise word formation.",
      '',
      ...RULES,
      '',
      'Reply with ONLY one JSON code block in this format, where "w" is the word number below:',
      '{"families":[{"w":1,"note":"","members":[{"word":"authority","pos":"n","ipa":"əˈθɔːrəti","hint":"power to decide","vi":"quyền lực, thẩm quyền","example":"Only the director has the [[authority]] to approve overtime."}]}]}',
      '',
      ...WORDS,
    ].join('\n'));
  });

  test('the format line is valid JSON that parseFamilyReply understands', () => {
    const prompt = buildFamilyPrompt(rootsList());
    const line = prompt.split('\n').find((l) => l.startsWith('{"families"'));
    assert.doesNotThrow(() => JSON.parse(line));
  });

  test('only: just those words, numbered as in the list', () => {
    const prompt = buildFamilyPrompt(rootsList(), { only: ['f4', 'f2', 'nope'] });
    assert.deepEqual(prompt.split('Words:\n')[1].split('\n'), [
      '2. demonstrate (v) — chứng minh, cho thấy rõ',
      '4. decide (v) — quyết định',
    ]);
  });

  test('nothing to ask for gives an empty string', () => {
    assert.equal(buildFamilyPrompt(rootsList(), { only: [] }), '');
    assert.equal(buildFamilyPrompt({ items: [] }), '');
    assert.equal(buildFamilyPrompt(null), '');
    assert.equal(buildFamilyPrompt({ items: [{ id: 'x', root: '', members: [] }] }), '');
  });

  test('pos and meaning only when present; whitespace in meanings collapsed', () => {
    const items = [
      { id: 'a', root: 'authority', rootPos: '', rootMeaning: '', note: '', members: [] },
      { id: 'b', root: 'decide', rootPos: 'v', rootMeaning: '', note: '', members: [] },
      { id: 'c', root: 'able', rootPos: '', rootMeaning: '  có   thể;\n có khả năng ', note: '', members: [] },
    ];
    assert.deepEqual(buildFamilyPrompt({ items }).split('Words:\n')[1].split('\n'), [
      '1. authority', '2. decide (v)', '3. able — có thể; có khả năng',
    ]);
  });

  test('a family pasted fully written is asked for by its model member', () => {
    const list = parseList(fixture('family.txt'), { kind: 'family' });
    const lines = buildFamilyPrompt(list).split('Words:\n')[1].split('\n');
    assert.deepEqual(lines, [
      '1. poorness (n) — the state or condition of being poor',
      '2. creation (n) — the act of creating',
    ]);
  });

  test('a ready family keeps asking for its root (Redo)', () => {
    const lines = buildFamilyPrompt(readyList(), { only: ['f1'] }).split('Words:\n')[1].split('\n');
    assert.deepEqual(lines, ['1. authority (n) — quyền lực, thẩm quyền']);
  });
});

// ---------------------------------------------------------------------------

describe('parseFamilyReply: family-reply.md', () => {
  const list = rootsList();
  const result = parseFamilyReply(fixture('family-reply.md'), list);

  test('5 families, 21 members, no problems, nothing missing', () => {
    assert.equal(result.families.length, 5);
    assert.equal(result.families.reduce((n, f) => n + f.members.length, 0), 21);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.families.map((f) => f.itemId), ['f1', 'f2', 'f3', 'f4', 'f5']);
    assert.deepEqual(Object.keys(result).sort(), ['families', 'missing', 'problems']);
  });

  test('members are shaped exactly as FamilyMember', () => {
    for (const family of result.families) {
      assert.deepEqual(Object.keys(family).sort(), ['itemId', 'members', 'note']);
      for (const m of family.members) {
        assert.deepEqual(Object.keys(m).sort(), MEMBER_KEYS);
        for (const key of MEMBER_KEYS) assert.equal(typeof m[key], 'string', key);
        assert.equal(m.example.match(/\[\[/g).length, 1, m.example);
        assert.ok(m.exampleVi.length > 0 && m.vi.length > 0 && m.ipa.length > 0, m.word);
        assert.ok(!m.ipa.includes('/'), m.ipa);
      }
    }
  });

  test('the authority family: 6 members with hints, slash spellings and translations', () => {
    const [authority] = result.families;
    assert.deepEqual(authority.members.map((m) => [m.word, m.pos, m.hint]), [
      ['authority', 'n', 'power to decide'],
      ['authorize / authorise', 'v', ''],
      ['authorization / authorisation', 'n', 'official permission'],
      ['authoritative', 'adj', 'reliable, trusted'],
      ['authoritatively', 'adv', ''],
      ['unauthorized / unauthorised', 'adj', 'without permission'],
    ]);
    assert.deepEqual(authority.members[1], {
      word: 'authorize / authorise',
      pos: 'v',
      ipa: 'ˈɔːθəraɪz',
      definition: '',
      vi: 'cho phép, ủy quyền',
      hint: '',
      example: 'Payments over $10,000 must be [[authorized]] by the finance director.',
      exampleVi: 'Các khoản chi trên 10.000 đô la phải được giám đốc tài chính cho phép.',
    });
    assert.equal(authority.note, '');
  });

  test('a note for the word with no family (w5)', () => {
    const w5 = result.families[4];
    assert.equal(w5.note, 'Phrasal verb — it has no word family.');
    assert.deepEqual(w5.members.map((m) => [m.word, m.pos]), [['come up with', 'phr v']]);
    assert.ok(result.families.slice(0, 4).every((f) => f.note === ''));
  });

  test('every member has a blank whose answer is a form of the member', () => {
    let count = 0;
    for (const family of result.families) {
      for (const m of family.members) {
        const blank = memberBlank(m);
        assert.ok(blank, m.word);
        assert.ok(formMatchesWord(blank.answer, m.word), `${blank.answer} / ${m.word}`);
        assert.equal(blank.before + `[[${blank.answer}]]` + blank.after, m.example);
        count++;
      }
    }
    assert.equal(count, 21);
  });

  test('the same reply in other shapes reads the same', () => {
    const reply = fixture('family-reply.md');
    const smart = reply.replace(/"/g, (_, i, s) => (/[{,:[]\s*$/.test(s.slice(Math.max(0, i - 3), i)) ? '“' : '”'));
    assert.ok(smart.includes('{“w”:1,“members”'), 'the smart-quote variant really uses smart delimiters');
    const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
    const expected = result.families.map((f) => [f.itemId, f.note, f.members]);
    for (const text of [
      reply.normalize('NFD'),
      reply.replace(/\n/g, '\r\n'),
      smart,
      json,
      `\uFEFF${json}`,
      `Sure! ${json.replace(/\n/g, ' ')} Hope that helps.`,
      `${reply}\n\n${reply}`, // pasted twice
    ]) {
      const again = parseFamilyReply(text, rootsList());
      assert.deepEqual(again.problems, [], text.slice(0, 40));
      assert.deepEqual(again.families.map((f) => [f.itemId, f.note, f.members]), expected);
    }
  });
});

// ---------------------------------------------------------------------------

describe('parseFamilyReply: messy replies', () => {
  test('smart quotes, trailing commas and prose around an unfenced block', () => {
    const text = [
      'Here you go:',
      '{“families”:[',
      '{“w”:4,“members”:[',
      '{“word”:“decide”,“pos”:“v”,“example”:“The board [[decided]] to close the “old” factory.”,“example_vi”:“Hội đồng quyết định.”,},',
      '{“word”:“decision”,“pos”:“n”,“example”:“Their [[decision]] surprised everyone.”,},',
      '],},',
      ']}',
      'Want more?',
    ].join('\n');
    const { families, problems } = parseFamilyReply(text, rootsList());
    assert.deepEqual(problems, []);
    assert.deepEqual(families.map((f) => f.members.map((m) => m.word)), [['decide', 'decision']]);
    assert.equal(families[0].members[0].example, 'The board [[decided]] to close the “old” factory.');
  });

  test('a reply split over two code blocks is read completely', () => {
    const reply = parseFamilyReply(fixture('family-reply.md'), rootsList());
    const json = JSON.parse(fixture('family-reply.md').match(/```json\n([\s\S]*?)```/)[1]);
    const text = `Part 1:\n${fenced({ families: json.families.slice(0, 2) })}\n\nPart 2:\n${fenced({ families: json.families.slice(2) })}`;
    const split = parseFamilyReply(text, rootsList());
    assert.deepEqual(split.problems, []);
    assert.deepEqual(split.families, reply.families);
  });

  test('the format line echoed in its own block is ignored', () => {
    const prompt = buildFamilyPrompt(rootsList());
    const formatLine = prompt.split('\n').find((l) => l.startsWith('{"families"'));
    const real = fenced({ families: [{ w: 4, members: decideBase }] });
    const { families, problems, missing } = parseFamilyReply(`The format is:\n\`\`\`json\n${formatLine}\n\`\`\`\nHere you go:\n${real}`, rootsList());
    assert.deepEqual(problems, []);
    assert.deepEqual(families.map((f) => f.itemId), ['f4']);
    assert.deepEqual(missing, ['f1', 'f2', 'f3', 'f5']);
  });

  test('alias keys: family/words at the top, forms/family for members, form, translation, exampleVi, meaning', () => {
    const value = {
      words: [
        { w: '4', forms: [
          { form: 'decide', pos: 'verb', meaning: 'quyết định', example: 'They [[decided]] to stay home.', translation: 'Họ quyết định ở nhà.' },
          { form: 'decision', pos: 'Noun', vi: 'quyết định', example: 'It was a hard [[decision]].', exampleVi: 'Đó là quyết định khó.' },
        ] },
      ],
    };
    const variants = [
      value,
      { family: value.words.map(({ forms, ...rest }) => ({ ...rest, family: forms })) },
      { families: value.words.map(({ forms, ...rest }) => ({ ...rest, members: forms })) },
    ];
    for (const v of variants) {
      const { families, problems } = parseFamilyReply(fenced(v), rootsList());
      assert.deepEqual(problems, [], JSON.stringify(v));
      assert.deepEqual(families[0].members.map((m) => [m.word, m.pos, m.vi, m.exampleVi]), [
        ['decide', 'v', 'quyết định', 'Họ quyết định ở nhà.'],
        ['decision', 'n', 'quyết định', 'Đó là quyết định khó.'],
      ], JSON.stringify(v));
    }
  });

  test('pos spelled out, IPA with or without slashes, w as a number or numeric string', () => {
    const text = fenced({ families: [
      { w: 'w2', members: [
        member('demonstrate', 'The data [[demonstrates]] that it works.', { pos: 'Verb', ipa: '/ˈdemənstreɪt/' }),
        member('demonstration', 'It was a clear [[demonstration]] of skill.', { pos: 'noun', ipa: 'ˌdemənˈstreɪʃn' }),
        member('demonstrable', 'It had a [[demonstrable]] effect.', { pos: 'adjective', ipa: '[dɪˈmɑːnstrəbl]' }),
        member('demonstrably', 'They recovered [[demonstrably]] faster.', { pos: 'Adverb' }),
      ] },
      { w: '3', members: [member('able', 'She was [[able]] to help.', { pos: 'adj.' }), member('ability', 'Her [[ability]] grew.')] },
      { w: 5.0, members: [member('come up with', 'We [[came up with]] a plan.', { pos: 'phrasal verb' })], note: 'No family.' },
    ] });
    const { families, problems } = parseFamilyReply(text, rootsList());
    assert.deepEqual(problems, []);
    assert.deepEqual(families.map((f) => f.itemId), ['f2', 'f3', 'f5']);
    assert.deepEqual(families[0].members.map((m) => [m.pos, m.ipa]), [
      ['v', 'ˈdemənstreɪt'], ['n', 'ˌdemənˈstreɪʃn'], ['adj', 'dɪˈmɑːnstrəbl'], ['adv', 'x'],
    ]);
    assert.equal(families[1].members[0].pos, 'adj');
    assert.equal(families[2].members[0].pos, 'phr v');
  });

  test('an unknown part of speech is kept as written', () => {
    const { families } = parseFamilyReply(fenced({ families: [{ w: 4, members: [...decideBase, member('deciding', 'The [[deciding]] vote was hers.', { pos: 'gerund' })] }] }), rootsList());
    assert.equal(families[0].members[2].pos, 'gerund');
  });

  test('members written as plain strings', () => {
    const { families, problems, missing } = parseFamilyReply('```json\n{"families":[{"w":3,"members":["able","ability","unable"]}]}\n```', rootsList());
    assert.deepEqual(families[0].members.map((m) => m.word), ['able', 'ability', 'unable']);
    assert.deepEqual(families[0].members[0], { word: 'able', pos: '', ipa: '', definition: '', vi: '', hint: '', example: '', exampleVi: '' });
    assert.deepEqual(problems.map((p) => [p.ref, p.reason, p.skipped]), [
      ['w3 member 1', 'No example sentence.', false],
      ['w3 member 2', 'No example sentence.', false],
      ['w3 member 3', 'No example sentence.', false],
    ]);
    assert.ok(!missing.includes('f3'));
  });

  test('JSON Lines, a bare array and a reply cut off half-way', () => {
    const a = { w: 3, members: [member('able', 'She was [[able]] to help.'), member('ability', 'Her [[ability]] grew fast.')] };
    const b = { w: 4, members: decideBase };
    for (const text of [`${JSON.stringify(a)}\n${JSON.stringify(b)}`, JSON.stringify([a, b]), '```jsonl\n' + JSON.stringify(a) + '\n' + JSON.stringify(b) + '\n```']) {
      const { families, problems } = parseFamilyReply(text, rootsList());
      assert.deepEqual(problems, [], text);
      assert.deepEqual(families.map((f) => f.itemId), ['f3', 'f4'], text);
    }
    const full = fixture('family-reply.md');
    const cut = full.slice(0, full.indexOf('"w":4') + 60); // inside the 4th family, block left open
    const { families, problems, missing } = parseFamilyReply(cut, rootsList());
    assert.deepEqual(problems, []);
    assert.deepEqual(families.map((f) => f.itemId), ['f1', 'f2', 'f3']);
    assert.deepEqual(missing, ['f4', 'f5']);
  });

  test('missing brackets are added; a wrong or second bracket is fixed when the word is there', () => {
    const { families, problems } = parseFamilyReply(fenced({ families: [{ w: 4, members: [
      member('decide', 'After weeks of talks, the board finally decided to close the factory.'),
      member('decision', 'The [[board\'s]] decision surprised everyone.'),
      member('decisive', 'She was [[calm]] and [[decisive]] in the crisis.'),
      member('decisively', 'He acted **decisively** to stop the losses.'),
    ] }] }), rootsList());
    assert.deepEqual(problems, []);
    assert.deepEqual(families[0].members.map((m) => m.example), [
      'After weeks of talks, the board finally [[decided]] to close the factory.',
      'The board\'s [[decision]] surprised everyone.',
      'She was calm and [[decisive]] in the crisis.',
      'He acted [[decisively]] to stop the losses.',
    ]);
  });

  test('a wrong bracket word is reported and the member kept without a blank', () => {
    const { families, problems, missing } = parseFamilyReply(fenced({ families: [{ w: 4, members: [
      ...decideBase,
      member('decisive', 'Investors praised the new CEO for being [[firm]] during the crisis.', { pos: 'adj' }),
      member('indecisive', 'He could not choose.'),
    ] }] }), rootsList());
    assert.deepEqual(problems, [
      { ref: 'w4 member 3', reason: '[[firm]] is not a form of "decisive".', text: 'Investors praised the new CEO for being firm during the crisis.', skipped: false },
      { ref: 'w4 member 4', reason: '"indecisive" is not in the example.', text: 'He could not choose.', skipped: false },
    ]);
    const kept = families[0].members[2];
    assert.equal(kept.example, 'Investors praised the new CEO for being firm during the crisis.');
    assert.equal(memberBlank(kept), null);
    assert.equal(families[0].members.length, 4);
    assert.ok(!missing.includes('f4'));
  });

  test('two brackets where neither is the word', () => {
    const { problems } = parseFamilyReply(fenced({ families: [{ w: 4, members: [...decideBase, member('decisive', 'Be [[calm]] and [[firm]].')] }] }), rootsList());
    assert.deepEqual(problems.map((p) => [p.ref, p.reason]), [['w4 member 3', 'The example has more than one [[ ]].']]);
  });

  test('members without a word are skipped; duplicates are dropped', () => {
    const { families, problems } = parseFamilyReply(fenced({ families: [{ w: 1, members: [
      member('authority', 'Only the manager has the [[authority]] to sign.'),
      member('authorize / authorise', 'She [[authorized]] the payment.', { pos: 'v' }),
      member('Authority', 'The [[authority]] to decide is hers.'),
      member('authorise', 'He [[authorised]] it.', { pos: 'v' }),
      { pos: 'adj', example: 'An [[authoritative]] report.' },
      42,
    ] }] }), rootsList());
    assert.deepEqual(families[0].members.map((m) => m.word), ['authority', 'authorize / authorise']);
    assert.deepEqual(problems, [
      { ref: 'w1 member 5', reason: 'This member has no word.', text: 'An [[authoritative]] report.', skipped: true },
      { ref: 'w1 member 6', reason: 'This is not a word.', skipped: true },
    ]);
  });

  test('member words are tidied: slashes, brackets, quotes, markdown and a trailing pos', () => {
    const { families } = parseFamilyReply(fenced({ families: [{ w: 1, members: [
      member('**authority**', 'The [[authority]] to sign.'),
      member('authorize/authorise', 'She [[authorized]] it.', { pos: '' }),
      member('“authoritative” (adj)', 'An [[authoritative]] guide.', { pos: '' }),
    ] }] }), rootsList());
    assert.deepEqual(families[0].members.map((m) => [m.word, m.pos]), [
      ['authority', 'n'], ['authorize / authorise', ''], ['authoritative', 'adj'],
    ]);
  });

  test('unknown or missing word numbers are reported', () => {
    const { families, problems } = parseFamilyReply(fenced({ families: [
      { w: 9, members: decideBase },
      { members: decideBase },
      { w: 'decide', members: decideBase },
    ] }), rootsList());
    assert.deepEqual(problems, [
      { ref: null, reason: 'A family has no word number ("w").', text: 'decide, decision', skipped: true },
      { ref: 'w9', reason: 'There is no word 9 in this list.', text: 'decide, decision', skipped: true },
    ]);
    assert.deepEqual(families.map((f) => f.itemId), ['f4']); // found by its root word
  });

  test('a family may be named by its root instead of a number', () => {
    const { families, problems } = parseFamilyReply(fenced({ families: [{ root: 'Decide', members: decideBase }] }), rootsList());
    assert.deepEqual(problems, []);
    assert.deepEqual(families.map((f) => f.itemId), ['f4']);
  });

  test('a family with no members is missing; one member needs a note', () => {
    const { families, problems, missing } = parseFamilyReply(fenced({ families: [
      { w: 2, members: [] },
      { w: 3, members: [member('able', 'She was [[able]] to help.')] },
      { w: 5, note: 'Phrasal verb — it has no word family.', members: [member('come up with', 'We [[came up with]] a plan.')] },
    ] }), rootsList());
    assert.deepEqual(families.map((f) => f.itemId), ['f3', 'f5']);
    assert.deepEqual(problems, [
      { ref: 'w2', reason: 'No words for this family.', skipped: true },
      { ref: 'w3', reason: 'Only one word came back for this family.', text: 'able', skipped: false },
    ]);
    assert.deepEqual(missing, ['f1', 'f2', 'f3', 'f4']);
  });

  test('a family numbered wrongly moves to the word whose root it contains', () => {
    const { families, problems, missing } = parseFamilyReply(fenced({ families: [{ w: 3, members: decideBase }] }), rootsList());
    assert.deepEqual(families.map((f) => f.itemId), ['f4']);
    assert.deepEqual(problems, [{ ref: 'w4', reason: 'Came back as word 3 — matched by its forms.', text: 'decide, decision', skipped: false }]);
    assert.deepEqual(missing, ['f1', 'f2', 'f3', 'f5']);
  });

  // family-reply.md's families by word number.
  const replyFamilies = () => JSON.parse(fixture('family-reply.md').match(/```json\n([\s\S]*?)```/)[1]).families;

  test('renumbered (1 and 2 for words 2 and 4): saved families are never overwritten', () => {
    const list = readyList();
    list.items[1] = { ...list.items[1], members: [] };
    list.items[3] = { ...list.items[3], members: [] };
    const [, demonstrate, , decide] = replyFamilies();
    const { families, problems, missing } = parseFamilyReply(fenced({ families: [{ ...demonstrate, w: 1 }, { ...decide, w: 2 }] }), list);
    assert.deepEqual(families.map((f) => [f.itemId, f.members[0].word]), [['f2', 'demonstrate'], ['f4', 'decide']]);
    assert.deepEqual(problems.map((p) => [p.ref, p.reason, p.skipped]), [
      ['w2', 'Came back as word 1 — matched by its forms.', false],
      ['w4', 'Came back as word 2 — matched by its forms.', false],
    ]);
    assert.deepEqual(missing, []);
  });

  test('numbered from 0, or with two numbers swapped', () => {
    const zero = replyFamilies().map((f, i) => ({ ...f, w: i }));
    const a = parseFamilyReply(fenced({ families: zero }), rootsList());
    assert.deepEqual(a.families.map((f) => [f.itemId, f.members[0].word]), [
      ['f1', 'authority'], ['f2', 'demonstrate'], ['f3', 'able'], ['f4', 'decide'], ['f5', 'come up with'],
    ]);
    assert.deepEqual(a.missing, []);
    assert.ok(a.problems.every((p) => !p.skipped && /^Came back as word \d — matched by its forms\.$/.test(p.reason)));

    const swapped = replyFamilies().map((f) => ({ ...f, w: f.w === 2 ? 4 : f.w === 4 ? 2 : f.w }));
    const b = parseFamilyReply(fenced({ families: swapped }), rootsList());
    assert.deepEqual(b.families.map((f) => [f.itemId, f.members[0].word]).sort(), [
      ['f1', 'authority'], ['f2', 'demonstrate'], ['f3', 'able'], ['f4', 'decide'], ['f5', 'come up with'],
    ]);
    assert.deepEqual(b.problems.map((p) => p.ref), ['w2', 'w4']);
  });

  test('a family for no word in the list: kept (flagged) on a word still waiting, skipped on a saved one', () => {
    const capable = [member('capable', 'She is very [[capable]] at work.', { pos: 'adj' }), member('capability', 'It is beyond our [[capability]].')];
    const pending = parseFamilyReply(fenced({ families: [{ w: 3, members: capable }] }), rootsList());
    assert.deepEqual(pending.families.map((f) => f.itemId), ['f3']);
    assert.deepEqual(pending.problems, [{ ref: 'w3', reason: '"able" is not in this family — is the word number right?', text: 'capable, capability', skipped: false }]);
    const saved = parseFamilyReply(fenced({ families: [{ w: 3, members: capable }] }), readyList());
    assert.deepEqual(saved.families, []);
    assert.deepEqual(saved.problems, [{ ref: 'w3', reason: '"able" is not in this family — is the word number right?', text: 'capable, capability', skipped: true }]);
  });

  test('a second family for a word that already has one is skipped', () => {
    const { families, problems } = parseFamilyReply(fenced({ families: [{ w: 1, members: decideBase }, { w: 4, members: decideBase }] }), rootsList());
    assert.deepEqual(families.map((f) => f.itemId), ['f4']);
    assert.deepEqual(problems, [{ ref: 'w1', reason: '"authority" is not in this family — is the word number right?', text: 'decide, decision', skipped: true }]);
  });

  test('a family with no number, or a number not in the list, is matched by its forms', () => {
    const { families, problems } = parseFamilyReply(fenced({ families: [{ members: decideBase }, { w: 9, members: replyFamilies()[2].members }] }), rootsList());
    assert.deepEqual(families.map((f) => f.itemId), ['f4', 'f3']);
    assert.deepEqual(problems.map((p) => [p.ref, p.reason]), [
      ['w3', 'Came back as word 9 — matched by its forms.'],
      ['w4', 'Came back without a word number — matched by its forms.'],
    ]);
  });

  test('member problems follow a family that moved', () => {
    const { problems } = parseFamilyReply(fenced({ families: [{ w: 1, members: [...decideBase, member('decisive', 'No blank.')] }] }), rootsList());
    assert.deepEqual(problems.map((p) => p.ref), ['w4', 'w4 member 3']);
  });

  test('a word with no family: the note may sit inside the member, or come without members', () => {
    const note = 'Phrasal verb — it has no word family.';
    const comeUpWith = member('come up with', 'We [[came up with]] a plan.', { pos: 'phr v' });
    for (const family of [
      { w: 5, members: [{ ...comeUpWith, note }] },
      { w: 5, note, members: [] },
      { w: 5, note },
    ]) {
      const { families, problems, missing } = parseFamilyReply(fenced({ families: [family] }), rootsList());
      assert.deepEqual(problems, [], JSON.stringify(family));
      assert.deepEqual(families.map((f) => [f.itemId, f.note, f.members.map((m) => [m.word, m.pos])]), [
        ['f5', note, [['come up with', 'phr v']]],
      ], JSON.stringify(family));
      assert.ok(!missing.includes('f5'));
    }
    const built = parseFamilyReply(fenced({ families: [{ w: 5, note }] }), rootsList()).families[0].members[0];
    assert.deepEqual(Object.keys(built).sort(), MEMBER_KEYS);
    // A member's note does not make a family of two or more.
    const two = parseFamilyReply(fenced({ families: [{ w: 4, members: [{ ...decideBase[0], note: 'x' }, decideBase[1]] }] }), rootsList());
    assert.equal(two.families[0].note, '');
  });

  test('the root check allows other forms and placeholders', () => {
    const list = { items: [
      { id: 'a', root: 'authorities', members: [] },
      { id: 'b', root: 'accuse (sb) of (sth)', members: [] },
      { id: 'c', root: 'colour', members: [] },
    ] };
    const { problems } = parseFamilyReply(fenced({ families: [
      { w: 1, members: [member('authority', 'The [[authority]] is hers.'), member('authorize', 'She [[authorized]] it.')] },
      { w: 2, note: 'No family.', members: [member('accuse sb of sth', 'They [[accused]] him of lying.')] },
      { w: 3, members: [member('colour / color', 'What [[colour]] is it?'), member('colourful / colorful', 'A [[colourful]] shirt.')] },
    ] }), list);
    assert.deepEqual(problems, []);
  });

  test('the same word twice: later members replace earlier ones, problems are not doubled', () => {
    const first = { w: 4, members: [member('decide', 'They [[decided]] early.'), member('decision', 'No [[decision]] yet.')] };
    const second = { w: 4, note: '', members: [member('decision', 'A quick [[decision]] helps.'), member('decisive', 'Be [[decisive]].')] };
    const { families } = parseFamilyReply(`${fenced({ families: [first] })}\n${fenced({ families: [second] })}`, rootsList());
    assert.deepEqual(families[0].members.map((m) => [m.word, m.example]), [
      ['decide', 'They [[decided]] early.'],
      ['decision', 'A quick [[decision]] helps.'],
      ['decisive', 'Be [[decisive]].'],
    ]);
    const flawed = { w: 4, members: [...decideBase, member('decisive', 'No blank here.')] };
    const twice = parseFamilyReply(`${fenced({ families: [flawed] })}\n${fenced({ families: [flawed] })}`, rootsList());
    assert.equal(twice.problems.length, 1);
  });

  test('problems come in word order', () => {
    const { problems } = parseFamilyReply(fenced({ families: [
      { w: 4, members: [...decideBase, member('decisive', 'No blank.')] },
      { w: 9, members: decideBase },
      { w: 2, members: [] },
      { members: [] },
    ] }), rootsList());
    assert.deepEqual(problems.map((p) => p.ref), [null, 'w2', 'w4 member 3', 'w9']);
  });

  test('missing: only the families still pending after this reply', () => {
    const list = readyList();
    list.items[1] = { ...list.items[1], members: [] }; // w2 pending again
    list.items[3] = { ...list.items[3], members: [] }; // w4 pending again
    const prompt = buildFamilyPrompt(list, { only: familyStatus(list).pending });
    assert.match(prompt, /\n2\. demonstrate[\s\S]*\n4\. decide/);
    const { families, missing } = parseFamilyReply(fenced({ families: [{ w: 4, members: decideBase }] }), list);
    assert.deepEqual(families.map((f) => f.itemId), ['f4']);
    assert.deepEqual(missing, ['f2']);
  });

  test('a reply that cannot be read', () => {
    for (const text of ['', null, 'Sorry, I cannot help with that.', '{"note": "hi"}', '[1, 2]', '```json\n{"families":\n```']) {
      const result = parseFamilyReply(text, rootsList());
      assert.deepEqual(result.families, []);
      assert.deepEqual(result.problems, [{ ref: null, reason: NOT_READABLE }], String(text));
      assert.deepEqual(result.missing, ['f1', 'f2', 'f3', 'f4', 'f5']);
    }
  });

  test('an empty list or no list does not throw', () => {
    assert.doesNotThrow(() => parseFamilyReply(fixture('family-reply.md'), null));
    const { families, problems } = parseFamilyReply(fixture('family-reply.md'), { items: [] });
    assert.deepEqual(families, []);
    assert.equal(problems.length, 5);
    assert.ok(problems.every((p) => p.skipped && /There is no word \d in this list\./.test(p.reason)));
  });

  test('a long reply parses quickly', () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ id: `x${i}`, root: 'decide', members: [] }));
    const text = fenced({ families: items.map((_, i) => ({ w: i + 1, members: decideBase })) });
    const start = performance.now();
    const { families } = parseFamilyReply(text, { items });
    assert.equal(families.length, 300);
    assert.ok(performance.now() - start < 1500);
  });

  test('pathological pastes stay fast', () => {
    for (const text of [
      '{'.repeat(20000), '}'.repeat(20000), '{}'.repeat(20000), '{'.repeat(5000) + '}'.repeat(5000),
      '{"w":1,"members":['.repeat(3000), '"'.repeat(50000), '[['.repeat(20000), '```'.repeat(5000),
    ]) {
      const start = performance.now();
      const result = parseFamilyReply(text, rootsList());
      assert.ok(performance.now() - start < 500, text.slice(0, 20));
      assert.deepEqual(result.families, []);
    }
  });
});

// ---------------------------------------------------------------------------

describe('familyStatus and applyFamilies', () => {
  test('ready = 2+ members, or 1 member and a note', () => {
    assert.equal(isFamilyReady({ members: [] }), false);
    assert.equal(isFamilyReady({ members: [{ word: 'a' }] }), false);
    assert.equal(isFamilyReady({ members: [{ word: 'a' }], note: '  ' }), false);
    assert.equal(isFamilyReady({ members: [{ word: 'a' }], note: 'No family.' }), true);
    assert.equal(isFamilyReady({ members: [{ word: 'a' }, { word: 'b' }] }), true);
    assert.equal(isFamilyReady({}), false);
    assert.equal(isFamilyReady(null), false);
  });

  test('pending roots, ready families and old written-out families', () => {
    assert.deepEqual(familyStatus(rootsList()), { total: 5, ready: 0, pending: ['f1', 'f2', 'f3', 'f4', 'f5'] });
    assert.deepEqual(familyStatus(readyList()), { total: 5, ready: 5, pending: [] });
    const written = parseList(fixture('family.txt'), { kind: 'family' });
    assert.deepEqual(familyStatus(written), { total: 2, ready: 2, pending: [] });
    assert.deepEqual(familyStatus(null), { total: 0, ready: 0, pending: [] });
  });

  test('applyFamilies replaces members and note, keeps the rest, does not mutate', () => {
    const list = rootsList();
    const before = JSON.stringify(list);
    const { families } = parseFamilyReply(fixture('family-reply.md'), list);
    const items = applyFamilies(list.items, families);
    assert.equal(JSON.stringify(list), before);
    assert.deepEqual(items.map((i) => [i.id, i.root, i.rootPos, i.members.length]), [
      ['f1', 'authority', 'n', 6], ['f2', 'demonstrate', 'v', 4], ['f3', 'able', 'adj', 5], ['f4', 'decide', 'v', 5], ['f5', 'come up with', 'phr v', 1],
    ]);
    assert.equal(items[4].note, 'Phrasal verb — it has no word family.');
    items[0].members[0].word = 'changed';
    assert.equal(families[0].members[0].word, 'authority');
    assert.equal(applyFamilies(list.items, [])[0], list.items[0]);
  });

  test('rootsText: the roots in the one-line format, read back as the same roots', () => {
    const text = rootsText(readyList().items);
    assert.equal(text.split('\n')[0], '1. authority (n): quyền lực, thẩm quyền');
    assert.equal(text.split('\n')[4], '5. come up with (phr v): nghĩ ra, nảy ra (ý tưởng)');
    const back = parseList(text, { kind: 'family', roots: true });
    assert.deepEqual(back.items.map((i) => [i.root, i.rootPos, i.rootMeaning]), rootsList().items.map((i) => [i.root, i.rootPos, i.rootMeaning]));
    const written = parseList(fixture('family.txt'), { kind: 'family' });
    assert.equal(rootsText(written.items), '1. poorness (n): the state or condition of being poor\n2. creation (n): the act of creating');
    assert.equal(rootsText([{ id: 'x', root: '', members: [] }, { id: 'y', root: 'able', members: [] }]), '1. able');
    assert.equal(rootsText(null), '');
  });

  test('a written-out family rebuilt by Claude keeps its model word as root', () => {
    const written = parseList(fixture('family.txt'), { kind: 'family' });
    const [first] = applyFamilies(written.items, [{ itemId: written.items[0].id, note: '', members: decideBase.map((m) => ({ word: m.word })) }]);
    assert.equal(first.root, 'poorness');
    // …and its part of speech and meaning, for the next prompt and rootsText.
    assert.equal(first.rootPos, 'n');
    assert.equal(first.rootMeaning, 'the state or condition of being poor');
    assert.equal(first.note, '');
    assert.deepEqual(first.members.map((m) => m.word), ['decide', 'decision']);
  });
});

// ---------------------------------------------------------------------------

describe('memberForms, modelIndex and memberBlank', () => {
  test('memberForms: the spellings on either side of a slash', () => {
    assert.deepEqual(memberForms({ word: 'authorize / authorise' }), ['authorize', 'authorise']);
    assert.deepEqual(memberForms({ word: 'colour/color' }), ['colour', 'color']);
    assert.deepEqual(memberForms({ word: '  come  up with ' }), ['come up with']);
    assert.deepEqual(memberForms({ word: 'Able / able' }), ['Able']);
    assert.deepEqual(memberForms({ word: '' }), []);
    assert.deepEqual(memberForms(null), []);
  });

  test('modelIndex: the member that is the root, else 0', () => {
    const [authority, , able] = readyList().items;
    assert.equal(modelIndex(authority), 0);
    assert.equal(modelIndex({ ...authority, root: 'authorise' }), 1);
    assert.equal(modelIndex({ ...authority, root: 'Authoritative' }), 3);
    assert.equal(modelIndex({ ...able, root: 'unable' }), 4);
    assert.equal(modelIndex({ ...able, root: 'abilities' }), 1); // a pasted plural
    assert.equal(modelIndex({ ...able, root: 'capable' }), 0);
    assert.equal(modelIndex({ ...able, root: '' }), 0);
    assert.equal(modelIndex({ members: [] }), 0);
    assert.equal(modelIndex(null), 0);
  });

  test('memberBlank: from [[ ]], else the word found in an old example', () => {
    assert.deepEqual(memberBlank({ word: 'decide', example: 'They [[decided]] to go.' }), { before: 'They ', answer: 'decided', after: ' to go.' });
    const written = parseList(fixture('family.txt'), { kind: 'family' });
    const blanks = written.items[0].members.map(memberBlank);
    assert.deepEqual(blanks.map((b) => b.answer), ['poorness', 'impoverish', 'poor', 'poorly']);
    assert.equal(blanks[0].before, "The family's ");
    assert.equal(memberBlank(written.items[1].members[0]), null); // no example
    assert.equal(memberBlank({ word: 'decide', example: 'Nothing here.' }), null);
    assert.equal(memberBlank({ word: 'decide', example: '' }), null);
    assert.equal(memberBlank(null), null);
    assert.deepEqual(memberBlank({ word: 'come up with', example: 'We came up with a plan.' }), { before: 'We ', answer: 'came up with', after: ' a plan.' });
    assert.deepEqual(memberBlank({ word: 'x', example: 'A [[first]] and [[second]].' }), { before: 'A ', answer: 'first', after: ' and second.' });
  });
});

// ---------------------------------------------------------------------------

describe('checkFormation', () => {
  const families = readyList().items;
  const [authority, demonstrate, able, decide, comeUpWith] = families.map((f) => f.members);
  const check = (input, m, opts) => checkFormation(input, memberBlank(m).answer, m, opts);
  const RIGHT = { correct: true, close: false, rightWordWrongForm: false };
  const CLOSE = { correct: false, close: true, rightWordWrongForm: false };
  const WRONG = { correct: false, close: false, rightWordWrongForm: false };
  const FORM = { correct: false, close: false, rightWordWrongForm: true };

  test('the answer, ignoring case, spaces and edge punctuation', () => {
    assert.deepEqual(check('authorized', authority[1]), RIGHT);
    assert.deepEqual(check('  Authorized. ', authority[1]), RIGHT);
    assert.deepEqual(check('came  up with', comeUpWith[0]), RIGHT);
    assert.deepEqual(check('demonstrates', demonstrate[0]), RIGHT);
  });

  test('British spellings from the slash and from -ize/-yze rules', () => {
    assert.deepEqual(check('authorised', authority[1]), RIGHT);
    assert.deepEqual(check('authorisation', authority[2]), RIGHT);
    assert.deepEqual(check('unauthorised', authority[5]), RIGHT);
    // Members written with one spelling only.
    assert.deepEqual(checkFormation('organised', 'organized', { word: 'organize' }), RIGHT);
    assert.deepEqual(checkFormation('organisation', 'organization', { word: 'organization' }), RIGHT);
    assert.deepEqual(checkFormation('realising', 'realizing', { word: 'realize' }), RIGHT);
    assert.deepEqual(checkFormation('analysed', 'analyzed', { word: 'analyze' }), RIGHT);
    assert.deepEqual(checkFormation('colours', 'colours', { word: 'colour / color' }), RIGHT);
    assert.deepEqual(checkFormation('colors', 'colours', { word: 'colour / color' }), RIGHT);
    assert.deepEqual(checkFormation('practised', 'practiced', { word: 'practice / practise' }), RIGHT);
    // Not every "ize" is American spelling.
    assert.notDeepEqual(checkFormation('sise', 'size', { word: 'size' }), RIGHT);
  });

  test('another form of the same word is wrong: the form is the point', () => {
    assert.deepEqual(check('authorize', authority[1]), FORM);
    assert.deepEqual(check('authorizes', authority[1]), FORM);
    assert.deepEqual(check('authorises', authority[1]), FORM);
    assert.deepEqual(check('authorizations', authority[2]), FORM);
    assert.deepEqual(check('decide', decide[0]), FORM);
    assert.deepEqual(check('come up with', comeUpWith[0]), FORM);
    assert.deepEqual(check('decisive', decide[3]), FORM); // the adjective for "decisively"
    assert.deepEqual(check('demonstrable', demonstrate[3]), FORM); // the adjective for "demonstrably"
  });

  test('a slip of 1 letter (up to 5 letters) or 2 letters (longer) is close', () => {
    assert.deepEqual(check('autorized', authority[1]), CLOSE);
    assert.deepEqual(check('autorizd', authority[1]), CLOSE);
    assert.deepEqual(check('autrzed', authority[1]), WRONG);
    assert.deepEqual(check('ablr', able[0]), CLOSE);
    assert.deepEqual(check('abke', able[0]), CLOSE);
    assert.deepEqual(check('xbke', able[0]), WRONG);
    assert.deepEqual(check('decidd', decide[0]), CLOSE);
  });

  test('a negative prefix is never a slip', () => {
    assert.deepEqual(check('unauthorized', authority[1]), WRONG);
    assert.deepEqual(check('able', able[4]), WRONG);
    assert.deepEqual(check('decisive', decide[4]), WRONG);
  });

  test('with the family: another member is named and never close', () => {
    const d = decide;
    assert.deepEqual(check('decisive', d[1]), CLOSE); // without the family: 2 letters off
    assert.deepEqual(check('decisive', d[1], { members: d }), { ...WRONG, otherMember: 2 });
    assert.deepEqual(check('decision', d[2], { members: d }), { ...WRONG, otherMember: 1 });
    assert.deepEqual(check('unauthorized', authority[1], { members: authority }), { ...WRONG, otherMember: 5 });
    assert.deepEqual(check('authority', authority[1], { members: authority }), { ...WRONG, otherMember: 0 });
    assert.deepEqual(check('ably', able[0], { members: able }), { ...FORM, otherMember: 3 });
    assert.deepEqual(check('authorized', authority[1], { members: authority }), { ...RIGHT, otherMember: -1 });
    assert.deepEqual(check('autorized', authority[1], { members: authority }), { ...CLOSE, otherMember: -1 });
    assert.deepEqual(check('xyz', authority[1], { members: authority }), { ...WRONG, otherMember: -1 });
  });

  test('British doubled l is accepted for a word ending in a vowel + l', () => {
    assert.deepEqual(checkFormation('travelled', 'traveled', { word: 'travel' }), RIGHT);
    assert.deepEqual(checkFormation('cancelled', 'canceled', { word: 'cancel' }), RIGHT);
    assert.deepEqual(checkFormation('labelling', 'labeling', { word: 'label' }), RIGHT);
    assert.deepEqual(checkFormation('modelled', 'modeled', { word: 'model' }), RIGHT);
    assert.deepEqual(checkFormation('fuelled', 'fueled', { word: 'fuel' }), RIGHT);
    assert.deepEqual(checkFormation('travellers', 'travelers', { word: 'traveler' }, { members: [{ word: 'travel' }, { word: 'traveler' }] }), { ...RIGHT, otherMember: -1 });
    // Not for silent-e words or vowel pairs.
    assert.notDeepEqual(checkFormation('smilling', 'smiling', { word: 'smile' }), RIGHT);
    assert.notDeepEqual(checkFormation('revealled', 'revealed', { word: 'reveal' }), RIGHT);
    assert.notDeepEqual(checkFormation('travellled', 'travelled', { word: 'travel' }), RIGHT);
    // After "qu" the u is not a vowel: equal → equalled.
    assert.deepEqual(checkFormation('equalled', 'equaled', { word: 'equal' }), RIGHT);
    // A British answer in the sentence also accepts the American spelling.
    assert.deepEqual(checkFormation('traveled', 'travelled', { word: 'travel' }), RIGHT);
    assert.deepEqual(checkFormation('canceling', 'cancelling', { word: 'cancel' }), RIGHT);
  });

  test('a leading "to" or article is left out', () => {
    assert.deepEqual(checkFormation('to authorize', 'authorize', authority[1]), RIGHT);
    assert.deepEqual(checkFormation('the authority', 'authority', authority[0]), RIGHT);
    assert.deepEqual(checkFormation('an ability', 'ability', able[1]), RIGHT);
    assert.deepEqual(check('to authorize', authority[1]), FORM); // the sentence needs "authorized"
    assert.deepEqual(checkFormation('to', 'to', { word: 'to' }), RIGHT);
    assert.deepEqual(checkFormation('a lot', 'a lot', { word: 'a lot' }), RIGHT);
  });

  test('empty input, accents and missing member data', () => {
    assert.deepEqual(check('', authority[1]), WRONG);
    assert.deepEqual(check('   ', authority[1]), WRONG);
    assert.deepEqual(checkFormation('cafe', 'café', { word: 'café' }, { ignoreAccents: true }), RIGHT);
    assert.deepEqual(checkFormation('cafe', 'café', { word: 'café' }), CLOSE);
    assert.deepEqual(checkFormation('decided', 'decided', null), RIGHT);
    assert.deepEqual(checkFormation('decide', 'decided', null), FORM);
    assert.deepEqual(Object.keys(checkFormation('x', 'y', null)).sort(), ['close', 'correct', 'rightWordWrongForm']);
  });
});

// ---------------------------------------------------------------------------

describe('sample word-family list', () => {
  test('the sample texts are the fixtures, and the sample list is ready', async () => {
    const sample = await import('../../js/data/sample.js');
    assert.equal(sample.SAMPLE_FAMILY_ROOTS_TEXT, fixture('family-roots.txt'));
    assert.equal(sample.SAMPLE_FAMILY_ROOTS_REPLY, fixture('family-reply.md'));
    const warn = console.warn;
    console.warn = () => {}; // no IndexedDB in Node: the store falls back to memory
    let list;
    try {
      list = await sample.createSampleWordFamilyList();
    } finally {
      console.warn = warn;
    }
    assert.equal(list.kind, 'family');
    assert.equal(list.title, 'Families 12');
    assert.equal(list.rawText, fixture('family-roots.txt'));
    assert.deepEqual(familyStatus(list), { total: 5, ready: 5, pending: [] });
    assert.deepEqual(list.items.map((i) => i.members.length), [6, 4, 5, 5, 1]);
    assert.equal(list.items[4].note, 'Phrasal verb — it has no word family.');
  });
});

// ---------------------------------------------------------------------------

describe('Edit list keeps the families saved since (mergeItems)', async () => {
  const { mergeItems } = await import('../../js/screens/import.js');
  const writtenText = fixture('family.txt');
  const writtenList = () => {
    const parsed = parseList(writtenText, { kind: 'family' });
    return { id: 'w', kind: 'family', title: 'Written', rawText: writtenText, sentences: [], items: parsed.items.map((item, i) => ({ ...item, id: `w${i + 1}` })) };
  };

  test('written families rebuilt by Claude survive saving the same text again', () => {
    const list = writtenList();
    list.items = applyFamilies(list.items, [{ itemId: 'w1', note: '', members: decideBase.map((m) => ({ ...m })) }]);
    const { items } = mergeItems(list, parseList(writtenText, { kind: 'family' }));
    assert.deepEqual(items.map((i) => [i.id, i.root ?? '', i.members.map((m) => m.word)]), [
      ['w1', 'poorness', ['decide', 'decision']],
      ['w2', '', ['creation', 'creator', 'creativity', 'create', 'creative']],
    ]);
  });

  test('a form removed in the family sheet stays removed; a family whose text changed is read again', () => {
    const list = writtenList();
    list.items[1] = { ...list.items[1], members: list.items[1].members.slice(0, 2) };
    const same = mergeItems(list, parseList(writtenText, { kind: 'family' })).items;
    assert.deepEqual(same.map((i) => i.members.length), [4, 2]);
    const edited = writtenText.replace('5. creative (adjective): having the ability to create\n', '');
    const changed = mergeItems(list, parseList(edited, { kind: 'family' })).items;
    assert.deepEqual(changed.map((i) => [i.id, i.members.length]), [['w1', 4], ['w2', 4]]);
  });

  test('roots read again keep their families', () => {
    const list = { ...readyList(), rawText: fixture('family-roots.txt') };
    const { items } = mergeItems(list, parseList(fixture('family-roots.txt'), { kind: 'family', roots: true }));
    assert.deepEqual(items.map((i) => [i.id, i.members.length]), [['f1', 6], ['f2', 4], ['f3', 5], ['f4', 5], ['f5', 1]]);
  });
});
