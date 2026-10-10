// Practice session engine: builds the card queue for a mode, re-queues wrong
// answers, records first-try outcomes, and on finish updates spaced
// repetition, history and the list's lastPracticedAt.
import { shuffle, uid } from '../../core/util.js';
import { newProgress, practise, dueItems } from '../../core/srs.js';
import { checkFormation, memberBlank, memberForms, modelIndex } from '../../core/families.js';
import * as store from '../../data/store.js';

export const MODES = {
  cloze: { key: 'cloze', label: 'In context', short: 'Fill in the blank', icon: 'blank', color: 'var(--accent)', kinds: ['vocab'] },
  meaning: { key: 'meaning', label: 'Meaning → Word', short: 'Type the English word', icon: 'keyboard', color: 'var(--blue)', kinds: ['vocab'] },
  flashcard: { key: 'flashcard', label: 'Word → Meaning', short: 'Recall, then check yourself', icon: 'cards', color: 'var(--purple)', kinds: ['vocab'] },
  family: { key: 'family', label: 'Word families', short: 'Fill in every form', icon: 'family', color: 'var(--teal)', kinds: ['family'] },
  formation: { key: 'formation', label: 'Word formation', short: 'Use the right form', icon: 'textInput', color: 'var(--purple)', kinds: ['family'] },
  dictation: { key: 'dictation', label: 'Dictation', short: 'Write it from memory', icon: 'headphones', color: 'var(--pink)', kinds: ['passage'] },
  review: { key: 'review', label: 'Review', short: 'Words due today', icon: 'flame', color: 'var(--orange)', kinds: ['vocab'] },
};

export const MAX_RETRIES = 2;
const SNAPSHOT_KEY = 'vs.session';
const SNAPSHOT_TTL = 24 * 60 * 60 * 1000;

// Word families and Word formation practise forms, not the item's own word:
// only these card types update spaced repetition.
const SRS_TYPES = new Set(['cloze', 'meaning', 'flashcard']);

const cardKey = (c) => `${c.type}:${c.itemId}:${c.sentenceId || ''}${typeof c.member === 'number' ? `:${c.member}` : ''}`;

/* ---------- Word formation ---------- */

// The word shown in capitals on a Word formation card: the root the learner
// pasted, else (a family pasted fully written) the model member's first spelling.
export function familyRoot(item) {
  const root = String(item?.root || '').trim();
  if (root) return root;
  const members = item?.members || [];
  return memberForms(members[modelIndex(item)])[0] || '';
}

// Indices of the members that get a Word formation card: the family has 2+
// members, the member's example has a blank, and that blank is not just the
// root itself (typing the word on the card would be no exercise).
export function formationMembers(item) {
  const members = item?.members || [];
  if (members.length < 2) return [];
  const root = familyRoot(item);
  const out = [];
  members.forEach((member, index) => {
    const blank = memberBlank(member);
    if (!blank || !blank.answer.trim()) return;
    if (root && checkFormation(root, blank.answer, member).correct) return;
    out.push(index);
  });
  return out;
}

// The member a formation card asks for: { member, index, blank }, or null
// when it is gone. A card remembers the member's word as well as its index,
// so deleting another member (which shifts the indices) never swaps it.
export function formationTarget(card, item) {
  const members = item?.members || [];
  if (members.length < 2 || typeof card?.member !== 'number') return null;
  let index = card.member;
  if (card.word != null && members[index]?.word !== card.word) index = members.findIndex((m) => m?.word === card.word);
  const member = members[index];
  const blank = member ? memberBlank(member) : null;
  return blank && blank.answer.trim() ? { member, index, blank } : null;
}

