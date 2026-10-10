// Practice sessions for family lists: Word formation cards, dead-card checks,
// missed members (js/screens/practice/session.js; docs/architecture.md →
// "Word families from Claude" → Practice).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyFamilies, parseFamilyReply } from '../../js/core/families.js';
import { parseList } from '../../js/core/parse.js';
import {
  MODES, answer, buildCards, cardResolves, createSession, familyRoot, formationMembers, formationTarget, liveCards, summarize,
} from '../../js/screens/practice/session.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

// tests/fixtures/family-roots.txt with Claude's families saved, ids f1..f5.
function readyList() {
  const parsed = parseList(fixture('family-roots.txt'), { kind: 'family', roots: true });
  const list = {
    id: 'L', kind: 'family', title: parsed.title, source: '', rawText: '', sentences: [],
    items: parsed.items.map((item, i) => ({ ...item, id: `f${i + 1}` })),
    createdAt: 0, updatedAt: 0, lastPracticedAt: null,
  };
  list.items = applyFamilies(list.items, parseFamilyReply(fixture('family-reply.md'), list).families);
  return list;
}

// A family pasted fully written (no root, examples without brackets).
function writtenList() {
  const text = [
    '1. poorness (noun) /ˈpʊrnəs/: the state of being poor',
    "Example: The family's poorness became evident.",
    '2. impoverish (verb) /ɪmˈpɑvərɪʃ/: to make poor',
    'Example: The crisis threatened to impoverish many families.',
    '3. poor (adjective) /pʊr/: having little money',
    'Example: The poor community struggled.',
  ].join('\n');
  const parsed = parseList(text, { kind: 'family' });
  return { id: 'W', kind: 'family', title: 'W', items: parsed.items.map((item, i) => ({ ...item, id: `w${i + 1}` })), sentences: [] };
}

const noShuffle = () => 0.999;
const clone = (x) => JSON.parse(JSON.stringify(x));

describe('MODES.formation', () => {
  test('is a family-list mode with its own colour and icon', () => {
    assert.deepEqual(
      { ...MODES.formation },
      { key: 'formation', label: 'Word formation', short: 'Use the right form', icon: 'textInput', color: 'var(--purple)', kinds: ['family'] },
    );
    assert.notEqual(MODES.formation.color, MODES.family.color);
  });
});

describe('familyRoot', () => {
  test('the pasted root, else the model member\'s first spelling', () => {
    const list = readyList();
    assert.equal(familyRoot(list.items[0]), 'authority');
    assert.equal(familyRoot(writtenList().items[0]), 'poorness');
    assert.equal(familyRoot({ root: '', members: [{ word: 'colour / color' }, { word: 'colourful' }] }), 'colour');
    assert.equal(familyRoot({ members: [] }), '');
  });
});

describe('formationMembers', () => {
  test('skips the member whose blank is just the root, and families under 2 members', () => {
    const list = readyList();
    const words = list.items.map((item) => formationMembers(item).map((i) => item.members[i].word));
    assert.deepEqual(words[0], ['authorize / authorise', 'authorization / authorisation', 'authoritative', 'authoritatively', 'unauthorized / unauthorised']);
    // "demonstrates" and "decided" are other forms of the root: kept.
    assert.ok(words[1].includes('demonstrate'));
    assert.ok(words[3].includes('decide'));
    // "able" for ABLE is no exercise.
    assert.ok(!words[2].includes('able'));
    assert.deepEqual(words[4], []); // "come up with": one member + note
  });

  test('a written-out family: blanks found in the examples, the model is skipped', () => {
    const item = writtenList().items[0];
    assert.deepEqual(formationMembers(item).map((i) => item.members[i].word), ['impoverish', 'poor']);
  });

  test('members without an example, or with no blank, get no card', () => {
    const item = { root: 'create', members: [{ word: 'create', example: '' }, { word: 'creator', example: 'No such word here.' }, { word: 'creative', example: 'A [[creative]] idea.' }] };
    assert.deepEqual(formationMembers(item), [2]);
    assert.deepEqual(formationMembers({ root: 'x', members: [] }), []);
    assert.deepEqual(formationMembers(null), []);
  });
});

describe('buildCards(list, "formation")', () => {
  test('one card per member with a blank, remembering index and word', () => {
    const list = readyList();
    const cards = buildCards(list, 'formation', { rng: noShuffle });
    assert.equal(cards.length, 18);
    for (const c of cards) {
      assert.equal(c.type, 'formation');
      assert.equal(c.listId, 'L');
      const item = list.items.find((i) => i.id === c.itemId);
      assert.equal(item.members[c.member].word, c.word);
    }
    assert.ok(!cards.some((c) => c.itemId === 'f5'));
  });

  test('itemIds and members limit the cards', () => {
    const list = readyList();
    assert.equal(buildCards(list, 'formation', { itemIds: ['f1'] }).length, 5);
    const only = buildCards(list, 'formation', { members: [{ itemId: 'f1', word: 'authoritative' }, { itemId: 'f4', word: 'decisive' }] });
    assert.deepEqual(only.map((c) => c.word).sort(), ['authoritative', 'decisive']);
    assert.equal(buildCards(list, 'formation', { members: [] }).length, 0);
  });

  test('pending families (no members yet) give no cards in either family mode', () => {
    const parsed = parseList(fixture('family-roots.txt'), { kind: 'family', roots: true });
    const list = { id: 'P', kind: 'family', items: parsed.items, sentences: [] };
    assert.equal(buildCards(list, 'formation').length, 0);
    assert.equal(buildCards(list, 'family').length, 0);
  });
});

