// Practice session engine: builds the card queue for a mode, re-queues wrong
// answers, records first-try outcomes, and on finish updates spaced
// repetition, history and the list's lastPracticedAt.
import { shuffle, uid } from '../../core/util.js';
import { newProgress, practise, dueItems } from '../../core/srs.js';
import * as store from '../../data/store.js';

export const MODES = {
  cloze: { key: 'cloze', label: 'In context', short: 'Fill in the blank', icon: 'blank', color: 'var(--accent)', kinds: ['vocab'] },
  meaning: { key: 'meaning', label: 'Meaning → Word', short: 'Type the English word', icon: 'keyboard', color: 'var(--blue)', kinds: ['vocab'] },
  flashcard: { key: 'flashcard', label: 'Word → Meaning', short: 'Recall, then check yourself', icon: 'cards', color: 'var(--purple)', kinds: ['vocab'] },
  family: { key: 'family', label: 'Word families', short: 'Fill in every form', icon: 'family', color: 'var(--teal)', kinds: ['family'] },
  dictation: { key: 'dictation', label: 'Dictation', short: 'Write it from memory', icon: 'headphones', color: 'var(--pink)', kinds: ['passage'] },
  review: { key: 'review', label: 'Review', short: 'Words due today', icon: 'flame', color: 'var(--orange)', kinds: ['vocab'] },
};

export const MAX_RETRIES = 2;
const SNAPSHOT_KEY = 'vs.session';
const SNAPSHOT_TTL = 24 * 60 * 60 * 1000;

const cardKey = (c) => `${c.type}:${c.itemId}:${c.sentenceId || ''}`;

// Cards for one list and mode. `itemIds` limits to those items (e.g. mistakes).
export function buildCards(list, mode, { itemIds = null, rng = Math.random } = {}) {
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
  const missed = [];
  for (const o of wrong) if (!missed.some((m) => m.itemId === o.itemId)) missed.push({ itemId: o.itemId, listId: o.listId });
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
    if (o.type === 'family' || o.type === 'dictation' || !exists(o)) continue;
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

// Whether a card's list, item and (for cloze) sentence still exist.
// `lists`: Map<listId, list>.
export function cardResolves(card, lists) {
  const list = lists.get(card.listId);
  if (!list || !list.items?.some((i) => i.id === card.itemId)) return false;
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