// Cards for one list and mode. `itemIds` limits to those items (e.g.
// mistakes); for Word formation, `members` ([{ itemId, word }]) limits to
// those family members.
export function buildCards(list, mode, { itemIds = null, members = null, rng = Math.random } = {}) {
  const keep = (id) => !itemIds || itemIds.includes(id);
  const base = { listId: list.id };
  let cards = [];
  if (mode === 'cloze') {
    // One sentence per (item, sense) per session; pick randomly among extras.
    const bySense = new Map();
    for (const s of list.sentences || []) {
      if (!keep(s.itemId)) continue;
      if (!list.items.some((i) => i.id === s.itemId)) continue;
      const k = `${s.itemId}:${s.sense}`;
      if (!bySense.has(k)) bySense.set(k, []);
      bySense.get(k).push(s);
    }
    for (const group of bySense.values()) {
      const s = group[Math.floor(rng() * group.length)];
      cards.push({ ...base, type: 'cloze', itemId: s.itemId, sentenceId: s.id });
    }
  } else if (mode === 'meaning' || mode === 'flashcard') {
    cards = list.items.filter((i) => keep(i.id)).map((i) => ({ ...base, type: mode, itemId: i.id }));
  } else if (mode === 'family') {
    cards = list.items.filter((i) => keep(i.id) && i.members?.length > 1).map((i) => ({ ...base, type: 'family', itemId: i.id }));
  } else if (mode === 'formation') {
    const wanted = Array.isArray(members) ? members : null;
    for (const item of list.items) {
      if (!keep(item.id)) continue;
      for (const index of formationMembers(item)) {
        const word = item.members[index].word;
        if (wanted && !wanted.some((m) => m.itemId === item.id && m.word === word)) continue;
        cards.push({ ...base, type: 'formation', itemId: item.id, member: index, word });
      }
    }
  } else if (mode === 'dictation') {
    cards = list.items.filter((i) => keep(i.id)).map((i) => ({ ...base, type: 'dictation', itemId: i.id }));
  }
  return shuffle(cards, rng);
}

// Words due today across all vocab lists (overdue first, then new words).
export async function buildReviewCards({ limit = 20, now = Date.now(), rng = Math.random } = {}) {
  const lists = (await store.getLists()).filter((l) => l.kind === 'vocab' && l.items.length);
  const progress = await store.getProgress();
  const all = [];
  for (const list of lists) {
    for (const item of list.items) {
      all.push({ list, item, progress: progress.get(item.id) || newProgress(item.id, list.id) });
    }
  }
  // Words already being learned (missed or due) come before brand-new words,
  // so a big unpractised list never pushes mistakes out of the review.
  const due = dueItems(all.map((x) => x.progress), now);
  const learning = due.filter((p) => progress.has(p.itemId));
  const fresh = due.filter((p) => !progress.has(p.itemId));
  const byId = new Map(all.map((x) => [x.item.id, x]));
  const picked = [...learning, ...fresh].slice(0, limit).map((p) => byId.get(p.itemId)).filter(Boolean);
  const cards = picked.map(({ list, item }) => {
    const sentences = (list.sentences || []).filter((s) => s.itemId === item.id);
    if (sentences.length) {
      const s = sentences[Math.floor(rng() * sentences.length)];
      return { listId: list.id, type: 'cloze', itemId: item.id, sentenceId: s.id };
    }
    return { listId: list.id, type: 'meaning', itemId: item.id };
  });
  return { cards: shuffle(cards, rng), lists, totalDue: due.length };
}

// `lists` / `progress` (Map itemId → Progress) can be passed in when the
// caller has already loaded them.
export async function countDue(now = Date.now(), { lists, progress } = {}) {
  lists = (lists || (await store.getLists())).filter((l) => l.kind === 'vocab');
  progress = progress || (await store.getProgress());
  let due = 0;
  let fresh = 0;
  for (const list of lists) {
    for (const item of list.items) {
      const p = progress.get(item.id);
      if (!p) fresh++;
      else if (p.due <= now) due++;
    }
  }
  return { due, fresh, total: due + fresh };
}

/* ---------- Session state ---------- */

