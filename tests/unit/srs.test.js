import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as srs from '../../js/core/srs.js';
import * as util from '../../js/core/util.js';

const { INTERVAL_DAYS, MAX_BOX, newProgress, review, isDue, dueItems, boxLabel, summary } = srs;
const { startOfDay } = util;

const SRS_URL = new URL('../../js/core/srs.js', import.meta.url).href;
const UTIL_URL = new URL('../../js/core/util.js', import.meta.url).href;

// Local wall-clock time (month is 1-based), built with the Date constructor
// so every test reads the same in any time zone.
const at = (y, mo, d, h = 9, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

const parts = (ms) => {
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
};

// Same calendar day as `ms`, at hour h (no ms arithmetic across days).
const sameDayAt = (ms, h) => {
  const d = new Date(ms);
  d.setHours(h, 0, 0, 0);
  return d.getTime();
};

const withBox = (box, extra = {}) => ({ ...newProgress('item-1', 'list-1'), box, ...extra });

const deepFreeze = (obj) => {
  for (const value of Object.values(obj)) if (value && typeof value === 'object') deepFreeze(value);
  return Object.freeze(obj);
};

// --- helpers that also run inside child processes (must be self-contained) ---

// Reviews every day of `year` at three times of day from every box, and
// reports reviews whose due date is not the start of the expected calendar day.
function calendarViolations(srs, util, year) {
  const dayIndex = (ms) => {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
  };
  const bad = [];
  for (const day = new Date(year, 0, 1, 12); day.getFullYear() === year; day.setDate(day.getDate() + 1)) {
    for (const [h, mi] of [[0, 5], [12, 0], [23, 55]]) {
      const now = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi).getTime();
      for (let box = 0; box <= srs.MAX_BOX; box++) {
        for (const outcome of ['right', 'hinted']) {
          const r = srs.review({ ...srs.newProgress('i', 'l'), box }, outcome, now);
          const wantDays = outcome === 'right' ? srs.INTERVAL_DAYS[r.box] : 1;
          const gotDays = dayIndex(r.due) - dayIndex(now);
          if (gotDays !== wantDays || r.due !== util.startOfDay(r.due) || r.due <= now) {
            bad.push({ now: new Date(now).toString(), box, outcome, due: new Date(r.due).toString(), gotDays, wantDays });
          }
        }
      }
    }
  }
  return bad;
}

// cases: [{ now: [y, mo, d, h, mi], box, outcome }] → what review() produced.
function evaluateCases(srs, util, cases) {
  return cases.map(({ now: [y, mo, d, h, mi], box, outcome }) => {
    const nowMs = new Date(y, mo - 1, d, h, mi).getTime();
    const r = srs.review({ ...srs.newProgress('i', 'l'), box }, outcome, nowMs);
    const due = new Date(r.due);
    return {
      box: r.box,
      due: [due.getFullYear(), due.getMonth() + 1, due.getDate(), due.getHours(), due.getMinutes()],
      iso: due.toISOString(),
      hoursAfterStartOfDay: (r.due - util.startOfDay(nowMs)) / 3600000,
    };
  });
}

// ICU may report an alias (Asia/Ho_Chi_Minh → Asia/Saigon), so compare canonical names.
const canonicalZone = (timeZone) => new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;

