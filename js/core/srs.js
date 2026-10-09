// Leitner spaced repetition. One Progress record per VocabItem:
// { itemId, listId, box: 0..5, due, seen, right, wrong, last }
// Box 0 = never practised; box 5 = mastered. Pure: `now` is always injected.

import { addDays, clamp, startOfDay } from './util.js';

// Days until the next review, indexed by box.
export const INTERVAL_DAYS = Object.freeze([0, 1, 3, 7, 14, 30]);
export const MAX_BOX = INTERVAL_DAYS.length - 1;

const OUTCOMES = new Set(['right', 'hinted', 'wrong']);

const BOX_LABELS = Object.freeze(['New', 'Learning', 'Learning', 'Reviewing', 'Reviewing', 'Mastered']);

export function newProgress(itemId, listId) {
  return { itemId, listId, box: 0, due: 0, seen: 0, right: 0, wrong: 0, last: null };
}

// Returns a new Progress; the input is never mutated.
export function review(progress, outcome, now) {
  if (!OUTCOMES.has(outcome)) {
    throw new TypeError(`Unknown review outcome: ${String(outcome)} (expected right | hinted | wrong)`);
  }
  if (!Number.isFinite(now)) {
    throw new TypeError(`review() needs a numeric "now" timestamp, got ${String(now)}`);
  }

  const box = toBox(progress.box);
  const next = {
    ...progress,
    seen: count(progress.seen) + 1,
    right: count(progress.right),
    wrong: count(progress.wrong),
    last: now,
  };

  if (outcome === 'right') {
    next.box = Math.min(MAX_BOX, box + 1);
    next.due = midnightAfter(now, INTERVAL_DAYS[next.box]);
    next.right += 1;
  } else if (outcome === 'hinted') {
    next.box = Math.max(1, box);
    next.due = midnightAfter(now, 1);
  } else {
    next.box = 1;
    next.due = now;
    next.wrong += 1;
  }
  return next;
}

// review() for a practice session. Only a word that is due (or new) moves up
// a box: a right answer before the word is due — practising a list in every
// mode on its first day, or the same list again an hour later — counts the
// answer but keeps the box and the next review date. Hinted and wrong
// answers behave exactly like review().
export function practise(progress, outcome, now) {
  const next = review(progress, outcome, now);
  if (outcome !== 'right' || toBox(progress.box) === 0 || isDue(progress, now)) return next;
  return { ...next, box: toBox(progress.box), due: dueOf(progress) };
}

// New items (box 0, due 0) are always due.
export function isDue(progress, now) {
  return dueOf(progress) <= now;
}

// Due records, lowest box first, then the most overdue first.
export function dueItems(progressList, now) {
  return progressList
    .filter((p) => isDue(p, now))
    .sort((a, b) => toBox(a.box) - toBox(b.box) || dueOf(a) - dueOf(b));
}

export function boxLabel(box) {
  return BOX_LABELS[toBox(box)];
}

export function summary(progressList, now) {
  const out = { new: 0, learning: 0, review: 0, mastered: 0, due: 0, total: progressList.length };
  for (const p of progressList) {
    out[bucketOf(toBox(p.box))] += 1;
    if (isDue(p, now)) out.due += 1;
  }
  return out;
}

function bucketOf(box) {
  if (box === 0) return 'new';
  if (box <= 2) return 'learning';
  if (box <= 4) return 'review';
  return 'mastered';
}

// Start of the local calendar day `days` after now's day. Going through
// Date setters (addDays) keeps it on midnight across 23/25-hour DST days.
// Starting from startOfDay(now) avoids carrying now's wall-clock time into a
// DST gap that swallows the end of the target day (Greenland: 23:00 → 00:00
// would push it a day late); the final startOfDay copes with zones where
// midnight itself is skipped (e.g. America/Santiago: 00:00 → 01:00).
function midnightAfter(now, days) {
  return startOfDay(addDays(startOfDay(now), days));
}

// Records come from IndexedDB or an import, so tolerate missing/odd fields.
// ±Infinity clamps like any other out-of-range number; only junk (NaN) is box 0.
function toBox(box) {
  const n = Math.trunc(Number(box));
  return Number.isNaN(n) ? 0 : clamp(n, 0, MAX_BOX);
}

function count(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// Missing/junk due → 0 (due now); +Infinity stays "never due" (due <= now).
function dueOf(progress) {
  const due = Number(progress.due);
  return Number.isNaN(due) ? 0 : due;
}
