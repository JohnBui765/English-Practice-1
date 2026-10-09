// Adversarial tests for js/core/srs.js: odd stored records, look-alike
// outcomes, day boundaries in unusual time zones, invariants under a long
// simulated study period, and speed on large progress lists.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as srs from '../../js/core/srs.js';
import * as util from '../../js/core/util.js';

const { INTERVAL_DAYS, MAX_BOX, newProgress, review, isDue, dueItems, boxLabel, summary } = srs;
const { startOfDay } = util;

const SRS_URL = new URL('../../js/core/srs.js', import.meta.url).href;
const UTIL_URL = new URL('../../js/core/util.js', import.meta.url).href;
const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

// Local wall-clock time (month is 1-based).
const at = (y, mo, d, h = 9, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms).getTime();
const ymdhm = (ms) => {
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
};
const withBox = (box, extra = {}) => ({ ...newProgress('item-1', 'list-1'), box, ...extra });

const deepFreeze = (obj) => {
  for (const value of Object.values(obj)) if (value && typeof value === 'object') deepFreeze(value);
  return Object.freeze(obj);
};

// Small seeded PRNG so the simulations are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Words of the user's real list format (numbered one-line entries).
const listWords = fixture('list-378.txt')
  .split(/\r?\n/)
  .map((line) => line.match(/^\s*\d+[.)]\s+([^(:/]+?)\s*(?:\(|\/|:)/))
  .filter(Boolean)
  .map((m) => m[1]);

// ---------------------------------------------------------------------------
// Runs inside ONE child process: switches process.env.TZ per zone (Node
// re-reads it at runtime) and reviews every day of `year` at awkward times.
// Must be self-contained because it is stringified into the child.
function sweepZones(srs, util, zones, year) {
  const dayIndex = (ms) => {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
  };
  const times = [[0, 0], [0, 30], [1, 0], [12, 0], [22, 59], [23, 0], [23, 30], [23, 59]];
  return zones.map((zone) => {
    process.env.TZ = zone;
    const bad = [];
    for (const day = new Date(year, 0, 1, 12); day.getFullYear() === year; day.setDate(day.getDate() + 1)) {
      for (const [h, mi] of times) {
        const now = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi).getTime();
        for (let box = 0; box <= srs.MAX_BOX; box++) {
          for (const outcome of ['right', 'hinted']) {
            const r = srs.review({ ...srs.newProgress('i', 'l'), box }, outcome, now);
            const wantDays = outcome === 'right' ? srs.INTERVAL_DAYS[r.box] : 1;
            const gotDays = dayIndex(r.due) - dayIndex(now);
            const firstInstant = r.due === util.startOfDay(r.due) && dayIndex(r.due - 1) !== dayIndex(r.due);
            if (gotDays !== wantDays || !firstInstant || r.due <= now) {
              bad.push(`${new Date(now).toString()} box ${box} ${outcome} → ${new Date(r.due).toString()} (+${gotDays}d, want +${wantDays}d)`);
            }
          }
        }
      }
    }
    return { zone, resolved: Intl.DateTimeFormat().resolvedOptions().timeZone, count: bad.length, examples: bad.slice(0, 3) };
  });
}

// cases: [{ now: [y, mo, d, h, mi], box, outcome }] → local [y, mo, d, h, mi] of the due time.
function dueParts(srs, cases) {
  return cases.map(({ now: [y, mo, d, h, mi], box, outcome }) => {
    const r = srs.review({ ...srs.newProgress('i', 'l'), box }, outcome, new Date(y, mo - 1, d, h, mi).getTime());
    const due = new Date(r.due);
    return [due.getFullYear(), due.getMonth() + 1, due.getDate(), due.getHours(), due.getMinutes()];
  });
}