export function createSession({ mode, listId = null, title = '', cards }) {
  return {
    id: uid(),
    mode,
    listId,
    title,
    queue: cards.map((c) => ({ ...c, retry: 0 })),
    originalCount: cards.length,
    index: 0,
    done: 0, // original cards finished (right, or out of retries)
    outcomes: {}, // cardKey -> { itemId, listId, type, first: 'right'|'hinted'|'wrong', score }
    startedAt: Date.now(),
  };
}

export function currentCard(session) {
  return session.queue[session.index] || null;
}

// Records the result of the current card and advances. Returns the session.
export function answer(session, result) {
  const card = currentCard(session);
  if (!card) return session;
  const key = cardKey(card);
  const outcome = result.correct ? (result.hinted ? 'hinted' : 'right') : 'wrong';
  if (!session.outcomes[key]) {
    session.outcomes[key] = {
      itemId: card.itemId,
      listId: card.listId,
      type: card.type,
      first: outcome,
      score: typeof result.score === 'number' ? result.score : result.correct ? 1 : 0,
    };
    // Word formation: which member of the family was missed.
    if (typeof card.member === 'number') Object.assign(session.outcomes[key], { member: card.member, word: card.word ?? null });
  }
  if (!result.correct && card.retry < MAX_RETRIES) {
    session.queue.push({ ...card, retry: card.retry + 1 });
  } else {
    session.done += 1;
  }
  session.index += 1;
  saveSnapshot(session);
  return session;
}

export function isFinished(session) {
  return session.index >= session.queue.length;
}

export function progressFraction(session) {
  return session.originalCount ? session.done / session.originalCount : 0;
}

export function summarize(session) {
  const outcomes = Object.values(session.outcomes);
  const total = outcomes.length;
  const right = outcomes.filter((o) => o.first === 'right').length;
  const hinted = outcomes.filter((o) => o.first === 'hinted').length;
  const wrong = outcomes.filter((o) => o.first === 'wrong');
  const scoreSum = outcomes.reduce((s, o) => s + (o.score ?? 0), 0);
  // One entry per item; Word formation entries also list the missed members
  // ({ member: index, word }), so "Practise mistakes" asks only for those.
  const missed = [];
  for (const o of wrong) {
    let entry = missed.find((m) => m.itemId === o.itemId);
    if (!entry) {
      entry = { itemId: o.itemId, listId: o.listId };
      missed.push(entry);
    }
    if (typeof o.member === 'number') (entry.members ||= []).push({ member: o.member, word: o.word ?? null });
  }
  return {
    sessionId: session.id,
    mode: session.mode,
    listId: session.listId,
    title: session.title,
    total,
    right,
    hinted,
    wrong: wrong.length,
    accuracy: total ? Math.round(((right + hinted) / total) * 100) : 0,
    score: total ? Math.round((scoreSum / total) * 100) : 0,
    missed,
    durationMs: Date.now() - session.startedAt,
  };
}

// Persists spaced repetition (vocab items only), history and lastPracticedAt.
// Answers for lists or items deleted since the session started are skipped,
// so no orphan progress records are written.
export async function commit(session, now = Date.now()) {
  const summary = summarize(session);
  const outcomes = Object.values(session.outcomes);
  const lists = new Map();
  for (const id of new Set(outcomes.map((o) => o.listId).filter(Boolean))) {
    const list = await store.getList(id);
    if (list) lists.set(id, list);
  }
  const exists = (o) => !!lists.get(o.listId)?.items?.some((i) => i.id === o.itemId);
  const perItem = new Map(); // itemId -> worst outcome across its cards
  const rank = { right: 0, hinted: 1, wrong: 2 };
  for (const o of outcomes) {
    if (!SRS_TYPES.has(o.type) || !exists(o)) continue;
    const prev = perItem.get(o.itemId);
    if (!prev || rank[o.first] > rank[prev.first]) perItem.set(o.itemId, o);
  }
  if (perItem.size) {
    const existing = await store.getProgress([...perItem.keys()]);
    const updated = [...perItem.values()].map((o) => practise(existing.get(o.itemId) || newProgress(o.itemId, o.listId), o.first, now));
    await store.saveProgress(updated);
  }
  for (const list of lists.values()) {
    await store.saveList({ ...list, lastPracticedAt: now }, { touch: false });
  }
  if (summary.total) {
    await store.addHistory({ at: now, listId: session.listId, mode: session.mode, total: summary.total, correct: summary.right + summary.hinted });
  }
  clearSnapshot(session.id);
  return summary;
}