function runInZone(timeZone, cases = []) {
  const script = `
    const srs = await import(${JSON.stringify(SRS_URL)});
    const util = await import(${JSON.stringify(UTIL_URL)});
    ${calendarViolations.toString()}
    ${evaluateCases.toString()}
    const cases = JSON.parse(process.env.SRS_CASES);
    console.log(JSON.stringify({
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      violations: calendarViolations(srs, util, 2026),
      cases: evaluateCases(srs, util, cases),
    }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: timeZone, SRS_CASES: JSON.stringify(cases) },
    encoding: 'utf8',
    timeout: 30000,
  });
  return JSON.parse(out);
}

// --------------------------------------------------------------------------

describe('constants', () => {
  test('Leitner intervals per box', () => {
    assert.deepEqual([...INTERVAL_DAYS], [0, 1, 3, 7, 14, 30]);
    assert.equal(MAX_BOX, 5);
    assert.ok(Object.isFrozen(INTERVAL_DAYS));
  });
});

describe('newProgress', () => {
  test('starts in box 0, due immediately, no history', () => {
    assert.deepEqual(newProgress('a1', 'l1'), {
      itemId: 'a1', listId: 'l1', box: 0, due: 0, seen: 0, right: 0, wrong: 0, last: null,
    });
  });

  test('a new item is due at any time', () => {
    const p = newProgress('a1', 'l1');
    assert.equal(isDue(p, 0), true);
    assert.equal(isDue(p, at(2026, 10, 8)), true);
  });

  test('returns a fresh object each call', () => {
    assert.notEqual(newProgress('a', 'l'), newProgress('a', 'l'));
  });
});

describe('review: right', () => {
  test('box 0 → 1, due at midnight of the next calendar day', () => {
    const now = at(2026, 10, 8, 21, 30);
    const p = review(newProgress('a1', 'l1'), 'right', now);
    assert.equal(p.box, 1);
    assert.deepEqual(parts(p.due), [2026, 10, 9, 0, 0]);
    assert.equal(p.seen, 1);
    assert.equal(p.right, 1);
    assert.equal(p.wrong, 0);
    assert.equal(p.last, now);
    assert.equal(p.itemId, 'a1');
    assert.equal(p.listId, 'l1');
  });

  test('progression over simulated days climbs one box per success', () => {
    let p = newProgress('a1', 'l1');
    let now = at(2026, 1, 5, 9);
    const startDay = startOfDay(now);
    const elapsed = [];

    for (let box = 1; box <= MAX_BOX; box++) {
      assert.equal(isDue(p, now), true, `due before reaching box ${box}`);
      p = review(p, 'right', now);
      assert.equal(p.box, box);
      assert.equal(p.due, startOfDay(p.due), 'due is the start of a day');
      assert.equal(isDue(p, now), false, 'not due right after a correct answer');
      assert.equal(isDue(p, p.due - 1), false, 'not due a moment before the due time');
      assert.equal(isDue(p, p.due), true, 'due exactly at the due time');

      const expected = new Date(now);
      expected.setDate(expected.getDate() + INTERVAL_DAYS[box]);
      assert.deepEqual(parts(p.due), [...parts(expected).slice(0, 3), 0, 0]);

      elapsed.push(INTERVAL_DAYS[box]);
      now = sameDayAt(p.due, 9); // come back on the due day, mid-morning
    }

    assert.deepEqual(elapsed, [1, 3, 7, 14, 30]);
    assert.equal(p.seen, 5);
    assert.equal(p.right, 5);
    assert.equal(boxLabel(p.box), 'Mastered');
    // 55 calendar days after the start: 5 Jan + 55 days = 1 Mar.
    const finalDay = new Date(startDay);
    finalDay.setDate(finalDay.getDate() + 55);
    assert.equal(p.due, startOfDay(finalDay.getTime()));
    assert.deepEqual(parts(p.due), [2026, 3, 1, 0, 0]);
  });

  test('box 5 stays 5 and is rescheduled 30 days out', () => {
    const now = at(2026, 4, 1, 18);
    const p = review(withBox(5), 'right', now);
    assert.equal(p.box, 5);
    assert.deepEqual(parts(p.due), [2026, 5, 1, 0, 0]);
  });
});

describe('review: wrong', () => {
  test('drops any box back to 1 and is due again immediately', () => {
    const now = at(2026, 10, 8, 14);
    for (const box of [0, 1, 2, 3, 4, 5]) {
      const p = review(withBox(box, { right: 4, wrong: 1, seen: 5 }), 'wrong', now);
      assert.equal(p.box, 1, `from box ${box}`);
      assert.equal(p.due, now);
      assert.equal(isDue(p, now), true);
      assert.equal(p.wrong, 2);
      assert.equal(p.right, 4);
      assert.equal(p.seen, 6);
      assert.equal(p.last, now);
    }
  });

  test('a mastered word that is missed has to climb again', () => {
    const day1 = at(2026, 6, 1, 8);
    let p = review(withBox(5), 'wrong', day1);
    p = review(p, 'right', sameDayAt(day1, 20));
    assert.equal(p.box, 2);
    assert.deepEqual(parts(p.due), [2026, 6, 4, 0, 0]);
  });
});

describe('review: hinted', () => {
  test('keeps the box and comes back tomorrow', () => {
    const now = at(2026, 10, 8, 23, 59);
    for (const box of [1, 2, 3, 4, 5]) {
      const p = review(withBox(box), 'hinted', now);
      assert.equal(p.box, box);
      assert.deepEqual(parts(p.due), [2026, 10, 9, 0, 0]);
    }
  });

  test('a new word moves to box 1 (never stays "New" once seen)', () => {
    const p = review(newProgress('a', 'l'), 'hinted', at(2026, 10, 8));
    assert.equal(p.box, 1);
    assert.equal(boxLabel(p.box), 'Learning');
  });

  test('counts as seen but neither right nor wrong', () => {
    const now = at(2026, 10, 8);
    const p = review(withBox(3, { seen: 7, right: 5, wrong: 2 }), 'hinted', now);
    assert.equal(p.seen, 8);
    assert.equal(p.right, 5);
    assert.equal(p.wrong, 2);
    assert.equal(p.last, now);
  });
});

describe('review: immutability and robustness', () => {
  test('never mutates the input and keeps unknown fields', () => {
    const input = deepFreeze(withBox(2, { seen: 3, right: 2, wrong: 1, last: at(2026, 10, 1), note: 'x' }));
    const snapshot = structuredClone(input);
    for (const outcome of ['right', 'hinted', 'wrong']) {
      const out = review(input, outcome, at(2026, 10, 8));
      assert.notEqual(out, input);
      assert.equal(out.note, 'x');
    }
    assert.deepEqual(input, snapshot);
  });

  test('chained reviews do not share state', () => {
    const a = newProgress('a', 'l');
    const b = review(a, 'right', at(2026, 10, 8));
    const c = review(b, 'right', at(2026, 10, 9));
    assert.equal(a.box, 0);
    assert.equal(b.box, 1);
    assert.equal(c.box, 2);
  });

  test('unknown outcome throws TypeError', () => {
    for (const outcome of ['correct', 'RIGHT', '', undefined, null, true]) {
      assert.throws(() => review(newProgress('a', 'l'), outcome, at(2026, 10, 8)), TypeError);
    }
  });

  test('a missing or non-numeric now throws TypeError', () => {
    for (const now of [undefined, null, NaN, '2026-10-08', new Date()]) {
      assert.throws(() => review(newProgress('a', 'l'), 'right', now), TypeError);
    }
  });

  test('tolerates stored records with missing counters or odd boxes', () => {
    const now = at(2026, 10, 8);
    const sparse = review({ itemId: 'a', listId: 'l' }, 'right', now);
    assert.equal(sparse.box, 1);
    assert.equal(sparse.seen, 1);
    assert.equal(sparse.right, 1);
    assert.equal(sparse.wrong, 0);

    assert.equal(review(withBox(9), 'right', now).box, 5);
    assert.equal(review(withBox(-2), 'right', now).box, 1);
    assert.equal(review(withBox('3'), 'right', now).box, 4);
    assert.equal(review(withBox('junk'), 'hinted', now).box, 1);
  });
});

describe('isDue', () => {
  test('due when due <= now (inclusive)', () => {
    const due = at(2026, 10, 9, 0);
    const p = withBox(2, { due });
    assert.equal(isDue(p, due - 1), false);
    assert.equal(isDue(p, due), true);
    assert.equal(isDue(p, due + 1), true);
  });

  test('a record without a due time counts as due', () => {
    assert.equal(isDue({ itemId: 'a', box: 0 }, at(2026, 10, 8)), true);
  });
});

describe('dueItems', () => {
  const now = at(2026, 10, 8, 12);
  const list = [
    { ...withBox(3, { due: at(2026, 10, 1, 0) }), itemId: 'r-old' },
    { ...withBox(1, { due: at(2026, 10, 8, 11) }), itemId: 'l1-recent' },
    { ...withBox(2, { due: at(2026, 10, 20, 0) }), itemId: 'future' },
    { ...withBox(0), itemId: 'new-a' },
    { ...withBox(1, { due: at(2026, 10, 5, 0) }), itemId: 'l1-old' },
    { ...withBox(5, { due: at(2026, 10, 8, 0) }), itemId: 'mastered' },
    { ...withBox(0), itemId: 'new-b' },
    { ...withBox(3, { due: at(2026, 10, 8, 12) }), itemId: 'r-now' },
  ];

  test('keeps only due records, lowest box first, then most overdue', () => {
    assert.deepEqual(dueItems(list, now).map((p) => p.itemId), [
      'new-a', 'new-b', 'l1-old', 'l1-recent', 'r-old', 'r-now', 'mastered',
    ]);
  });

  test('does not reorder or mutate the input array', () => {
    const before = list.map((p) => p.itemId);
    dueItems(list, now);
    assert.deepEqual(list.map((p) => p.itemId), before);
  });

  test('nothing due → empty array', () => {
    assert.deepEqual(dueItems([], now), []);
    assert.deepEqual(dueItems([withBox(2, { due: now + 1 })], now), []);
  });
});

describe('boxLabel', () => {
  test('labels every box', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(boxLabel),
      ['New', 'Learning', 'Learning', 'Reviewing', 'Reviewing', 'Mastered']);
  });

  test('out-of-range values are clamped', () => {
    assert.equal(boxLabel(7), 'Mastered');
    assert.equal(boxLabel(-1), 'New');
    assert.equal(boxLabel(undefined), 'New');
  });
});

describe('summary', () => {
  test('counts buckets, due and total', () => {
    const now = at(2026, 10, 8, 12);
    const list = [
      withBox(0),
      withBox(0),
      withBox(1, { due: now - 1 }),
      withBox(2, { due: now + 1 }),
      withBox(3, { due: now }),
      withBox(4, { due: now + 1 }),
      withBox(5, { due: now + 1 }),
    ];
    assert.deepEqual(summary(list, now), {
      new: 2, learning: 2, review: 2, mastered: 1, due: 4, total: 7,
    });
  });

  test('empty list', () => {
    assert.deepEqual(summary([], 0), { new: 0, learning: 0, review: 0, mastered: 0, due: 0, total: 0 });
  });
});

describe('calendar-day math (in whatever time zone this process uses)', () => {
  test('every review of 2026 lands at the start of the right calendar day', () => {
    const bad = calendarViolations(srs, util, 2026);
    assert.deepEqual(bad.slice(0, 5), [], `${bad.length} violations`);
  });

  test('a review just before midnight is due at the next midnight', () => {
    const [p] = evaluateCases(srs, util, [{ now: [2026, 12, 31, 23, 59], box: 0, outcome: 'right' }]);
    assert.deepEqual(p.due, [2027, 1, 1, 0, 0]);
  });
});

describe('time zones (child processes with TZ set)', () => {
  test('Asia/Ho_Chi_Minh: days follow local midnight, not UTC', () => {
    const r = runInZone('Asia/Ho_Chi_Minh', [
      { now: [2026, 10, 8, 23, 30], box: 0, outcome: 'right' },  // 16:30Z
      { now: [2026, 10, 9, 0, 10], box: 0, outcome: 'hinted' },  // 17:10Z on the 8th
    ]);
    assert.equal(r.zone, canonicalZone('Asia/Ho_Chi_Minh'));
    assert.deepEqual(r.violations.slice(0, 5), []);
    assert.deepEqual(r.cases[0].due, [2026, 10, 9, 0, 0]);
    assert.equal(r.cases[0].iso, '2026-10-08T17:00:00.000Z');
    assert.deepEqual(r.cases[1].due, [2026, 10, 10, 0, 0]);
    assert.equal(r.cases[1].iso, '2026-10-09T17:00:00.000Z');
  });

  test('America/New_York: 23- and 25-hour days still land on midnight', () => {
    const r = runInZone('America/New_York', [
      { now: [2026, 10, 31, 15, 0], box: 1, outcome: 'right' },  // across fall-back (1 Nov)
      { now: [2026, 3, 7, 20, 0], box: 1, outcome: 'right' },    // across spring-forward (8 Mar)
      { now: [2026, 11, 1, 10, 0], box: 3, outcome: 'hinted' },  // on the 25-hour day
    ]);
    assert.equal(r.zone, canonicalZone('America/New_York'));
    assert.deepEqual(r.violations.slice(0, 5), []);

    const [fallBack, springForward, hinted] = r.cases;
    assert.equal(fallBack.box, 2);
    assert.deepEqual(fallBack.due, [2026, 11, 3, 0, 0]);
    assert.equal(fallBack.hoursAfterStartOfDay, 73); // naive 3 * 24h would give 2 Nov 23:00
    assert.equal(springForward.box, 2);
    assert.deepEqual(springForward.due, [2026, 3, 10, 0, 0]);
    assert.equal(springForward.hoursAfterStartOfDay, 71);
    assert.deepEqual(hinted.due, [2026, 11, 2, 0, 0]);
    assert.equal(hinted.hoursAfterStartOfDay, 25);
  });

  test('zones with skipped midnights or 30-minute DST shifts', () => {
    for (const zone of ['America/Santiago', 'Australia/Lord_Howe', 'UTC']) {
      const r = runInZone(zone);
      assert.equal(r.zone, canonicalZone(zone));
      assert.deepEqual(r.violations.slice(0, 5), [], `${zone}: ${r.violations.length} violations`);
    }
  });
});

describe('practise() — reviews from a practice session', () => {
  const { practise } = srs;

  test('a new word moves to box 1 like review()', () => {
    const now = at(2026, 10, 8, 9);
    assert.deepEqual(practise(newProgress('a', 'l'), 'right', now), review(newProgress('a', 'l'), 'right', now));
  });

  test('five right answers on the first day leave the word in box 1, due tomorrow', () => {
    const day1 = at(2026, 10, 8, 9);
    let p = newProgress('a', 'l');
    for (let i = 0; i < 5; i++) p = practise(p, 'right', day1 + i * 10 * 60000);
    assert.equal(p.box, 1);
    assert.deepEqual(parts(p.due), [2026, 10, 9, 0, 0]);
    assert.equal(p.seen, 5);
    assert.equal(p.right, 5);
    assert.equal(p.last, day1 + 40 * 60000);
  });

  test('a due word is promoted; practising it again before the next due date is not', () => {
    const due = withBox(2, { due: at(2026, 10, 8, 0), seen: 2, right: 2, last: at(2026, 10, 5) });
    const p = practise(due, 'right', at(2026, 10, 8, 9));
    assert.equal(p.box, 3);
    assert.deepEqual(parts(p.due), [2026, 10, 15, 0, 0]);
    const again = practise(p, 'right', at(2026, 10, 9, 9));
    assert.equal(again.box, 3);
    assert.equal(again.due, p.due);
    assert.equal(again.right, 4);
  });

  test('hinted and wrong answers are the same as review(), due or not', () => {
    const early = withBox(4, { due: at(2026, 10, 20, 0) });
    const now = at(2026, 10, 8, 9);
    for (const outcome of ['hinted', 'wrong']) assert.deepEqual(practise(early, outcome, now), review(early, outcome, now));
  });

  test('a missed word answered right later the same day still climbs (Leitner rule)', () => {
    const now = at(2026, 10, 8, 9);
    const p = practise(practise(withBox(4), 'wrong', now), 'right', now + 60000);
    assert.equal(p.box, 2);
  });
});