function runChild(env, body) {
  const script = `
    const srs = await import(${JSON.stringify(SRS_URL)});
    const util = await import(${JSON.stringify(UTIL_URL)});
    ${sweepZones.toString()}
    ${dueParts.toString()}
    const input = JSON.parse(process.env.SRS_INPUT);
    console.log(JSON.stringify(${body}));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60000,
  });
  return JSON.parse(out);
}

// ICU may report an alias (America/Nuuk → America/Godthab), so compare canonical names.
const canonicalZone = (timeZone) => new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;

// ---------------------------------------------------------------------------

describe('time zones whose spring-forward gap swallows the last hour of the day', () => {
  // Greenland (America/Nuuk, America/Scoresbysund) has been UTC-2 with EU DST
  // rules since 2024: on Sat 28 Mar 2026 the clock jumps 23:00 → 00:00, so
  // 23:00–23:59 of that Saturday does not exist. Carrying `now`'s wall-clock
  // time to the target day before taking startOfDay lands on the next day.
  const cases = [
    { now: [2026, 3, 27, 23, 30], box: 0, outcome: 'right' },  // +1 day
    { now: [2026, 3, 27, 23, 0], box: 3, outcome: 'hinted' },  // +1 day
    { now: [2026, 3, 25, 23, 15], box: 1, outcome: 'right' },  // +3 days
    { now: [2026, 3, 21, 23, 59], box: 2, outcome: 'right' },  // +7 days
    { now: [2026, 3, 14, 23, 45], box: 3, outcome: 'right' },  // +14 days
    { now: [2026, 2, 26, 23, 0], box: 5, outcome: 'right' },   // +30 days
    { now: [2026, 3, 28, 22, 59], box: 0, outcome: 'right' },  // across the gap itself
  ];
  const want = [
    [2026, 3, 28, 0, 0],
    [2026, 3, 28, 0, 0],
    [2026, 3, 28, 0, 0],
    [2026, 3, 28, 0, 0],
    [2026, 3, 28, 0, 0],
    [2026, 3, 28, 0, 0],
    [2026, 3, 29, 0, 0],
  ];

  for (const zone of ['America/Nuuk', 'America/Scoresbysund']) {
    test(`${zone}: due is the start of the right day, never a day late`, () => {
      const r = runChild({ TZ: zone, SRS_INPUT: JSON.stringify(cases) }, `{
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        gapExists: new Date(2026, 2, 28, 23, 30).getDate() !== 28,
        due: dueParts(srs, input),
      }`);
      assert.equal(r.zone, canonicalZone(zone));
      assert.equal(r.gapExists, true, 'this ICU build has no 23:00 gap on 28 Mar 2026; test would be vacuous');
      assert.deepEqual(r.due, want);
    });
  }
});

describe('a year of reviews at awkward times in many zones (one child process)', () => {
  const zones = [
    'Asia/Ho_Chi_Minh',     // the user's own zone: UTC+7, no DST
    'America/Nuuk',         // gap 23:00 → 00:00
    'America/Scoresbysund', // same
    'America/Santiago',     // gap 00:00 → 01:00 (midnight does not exist)
    'America/Havana',       // midnight gap too
    'Africa/Cairo',         // gap 00:00 → 01:00 on a Friday
    'Asia/Beirut',          // midnight gap
    'Atlantic/Azores',      // gap 00:00 → 01:00
    'Australia/Lord_Howe',  // 30-minute DST shift
    'Pacific/Chatham',      // UTC+12:45 / +13:45
    'America/St_Johns',     // UTC-3:30 with DST
    'Asia/Kathmandu',       // UTC+5:45
    'Pacific/Kiritimati',   // UTC+14
    'Pacific/Pago_Pago',    // UTC-11
    'America/New_York',
    'Europe/London',
    'UTC',
  ];

  test('every right/hinted review of 2026 is due at the first instant of local day + interval', () => {
    const results = runChild({ SRS_INPUT: JSON.stringify(zones) }, 'sweepZones(srs, util, input, 2026)');
    assert.equal(results.length, zones.length);
    for (const r of results) {
      assert.equal(r.resolved, canonicalZone(r.zone), `TZ switch did not take effect for ${r.zone}`);
      assert.deepEqual(r.examples, [], `${r.zone}: ${r.count} bad due times`);
    }
  });
});

describe('local day boundaries (this process\'s zone)', () => {
  test('a review exactly at midnight is due at the NEXT midnight, not the same instant', () => {
    const now = at(2026, 10, 8, 0, 0);
    const p = review(newProgress('a', 'l'), 'right', now);
    assert.deepEqual(ymdhm(p.due), [2026, 10, 9, 0, 0]);
    assert.equal(isDue(p, now), false);
  });

  test('hinted at 23:59:59.999 becomes due one millisecond later, at midnight', () => {
    const now = at(2026, 10, 8, 23, 59, 59, 999);
    const p = review(withBox(3), 'hinted', now);
    assert.deepEqual(ymdhm(p.due), [2026, 10, 9, 0, 0]);
    assert.equal(isDue(p, p.due - 1), false);
    assert.equal(isDue(p, p.due), true);
  });

  test('month ends and leap days use calendar arithmetic', () => {
    assert.deepEqual(ymdhm(review(withBox(0), 'right', at(2028, 2, 28, 22)).due), [2028, 2, 29, 0, 0]);
    assert.deepEqual(ymdhm(review(withBox(0), 'right', at(2027, 2, 28, 22)).due), [2027, 3, 1, 0, 0]);
    assert.deepEqual(ymdhm(review(withBox(5), 'right', at(2028, 1, 30, 8)).due), [2028, 2, 29, 0, 0]);
    assert.deepEqual(ymdhm(review(withBox(4), 'right', at(2026, 1, 31, 8)).due), [2026, 3, 2, 0, 0]);
    assert.deepEqual(ymdhm(review(withBox(3), 'right', at(2026, 12, 25, 23, 59)).due), [2027, 1, 8, 0, 0]);
  });

  test('now = 0 and pre-1970 timestamps are valid times, not "missing"', () => {
    for (const now of [0, -1, at(1969, 7, 20, 20, 17)]) {
      const p = review(newProgress('a', 'l'), 'right', now);
      assert.equal(p.last, now);
      assert.ok(p.due > now);
      assert.equal(p.due, startOfDay(p.due));
    }
  });

  test('a clock set backwards (now before last) still schedules from now', () => {
    const later = at(2026, 10, 8, 9);
    const p = review(withBox(2, { last: later, due: at(2026, 10, 11, 0) }), 'right', at(2026, 10, 1, 9));
    assert.equal(p.box, 3);
    assert.deepEqual(ymdhm(p.due), [2026, 10, 8, 0, 0]);
    assert.equal(p.last, at(2026, 10, 1, 9));
  });
});

describe('outcomes are matched exactly', () => {
  // Typos, look-alikes and invisible characters an iPhone keyboard or a
  // copy/paste could produce — none of them may silently count as an answer.
  const lookAlikes = [
    'right ', ' right', 'Right', 'RIGHT', 'right​', '﻿right', 'right ', 'wrong\n',
    'hinted\r', 'ｒｉｇｈｔ', 'rіght' /* Cyrillic і */, 'đúng', 'sai', 'gợi ý',
    'correct', 'hint', 'wrongly', 'right,wrong', 0, 1, -1, {}, [], ['right'],
  ];

  for (const outcome of lookAlikes) {
    test(`rejects ${JSON.stringify(outcome)}`, () => {
      const p = deepFreeze(withBox(2, { seen: 3, right: 2, wrong: 1 }));
      assert.throws(() => review(p, outcome, at(2026, 10, 8)), TypeError);
    });
  }

  test('a String object is not the outcome string', () => {
    // eslint-disable-next-line no-new-wrappers
    assert.throws(() => review(withBox(1), new String('right'), at(2026, 10, 8)), TypeError);
  });

  test('a missing progress record is a TypeError, not a silent new record', () => {
    for (const p of [null, undefined]) {
      assert.throws(() => review(p, 'right', at(2026, 10, 8)), TypeError);
    }
  });
});

describe('ids and extra fields pass through byte-for-byte', () => {
  test('Vietnamese NFD, NBSP and zero-width characters in ids are not normalised', () => {
    const itemId = 'tiếng Việt​#1';  // NFD "tiếng Việt" + NBSP + ZWSP
    const listId = '378﻿';
    const p = newProgress(itemId, listId);
    const r = review(review(p, 'wrong', at(2026, 10, 8, 9)), 'hinted', at(2026, 10, 8, 10));
    assert.equal(r.itemId, itemId);
    assert.equal(r.listId, listId);
    assert.notEqual(r.itemId, itemId.normalize('NFC'));
    const [due] = dueItems([r], at(2026, 10, 9, 0));
    assert.equal(due.itemId, itemId);
  });

  test('unknown fields survive and nested values are not mutated', () => {
    const input = deepFreeze(withBox(3, { meta: { tags: ['ielts'] }, note: 'gặp trong sách' }));
    const out = review(input, 'right', at(2026, 10, 8));
    assert.equal(out.note, 'gặp trong sách');
    assert.deepEqual(out.meta, { tags: ['ielts'] });
  });

  test('dueItems and summary work on frozen inputs and leave them untouched', () => {
    const now = at(2026, 10, 8, 12);
    const list = deepFreeze([
      withBox(3, { itemId: 'c', due: now - 10 }),
      withBox(0, { itemId: 'a' }),
      withBox(1, { itemId: 'b', due: now }),
    ]);
    const snapshot = structuredClone(list);
    assert.deepEqual(dueItems(list, now).map((p) => p.itemId), ['a', 'b', 'c']);
    assert.equal(summary(list, now).due, 3);
    assert.deepEqual(list, snapshot);
  });
});

describe('stored records with odd values (IndexedDB / imported backups)', () => {
  const now = at(2026, 10, 8, 12);

  test('box is clamped to 0..5 for any number, including ±Infinity', () => {
    assert.equal(boxLabel(Infinity), 'Mastered');
    assert.equal(boxLabel(-Infinity), 'New');
    assert.equal(boxLabel(NaN), 'New');
    assert.equal(boxLabel(1e9), 'Mastered');
    assert.equal(boxLabel('5'), 'Mastered');
    assert.equal(boxLabel(' 3 '), 'Reviewing');
    assert.equal(boxLabel(2.9), 'Learning');
    assert.equal(boxLabel(-0.5), 'New');
    assert.equal(review(withBox(Infinity), 'right', now).box, 5);
    assert.equal(review(withBox(Infinity), 'hinted', now).box, 5);
    assert.equal(summary([withBox(Infinity, { due: now + 1 })], now).mastered, 1);
  });

  test('box in the result is always an integer 0..5 even from fractional/string input', () => {
    for (const box of [0.5, 1.99, '2', '4.7', -3, 42, null, undefined, '', 'abc', true]) {
      for (const outcome of ['right', 'hinted', 'wrong']) {
        const r = review(withBox(box), outcome, now);
        assert.ok(Number.isInteger(r.box) && r.box >= 1 && r.box <= MAX_BOX, `${String(box)} ${outcome} → ${r.box}`);
      }
    }
  });

  test('counters stored as numeric strings are kept, not reset to 0', () => {
    const r = review(withBox(2, { seen: '7', right: '5', wrong: '2' }), 'right', now);
    assert.equal(r.seen, 8);
    assert.equal(r.right, 6);
    assert.equal(r.wrong, 2);
    assert.equal(typeof r.seen, 'number');
  });

  test('negative or junk counters count as 0', () => {
    const r = review(withBox(2, { seen: -4, right: 'many', wrong: null }), 'wrong', now);
    assert.equal(r.seen, 1);
    assert.equal(r.right, 0);
    assert.equal(r.wrong, 1);
  });

  test('a due time of +Infinity means "not due" (spec: due <= now)', () => {
    const p = withBox(5, { due: Infinity });
    assert.equal(isDue(p, now), false);
    assert.deepEqual(dueItems([p], now), []);
    assert.equal(summary([p], now).due, 0);
  });

  test('missing / null / NaN / -Infinity due count as due; numeric strings compare as numbers', () => {
    for (const due of [undefined, null, NaN, -Infinity, '', 'not a date']) {
      assert.equal(isDue(withBox(2, { due }), now), true, String(due));
    }
    assert.equal(isDue(withBox(2, { due: String(now + 1) }), now), false);
    assert.equal(isDue(withBox(2, { due: String(now) }), now), true);
  });

  test('dueItems sorts mixed string/number boxes numerically, not as text', () => {
    const list = [
      withBox(10, { itemId: 'ten', due: now - 5 }),
      withBox('2', { itemId: 'two-str', due: now - 5 }),
      withBox(1, { itemId: 'one', due: now - 5 }),
      withBox('11', { itemId: 'eleven-str', due: now - 6 }),
      withBox(undefined, { itemId: 'no-box', due: now - 5 }),
    ];
    assert.deepEqual(dueItems(list, now).map((p) => p.itemId), ['no-box', 'one', 'two-str', 'eleven-str', 'ten']);
  });
});

describe('dueItems ordering details', () => {
  const now = at(2026, 10, 8, 12);

  test('ties keep the input order (stable), so results are deterministic', () => {
    const list = Array.from({ length: 50 }, (_, i) => withBox(i % 2 ? 1 : 0, { itemId: `w${i}`, due: i % 2 ? now - 100 : 0 }));
    const out = dueItems(list, now).map((p) => p.itemId);
    const news = list.filter((p) => p.box === 0).map((p) => p.itemId);
    const learning = list.filter((p) => p.box === 1).map((p) => p.itemId);
    assert.deepEqual(out, [...news, ...learning]);
  });

  test('sparse arrays and an item due exactly now are handled', () => {
    // eslint-disable-next-line no-sparse-arrays
    const list = [withBox(2, { itemId: 'x', due: now }), , withBox(2, { itemId: 'y', due: now - 1 })];
    assert.deepEqual(dueItems(list, now).map((p) => p.itemId), ['y', 'x']);
  });

  test('returns a new array even when every record is due', () => {
    const list = [withBox(0), withBox(0)];
    const out = dueItems(list, now);
    assert.notEqual(out, list);
    out.push('x');
    assert.equal(list.length, 2);
  });
});

describe('simulated months of study on the real list (seeded)', () => {
  // The user's list plus enough extra words to fill a reviewLimit of 20.
  const words = [...listWords, ...Array.from({ length: 60 }, (_, i) => `extra-${i}`)];

  test('the fixture yields the 11 numbered words', () => {
    assert.equal(listWords.length, 11);
    assert.equal(listWords[0], 'repository');
    assert.equal(listWords[10], 'premise');
  });

  test('invariants hold after 120 days of daily Today reviews with random outcomes', () => {
    const rng = mulberry32(378);
    const outcomes = ['right', 'right', 'right', 'hinted', 'wrong'];
    const store = new Map(words.map((w) => [w, newProgress(w, '378')]));
    const tally = new Map(words.map((w) => [w, { right: 0, wrong: 0, hinted: 0 }]));
    const day = new Date(2026, 9, 8);

    for (let d = 0; d < 120; d++) {
      // Study at a random minute of the day, sometimes late at night.
      const now = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(rng() * 24), Math.floor(rng() * 60)).getTime();
      const list = [...store.values()];
      const due = dueItems(list, now);
      const sum = summary(list, now);

      assert.equal(sum.due, due.length, 'summary.due matches dueItems');
      assert.equal(sum.new + sum.learning + sum.review + sum.mastered, sum.total);
      assert.equal(sum.total, words.length);
      for (let i = 1; i < due.length; i++) {
        const [a, b] = [due[i - 1], due[i]];
        assert.ok(a.box < b.box || (a.box === b.box && a.due <= b.due), `sorted at ${i}`);
      }

      for (const p of due.slice(0, 20)) {
        const outcome = outcomes[Math.floor(rng() * outcomes.length)];
        const r = review(p, outcome, now);
        tally.get(p.itemId)[outcome] += 1;
        assert.ok(Number.isInteger(r.box) && r.box >= 1 && r.box <= MAX_BOX);
        assert.equal(r.last, now);
        if (outcome === 'wrong') assert.equal(r.due, now);
        else {
          assert.ok(r.due > now);
          assert.equal(r.due, startOfDay(r.due));
        }
        store.set(p.itemId, r);
      }
      day.setDate(day.getDate() + 1);
    }

    for (const [w, p] of store) {
      const t = tally.get(w);
      assert.equal(p.right, t.right, w);
      assert.equal(p.wrong, t.wrong, w);
      assert.equal(p.seen, t.right + t.wrong + t.hinted, w);
    }
    // With mostly right answers over four months something must be mastered.
    assert.ok(summary([...store.values()], day.getTime()).mastered > 0);
  });

  test('a word answered right every time it is due is reviewed exactly on days 0, 1, 4, 11, 25, 55, 85', () => {
    const start = at(2026, 10, 8, 21);
    let p = newProgress('acquit', '378');
    const reviewDays = [];
    for (let d = 0; d <= 90; d++) {
      const day = new Date(start);
      day.setDate(day.getDate() + d);
      const now = day.getTime();
      if (isDue(p, now)) {
        reviewDays.push(d);
        p = review(p, 'right', now);
      }
    }
    assert.deepEqual(reviewDays, [0, 1, 4, 11, 25, 55, 85]);
    assert.equal(p.box, MAX_BOX);
  });
});

describe('performance on large progress lists', () => {
  const rng = mulberry32(2000);
  const now = at(2026, 10, 8, 12);
  const make = (n) => Array.from({ length: n }, (_, i) => withBox(Math.floor(rng() * 6), {
    itemId: `w${i}`,
    due: rng() < 0.2 ? 0 : now + Math.floor((rng() - 0.5) * 60 * 86400000),
  }));

  test('2,000 records: dueItems + summary in well under 100 ms', () => {
    const list = make(2000);
    const t0 = performance.now();
    const due = dueItems(list, now);
    const sum = summary(list, now);
    const ms = performance.now() - t0;
    assert.equal(sum.due, due.length);
    assert.ok(ms < 100, `${ms.toFixed(1)} ms`);
  });

  test('100,000 records: dueItems + summary in under 1.5 s', () => {
    const list = make(100000);
    const t0 = performance.now();
    const due = dueItems(list, now);
    const sum = summary(list, now);
    const ms = performance.now() - t0;
    assert.equal(sum.total, 100000);
    assert.equal(sum.due, due.length);
    assert.ok(ms < 1500, `${ms.toFixed(1)} ms`);
  });

  test('20,000 chained reviews stay fast and bounded', () => {
    let p = newProgress('a', 'l');
    let now = at(2026, 1, 1, 9);
    const t0 = performance.now();
    for (let i = 0; i < 20000; i++) {
      p = review(p, i % 7 === 6 ? 'wrong' : 'right', now);
      now += 3600000;
    }
    const ms = performance.now() - t0;
    assert.equal(p.seen, 20000);
    assert.ok(p.box >= 1 && p.box <= MAX_BOX);
    assert.ok(ms < 1000, `${ms.toFixed(1)} ms`);
  });
});

describe('spec cross-checks', () => {
  test('INTERVAL_DAYS cannot be changed by a caller', () => {
    assert.throws(() => { INTERVAL_DAYS[1] = 99; }, TypeError);
    assert.throws(() => { INTERVAL_DAYS.push(60); }, TypeError);
    assert.deepEqual([...INTERVAL_DAYS], [0, 1, 3, 7, 14, 30]);
  });

  test('boxLabel covers every box a review can produce', () => {
    const labels = new Set();
    for (let box = 0; box <= MAX_BOX; box++) {
      for (const outcome of ['right', 'hinted', 'wrong']) labels.add(boxLabel(review(withBox(box), outcome, 0).box));
    }
    assert.deepEqual([...labels].sort(), ['Learning', 'Mastered', 'Reviewing']);
  });

  test('summary keys are exactly the documented ones', () => {
    assert.deepEqual(Object.keys(summary([], 0)).sort(), ['due', 'learning', 'mastered', 'new', 'review', 'total']);
  });

  test('wrong then right on the same day lands in box 2 (3 days), per the Leitner rules', () => {
    const now = at(2026, 10, 8, 9);
    const p = review(review(withBox(4), 'wrong', now), 'right', now + 60000);
    assert.equal(p.box, 2);
    assert.deepEqual(ymdhm(p.due), [2026, 10, 11, 0, 0]);
    assert.equal(p.right, 1);
    assert.equal(p.wrong, 1);
  });
});