describe('formationTarget / cardResolves / liveCards', () => {
  test('finds the member by word when another member was deleted (indices shift)', () => {
    const list = readyList();
    const cards = buildCards(list, 'formation', { itemIds: ['f1'], rng: noShuffle });
    const card = cards.find((c) => c.word === 'authoritative'); // index 3
    const item = clone(list.items[0]);
    item.members.splice(1, 1); // delete "authorize"
    const target = formationTarget(card, item);
    assert.equal(target.member.word, 'authoritative');
    assert.equal(target.index, 2);
    assert.equal(target.blank.answer, 'authoritative');
  });

  test('dead when the member, its blank or the family is gone', () => {
    const list = readyList();
    const card = buildCards(list, 'formation', { itemIds: ['f1'] }).find((c) => c.word === 'authoritative');
    const lists = (items) => new Map([['L', { ...list, items }]]);
    assert.ok(cardResolves(card, lists(list.items)));
    const without = clone(list.items);
    without[0].members = without[0].members.filter((m) => m.word !== 'authoritative');
    assert.ok(!cardResolves(card, lists(without)));
    const noExample = clone(list.items);
    noExample[0].members.find((m) => m.word === 'authoritative').example = '';
    assert.ok(!cardResolves(card, lists(noExample)));
    const single = clone(list.items);
    single[0].members = single[0].members.filter((m) => m.word === 'authoritative');
    assert.ok(!cardResolves(card, lists(single)));
    assert.ok(!cardResolves(card, lists(list.items.slice(1))));
    assert.ok(!cardResolves(card, new Map()));
  });

  test('a card without a word (older snapshot) uses its index', () => {
    const list = readyList();
    const card = { type: 'formation', listId: 'L', itemId: 'f1', member: 2 };
    assert.equal(formationTarget(card, list.items[0]).member.word, 'authorization / authorisation');
  });

  test('a Word families card is dead once its family has fewer than 2 members', () => {
    const list = readyList();
    const card = { type: 'family', listId: 'L', itemId: 'f2' };
    assert.ok(cardResolves(card, new Map([['L', list]])));
    const items = clone(list.items);
    items[1].members = items[1].members.slice(0, 1);
    assert.ok(!cardResolves(card, new Map([['L', { ...list, items }]])));
  });

  test('liveCards skips the deleted member and keeps the shifted ones', () => {
    const list = readyList();
    const session = createSession({ mode: 'formation', listId: 'L', title: 'T', cards: buildCards(list, 'formation', { itemIds: ['f1'], rng: noShuffle }) });
    const items = clone(list.items);
    items[0].members = items[0].members.filter((m) => m.word !== 'authorize / authorise');
    const live = liveCards(session, new Map([['L', { ...list, items }]]));
    assert.deepEqual(live.map((c) => c.word), ['authorization / authorisation', 'authoritative', 'authoritatively', 'unauthorized / unauthorised']);
  });
});

describe('answers and summary', () => {
  test('each member is its own outcome; missed lists the members per family', () => {
    const list = readyList();
    const cards = buildCards(list, 'formation', { itemIds: ['f1', 'f4'], rng: noShuffle });
    const session = createSession({ mode: 'formation', listId: 'L', title: 'T', cards });
    const wrongWords = new Set(['authoritative', 'decisive', 'indecisive']);
    for (const card of cards) {
      answer(session, { correct: !wrongWords.has(card.word) });
    }
    const summary = summarize(session);
    assert.equal(summary.total, cards.length);
    assert.equal(summary.wrong, 3);
    const byItem = Object.fromEntries(summary.missed.map((m) => [m.itemId, m.members.map((x) => x.word).sort()]));
    assert.deepEqual(byItem, { f1: ['authoritative'], f4: ['decisive', 'indecisive'] });
    for (const m of summary.missed) for (const x of m.members) assert.equal(typeof x.member, 'number');
  });

  test('a re-asked card keeps its first outcome', () => {
    const list = readyList();
    const cards = buildCards(list, 'formation', { itemIds: ['f2'] });
    const session = createSession({ mode: 'formation', listId: 'L', title: 'T', cards: cards.slice(0, 1) });
    answer(session, { correct: false });
    answer(session, { correct: true });
    const summary = summarize(session);
    assert.equal(summary.total, 1);
    assert.equal(summary.wrong, 1);
    assert.equal(session.done, 1);
  });

  test('other modes keep their summary shape (no members)', () => {
    const session = createSession({ mode: 'family', listId: 'L', title: 'T', cards: [{ type: 'family', listId: 'L', itemId: 'f1' }] });
    answer(session, { correct: false, score: 0.5 });
    assert.deepEqual(summarize(session).missed, [{ itemId: 'f1', listId: 'L' }]);
  });
});