/* ---------- Snapshot (resume after iOS closes the app) ---------- */

export function saveSnapshot(session) {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ at: Date.now(), session }));
  } catch {
    /* ignore */
  }
}

// The stored session (finished or not), or null when there is none or it is too old.
function readSnapshot() {
  try {
    const raw = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null');
    if (!raw || Date.now() - raw.at > SNAPSHOT_TTL || !raw.session || !Array.isArray(raw.session.queue)) return null;
    return raw.session;
  } catch {
    return null;
  }
}

// A paused session that can be resumed (not finished), or null.
export function getSnapshot() {
  const session = readSnapshot();
  return session && !isFinished(session) ? session : null;
}

// Without an id: removes the saved session. With an id: only when the saved
// session is that one (closing a new session must not erase a paused one).
export function clearSnapshot(id) {
  try {
    if (id !== undefined && readSnapshot()?.id !== id) return;
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    /* ignore */
  }
}

// Whether a card can still be shown: its list and item exist, and its
// sentence (cloze), its family (2+ members) or its member with a blank
// (Word formation). `lists`: Map<listId, list>.
export function cardResolves(card, lists) {
  const list = lists.get(card.listId);
  const item = list?.items?.find((i) => i.id === card.itemId);
  if (!item) return false;
  if (card.type === 'family') return (item.members?.length ?? 0) > 1;
  if (card.type === 'formation') return !!formationTarget(card, item);
  return !card.sentenceId || !!list.sentences?.some((s) => s.id === card.sentenceId);
}

// The cards still to do that can be shown (lists may have been edited or
// deleted while the session was paused).
export function liveCards(session, lists) {
  return session.queue.slice(session.index).filter((c) => cardResolves(c, lists));
}

const hasOutcomes = (session) => Object.keys(session.outcomes || {}).length > 0;

// Saves `session`'s answers and removes its snapshot. If saving fails the
// snapshot is put back, so the next launch can try again.
async function commitSnapshot(session) {
  clearSnapshot(session.id);
  if (!hasOutcomes(session)) return;
  try {
    await commit(session);
  } catch (err) {
    console.error('Could not save the paused session', err);
    if (!readSnapshot()) saveSnapshot(session);
  }
}

// A saved session that can no longer continue — every card answered (the app
// closed before Continue on the last card, or saving failed), or its
// remaining cards were deleted — is saved and cleared. Runs at launch and
// whenever Today finds such a snapshot.
let recovering = null;
export function recoverSnapshot() {
  if (recovering) return recovering;
  recovering = (async () => {
    const session = readSnapshot();
    if (!session) return false;
    if (!isFinished(session)) {
      const lists = new Map();
      for (const id of new Set(session.queue.map((c) => c.listId))) {
        const list = await store.getList(id);
        if (list) lists.set(id, list);
      }
      if (liveCards(session, lists).length) return false;
    }
    await commitSnapshot(session);
    return true;
  })().finally(() => {
    recovering = null;
  });
  return recovering;
}

// There is one snapshot slot, so the first answer in a new session would
// overwrite a different paused session: save that one's answers first.
// The read is synchronous, so call this before answer() saves the new session.
export function commitPausedSession(currentId) {
  const paused = readSnapshot();
  if (!paused || paused.id === currentId) return null;
  return commitSnapshot(paused);
}
