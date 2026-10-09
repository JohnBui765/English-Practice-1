// End-to-end regression flows. Needs the dev server (node tools/serve.mjs 8080).
//   node tests/e2e/flows.mjs            run every flow
//   node tests/e2e/flows.mjs c e        run only these flows (ids; a journey flow
//                                       also runs the journey flows it needs)
//   SHOTS=1 node tests/e2e/flows.mjs    also save screenshots to tests/e2e/out/flows-*.png
// Prints one PASS/FAIL line per flow and exits with code 1 if any failed.
//
// Flows a → b → c → d → f → g are one user journey in one browser (each needs
// the state the previous one left). e, i, h and h2 each start a fresh browser.
import { launch, seedSamples, shot as saveShot } from './helpers.mjs';

const SHOTS = !!process.env.SHOTS;
const only = process.argv.slice(2).map((s) => s.toLowerCase());

/* ---------- helpers ---------- */

class FlowError extends Error {}

function assert(cond, message) {
  if (!cond) throw new FlowError(message);
}

async function shot(page, name) {
  if (!SHOTS) return;
  // Let the boot splash and running transitions finish first.
  await page.waitForFunction(() => !document.querySelector('.boot'), null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(450);
  await saveShot(page, `flows-${name}`);
}

// The top-most screen in the navigation stack.
const top = (page) => page.locator('#app > .screen').last();

// Waits until the router is idle and the top screen matches `sel`.
async function waitTop(page, sel, timeout = 6000) {
  try {
    await page.waitForFunction(
      (sel) => {
        const app = document.getElementById('app');
        if (!app || app.classList.contains('busy')) return false;
        const screens = [...app.children].filter((e) => e.classList.contains('screen'));
        const t = screens[screens.length - 1];
        return !!t && t.matches(sel);
      },
      sel,
      { timeout },
    );
  } catch {
    const now = await page.evaluate(() => {
      const screens = [...document.querySelectorAll('#app > .screen')];
      const t = screens[screens.length - 1];
      return t ? `${t.className} "${t.querySelector('.nav-title')?.textContent || ''}"` : 'none';
    });
    throw new FlowError(`expected top screen ${sel}, found ${now}`);
  }
  await page.waitForTimeout(60);
}

const SCREEN = {
  today: '.screen:has(.tabbar .tab.active[data-tab="today"])',
  lists: '.lists-screen',
  settings: '.screen:has(.tabbar .tab.active[data-tab="settings"])',
  import: '.import-screen',
  detail: '.list-detail-screen',
  sentences: '.sentences-screen',
  practice: '.screen.practice',
  results: '.results-screen',
};

async function tapTab(page, name) {
  await top(page).locator(`.tabbar .tab[data-tab="${name}"]`).tap();
  await waitTop(page, SCREEN[name]);
}

async function textOf(locator) {
  return ((await locator.textContent()) || '').replace(/\s+/g, ' ').trim();
}

// Reads lists straight from the app's store module (same instance as the app).
function getLists(page) {
  return page.evaluate(async () => {
    const store = await import('/js/data/store.js');
    return store.getLists();
  });
}

async function openList(page, title) {
  if (!(await top(page).evaluate((el) => el.matches('.lists-screen')))) await tapTab(page, 'lists');
  await top(page).locator('.lists-row', { hasText: title }).first().tap();
  await waitTop(page, SCREEN.detail);
}

async function openMode(page, label) {
  await top(page).locator(`.ld-mode[aria-label^="${label}"]`).tap();
  await waitTop(page, SCREEN.practice);
  await page.waitForSelector('.practice-card:not(.leaving)');
}

/* ---------- practice helpers ---------- */

const primary = (page) => page.locator('.practice-footer .pf-actions > .btn').first();
const footerState = (page) => page.locator('.practice-footer').getAttribute('data-state');
const currentCard = (page) => page.locator('.practice-card:not(.leaving):not(.checked)').first();

async function tapPrimary(page) {
  const btn = primary(page);
  await btn.waitFor();
  assert(!(await btn.isDisabled()), `primary button "${await textOf(btn)}" is disabled`);
  await btn.tap();
}

// The footer ignores taps and Enter for a moment after it changes, so the
// second tap of a double tap cannot skip the feedback. (Taps already wait:
// the buttons do not take pointer events meanwhile.)
async function footerSettled(page) {
  await page.waitForSelector('.practice-footer:not(.settling)', { timeout: 3000 });
}

async function expectState(page, want) {
  try {
    await page.waitForFunction((want) => document.querySelector('.practice-footer')?.dataset.state === want, want, { timeout: 3000 });
  } catch {
    throw new FlowError(`footer state should be "${want}", is "${await footerState(page)}"`);
  }
}

async function feedback(page) {
  return { title: await textOf(page.locator('.pf-title')), detail: await textOf(page.locator('.pf-detail')) };
}

// After Continue: either the next card is mounted or the results screen shows.
async function afterContinue(page) {
  await page.waitForFunction(
    () => {
      const app = document.getElementById('app');
      const screens = [...app.children].filter((e) => e.classList.contains('screen'));
      const t = screens[screens.length - 1];
      if (t?.matches('.results-screen')) return !app.classList.contains('busy');
      return !!t?.querySelector('.practice-card:not(.leaving):not(.checked)') && document.querySelector('.practice-footer')?.dataset.state === 'idle';
    },
    null,
    { timeout: 5000 },
  );
  await page.waitForTimeout(40);
  return top(page).evaluate((el) => el.matches('.results-screen'));
}

// Results screen stats → { Correct: 18, Mistake: 1, ... } (label → number).
async function resultStats(page) {
  return top(page).locator('.res-stat').evaluateAll((els) =>
    Object.fromEntries(els.map((e) => [e.querySelector('.res-stat-label').textContent.trim().replace(/s$/, ''), Number(e.querySelector('.res-stat-value').textContent)])),
  );
}

async function counter(page) {
  return textOf(page.locator('.pt-count'));
}

// Cloze: the item word for the sentence on the current card.
async function clozeAnswer(page) {
  return currentCard(page).evaluate(async (cardEl) => {
    const store = await import('/js/data/store.js');
    const lists = await store.getLists();
    const shown = cardEl.querySelector('.cz-sentence').textContent.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
    for (const list of lists) {
      for (const s of list.sentences || []) {
        const plain = s.text.replace(/\[\[.*?\]\]/, '').replace(/\s+/g, ' ').trim();
        if (plain === shown) {
          const item = list.items.find((i) => i.id === s.itemId);
          return { word: item.word, itemId: item.id, sentenceId: s.id, answer: s.answer };
        }
      }
    }
    return null;
  });
}

// Meaning: the item whose meanings are on the current card.
async function meaningAnswer(page) {
  return currentCard(page).evaluate(async (cardEl) => {
    const store = await import('/js/data/store.js');
    const lists = await store.getLists();
    const texts = [...cardEl.querySelectorAll('.mn-text, .mn-sense')].map((e) => e.textContent.trim()).join('|');
    for (const list of lists) {
      for (const item of list.items || []) {
        if ((item.senses || []).map((s) => s.trim()).filter(Boolean).join('|') === texts) return { word: item.word, itemId: item.id };
      }
    }
    return null;
  });
}

// One-letter typo near the end: "acquit" → "acquix".
function typo(word) {
  const last = word.slice(-1);
  return word.slice(0, -1) + (last === 'x' ? 'z' : 'x');
}

async function checkNoOverflow(page, where) {
  const res = await page.evaluate(() => {
    const vw = window.innerWidth;
    const out = [];
    const se = document.scrollingElement;
    if (se.scrollWidth > vw) out.push(`page scrollWidth ${se.scrollWidth} > ${vw}`);
    const screens = [...document.querySelectorAll('#app > .screen')];
    const t = screens[screens.length - 1];
    const roots = [t, ...document.querySelectorAll('.overlay')].filter(Boolean);
    for (const root of roots) {
      if (root.scrollWidth > root.clientWidth + 1) out.push(`${root.className} scrollWidth ${root.scrollWidth} > ${root.clientWidth}`);
      for (const el of root.querySelectorAll('*')) {
        if (el.closest('[hidden], .screen-dim')) continue;
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        if (r.width > vw + 0.5 || r.right > vw + 0.5 || r.left < -0.5) {
          out.push(`${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).trim().replace(/\s+/g, '.')} [${Math.round(r.left)}..${Math.round(r.right)}]`);
          if (out.length > 6) return out;
        }
        // Content that scrolls sideways inside a box (a clipped long word).
        if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1 && el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') {
          out.push(`${el.tagName.toLowerCase()}.${el.className} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
        }
      }
    }
    return out;
  });
  assert(!res.length, `horizontal overflow on ${where}: ${res.join('; ')}`);
}

/* ---------- flows ---------- */

const journey = {}; // state shared by a → b → c → d → f → g

async function flowA() {
  const { browser, page, errors } = await launch({ device: 'iphone' });
  Object.assign(journey, { browser, page, errors });
  await waitTop(page, SCREEN.today);
  await tapTab(page, 'lists');
  const empty = top(page).locator('.lists-empty');
  assert(await empty.isVisible(), 'Lists should show the empty state on first run');
  assert((await textOf(empty)).includes('No lists yet'), 'empty state title');
  await shot(page, 'a1-empty');

  await empty.getByRole('button', { name: 'Paste a list' }).tap();
  await waitTop(page, SCREEN.import);
  const text = await page.evaluate(async () => (await import('/js/data/sample.js')).SAMPLE_LIST_TEXT);
  await top(page).locator('textarea.imp-text').fill(text);
  await page.waitForFunction(() => document.querySelector('.imp-preview .section-header')?.textContent.trim() === '11 words', null, { timeout: 3000 }).catch(() => {});
  const header = await textOf(top(page).locator('.imp-preview .section-header'));
  assert(header === '11 words', `preview header should be "11 words", got "${header}"`);
  assert((await top(page).locator('.imp-preview .imp-item').count()) === 11, 'preview shows 11 rows');
  const save = top(page).locator('.footer .btn');
  assert((await textOf(save)) === 'Save 11 words', `footer label: ${await textOf(save)}`);
  await shot(page, 'a2-import');
  await save.tap();
  await waitTop(page, SCREEN.detail);
  const hero = top(page).locator('.ld-hero');
  assert(await hero.isVisible(), 'list detail shows the "Make context sentences" card');
  assert((await textOf(hero)).includes('Make context sentences'), 'hero title');
  assert((await textOf(top(page).locator('.nav-title'))) === '378', 'title parsed from the list');
  await shot(page, 'a3-detail');
}

async function flowB() {
  const { page } = journey;
  await waitTop(page, SCREEN.detail);
  await top(page).locator('.ld-hero').getByRole('button', { name: 'Make sentences' }).tap();
  await waitTop(page, SCREEN.sentences);
  await shot(page, 'b1-sentences');
  await top(page).getByRole('button', { name: 'Copy prompt' }).first().tap();
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Prompt copied'), null, { timeout: 3000 });
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert(/acquit/.test(clip) && /premise/.test(clip), 'clipboard holds the prompt with the words');

  // The learner goes to the Claude app and iOS closes this one meanwhile:
  // the app must come back on the Sentences screen, with step 1 ticked.
  await page.reload();
  await page.waitForSelector('#app > .screen', { state: 'attached' });
  await waitTop(page, SCREEN.sentences);
  assert(await top(page).locator('.sn-step-num.done').count(), 'step 1 is ticked after coming back');
  assert((await textOf(top(page).locator('.nav-back'))) === '378', 'back button still leads to the list');

  const reply = await page.evaluate(async () => (await import('/js/data/sample.js')).SAMPLE_REPLY);
  await top(page).locator('textarea.sn-reply').fill(reply);
  await page.waitForFunction(() => /19 sentences ready/.test(document.querySelector('.sn-result')?.textContent || ''), null, { timeout: 3000 }).catch(() => {});
  const result = await textOf(top(page).locator('.sn-result'));
  assert(result.includes('19 sentences ready'), `result should say "19 sentences ready", got "${result}"`);
  const save = top(page).locator('.footer .btn');
  assert((await textOf(save)) === 'Save 19 sentences', `save label: ${await textOf(save)}`);
  await shot(page, 'b2-ready');
  await save.tap();
  await waitTop(page, SCREEN.detail);
  const row = await textOf(top(page).locator('.ld-sentences'));
  assert(row.includes('19 sentences'), `detail should show "19 sentences", got "${row}"`);
  assert(row.includes('Every meaning covered'), 'all meanings covered');
  assert(!(await top(page).locator('.ld-hero').count()), 'hero card gone');
  const lists = await getLists(page);
  assert(lists[0].sentences.length === 19, 'stored 19 sentences');
  await shot(page, 'b3-detail');
}

async function flowC() {
  const { page } = journey;
  await waitTop(page, SCREEN.detail);
  await openMode(page, 'In context');
  const first = await counter(page);
  const total = Number(first.split('/')[1]);
  assert(first === `0/${total}` && total === 19, `counter starts at 0/19, got ${first}`);
  assert(await page.locator('.cz-bank').isVisible(), 'word bank mode');
  await shot(page, 'c1-card');

  let missed = null;
  let sawRetry = false;
  for (let n = 0; n < 60; n++) {
    const ans = await clozeAnswer(page);
    assert(ans, 'could not find the sentence on the card');
    const retry = await currentCard(page).locator('.retry-tag').count();
    if (retry) {
      assert(missed && ans.sentenceId === missed.sentenceId, 'only the missed card comes back');
      assert((await textOf(currentCard(page).locator('.retry-tag'))) === 'Try again', 'retry tag text');
      sawRetry = true;
    }
    const chips = currentCard(page).locator('.cz-bank .chip');
    const labels = await chips.allTextContents();
    if (n === 0) {
      const wrong = labels.find((l) => l.trim() !== ans.word);
      await chips.filter({ hasText: new RegExp(`^${wrong}$`) }).tap();
      await tapPrimary(page);
      await expectState(page, 'wrong');
      const fb = await feedback(page);
      assert(fb.detail === `Answer: ${ans.answer}`, `wrong feedback detail: ${fb.detail}`);
      missed = ans;
      await shot(page, 'c2-wrong');
    } else {
      assert(labels.map((l) => l.trim()).includes(ans.word), `bank should contain the answer ${ans.word}`);
      await chips.filter({ hasText: new RegExp(`^${ans.word}$`) }).tap();
      assert((await textOf(currentCard(page).locator('.cz-blank'))) === ans.word, 'chosen word fills the blank');
      await tapPrimary(page);
      await expectState(page, 'right');
    }
    await tapPrimary(page); // Continue
    if (await afterContinue(page)) break;
  }
  assert(sawRetry, 'the wrong card came back as "Try again"');
  await waitTop(page, SCREEN.results);
  const stats = await resultStats(page);
  assert(stats.Correct === 18 && stats.Mistake === 1, `results stats: ${JSON.stringify(stats)}`);
  assert((await textOf(top(page).locator('.section'))).includes(missed.word), 'missed word listed under To review');
  await shot(page, 'c3-results');

  await top(page).getByRole('button', { name: 'Practise mistakes' }).tap();
  await waitTop(page, SCREEN.practice);
  await page.waitForSelector('.practice-card:not(.leaving)');
  const lists = await getLists(page);
  const senses = lists[0].sentences.filter((s) => s.itemId === missed.itemId).length;
  assert((await counter(page)) === `0/${senses}`, `mistakes session has only that item (0/${senses}), got ${await counter(page)}`);
  for (let n = 0; n < 10; n++) {
    const ans = await clozeAnswer(page);
    assert(ans.itemId === missed.itemId, `mistakes session card is for "${missed.word}", got "${ans.word}"`);
    await currentCard(page).locator('.cz-bank .chip').filter({ hasText: new RegExp(`^${ans.word}$`) }).tap();
    await tapPrimary(page);
    await expectState(page, 'right');
    await tapPrimary(page);
    if (await afterContinue(page)) break;
  }
  await waitTop(page, SCREEN.results);
  assert((await textOf(top(page).locator('.res-title'))) === 'Perfect!', 'mistakes round is perfect');
  await top(page).getByRole('button', { name: 'Done' }).tap();
  await waitTop(page, SCREEN.detail);
}

async function flowD() {
  const { page } = journey;
  await waitTop(page, SCREEN.detail);

  // Meaning → Word, typed.
  await openMode(page, 'Meaning');
  await page.waitForFunction(() => document.activeElement?.classList.contains('mn-field'), null, { timeout: 2000 }).catch(() => {});
  assert(await page.evaluate(() => document.activeElement?.classList.contains('mn-field')), 'the first card focuses its answer field');
  const plan = ['right', 'close', 'wrong'];
  const wrongWords = new Set();
  let usedEnter = false;
  for (let n = 0; n < 40; n++) {
    const ans = await meaningAnswer(page);
    assert(ans, 'could not find the item for the meanings on the card');
    const field = page.locator('.practice-card:not(.leaving) input.mn-field');
    assert((await field.getAttribute('autocorrect')) === 'off' && (await field.getAttribute('autocapitalize')) === 'off', 'answer field has autocorrect/autocapitalize off');
    const kind = n < plan.length ? plan[n] : 'right';
    await field.fill(kind === 'right' ? ans.word : kind === 'close' ? typo(ans.word) : 'zzzz');
    if (kind === 'right' && !usedEnter) {
      await footerSettled(page);
      await field.press('Enter'); // Enter checks…
      usedEnter = true;
    } else {
      await tapPrimary(page);
    }
    // A one-letter slip is shown in orange (state "close"), not red.
    await expectState(page, kind);
    const fb = await feedback(page);
    if (kind === 'close') {
      assert(fb.title === 'Almost — check the spelling', `close answer title: "${fb.title}"`);
      assert(await field.evaluate((el) => el.classList.contains('is-close')), 'near miss marks the field orange');
      wrongWords.add(ans.word);
      await shot(page, 'd1-close');
    } else if (kind === 'wrong') {
      assert(fb.title === 'Not quite' && fb.detail === `Answer: ${ans.word}`, `wrong answer feedback: ${fb.title} / ${fb.detail}`);
      wrongWords.add(ans.word);
    }
    if (n === 0) {
      await footerSettled(page);
      await field.press('Enter'); // …and Enter again continues.
    } else {
      await tapPrimary(page);
    }
    if (await afterContinue(page)) break;
  }
  await waitTop(page, SCREEN.results);
  let stats = await resultStats(page);
  assert(stats.Correct === 9 && stats.Mistake === 2, `meaning results: ${JSON.stringify(stats)}`);
  const review = await textOf(top(page).locator('.section'));
  for (const w of wrongWords) assert(review.includes(w), `"${w}" listed under To review`);
  await top(page).getByRole('button', { name: 'Done' }).tap();
  await waitTop(page, SCREEN.detail);

  // Word → Meaning, self-graded.
  await openMode(page, 'Word → Meaning');
  let knew = 0;
  let forgot = 0;
  for (let n = 0; n < 40; n++) {
    assert((await textOf(primary(page))) === 'Show answer', 'flashcard primary label');
    await tapPrimary(page);
    await expectState(page, 'grade');
    if (n === 0) await shot(page, 'd2-flashcard');
    const retry = await page.locator('.practice-card:not(.leaving) .retry-tag').count();
    const know = n % 3 !== 0 || retry > 0;
    await page.locator('.pf-grade').getByRole('button', { name: know ? 'Knew it' : "Didn't know" }).tap();
    await expectState(page, know ? 'right' : 'wrong');
    if (!retry) know ? knew++ : forgot++;
    await tapPrimary(page);
    if (await afterContinue(page)) break;
  }
  await waitTop(page, SCREEN.results);
  stats = await resultStats(page);
  assert(stats.Correct === knew && stats.Mistake === forgot, `flashcard results (${knew}/${forgot}): ${JSON.stringify(stats)}`);
  await top(page).getByRole('button', { name: 'Done' }).tap();
  await waitTop(page, SCREEN.detail);
}

async function flowE() {
  const { browser, page, errors } = await launch({ device: 'iphone' });
  try {
    await seedSamples(page);
    await waitTop(page, SCREEN.today);

    // Word families.
    await openList(page, 'Word families (sample)');
    await openMode(page, 'Word families');
    const lists = await getLists(page);
    const fam = lists.find((l) => l.kind === 'family');
    for (let n = 0; n < 10; n++) {
      const model = await textOf(currentCard(page).locator('.fam-hero-word'));
      const item = fam.items.find((i) => i.members[0].word === model);
      assert(item, `family for model "${model}"`);
      const fields = currentCard(page).locator('input.fam-field');
      const count = await fields.count();
      assert(count === item.members.length - 1, `one field per other form (${count})`);
      for (let i = 0; i < count; i++) await fields.nth(i).fill(item.members[i + 1].word);
      await tapPrimary(page);
      await expectState(page, 'right');
      if (n === 0) await shot(page, 'e1-family');
      await tapPrimary(page);
      if (await afterContinue(page)) break;
    }
    await waitTop(page, SCREEN.results);
    assert((await textOf(top(page).locator('.res-title'))) === 'Perfect!', 'family results');
    await top(page).getByRole('button', { name: 'Done' }).tap();
    await waitTop(page, SCREEN.detail);
    await top(page).locator('.nav-back').tap();
    await waitTop(page, SCREEN.lists);

    // Dictation (read mode): one wrong attempt, then right.
    await openList(page, 'Dictation (sample)');
    await openMode(page, 'Dictation');
    let mistakes = 0;
    for (let n = 0; n < 10; n++) {
      const text = (await currentCard(page).locator('.dict-text').textContent()).trim();
      assert((await textOf(primary(page))) === "I'm ready", 'dictation starts with "I\'m ready"');
      await tapPrimary(page);
      const input = currentCard(page).locator('textarea.dict-input');
      await input.waitFor();
      await page.waitForFunction(() => !document.querySelector('.practice-card:not(.leaving) .dict-read'), null, { timeout: 2000 }).catch(() => {});
      assert(!(await currentCard(page).locator('.dict-read').count()), 'passage is hidden while writing');
      const answer = n === 0 ? text.split(' ').slice(0, -2).join(' ') : text;
      await input.fill(answer);
      await tapPrimary(page);
      if (n === 0) {
        mistakes++;
        // Two words short of the passage is still most of it: orange, not red.
        await expectState(page, 'close');
        const diff = page.locator('.practice-card.checked:not(.leaving) .dict-diff');
        assert(await diff.locator('.dw-missing').first().isVisible(), 'diff marks the missed words');
        await shot(page, 'e2-dictation');
      } else {
        await expectState(page, 'right');
      }
      await tapPrimary(page);
      if (await afterContinue(page)) break;
    }
    await waitTop(page, SCREEN.results);
    const stats = await resultStats(page);
    assert(stats.Mistake === mistakes && stats.Correct === 2 - mistakes, `dictation results: ${JSON.stringify(stats)}`);
    await top(page).getByRole('button', { name: 'Done' }).tap();
    await waitTop(page, SCREEN.detail);
    assert(!errors.length, `console errors: ${errors.join(' | ')}`);
  } finally {
    await browser.close();
  }
}

async function flowF() {
  const { page } = journey;
  await waitTop(page, SCREEN.detail);
  const before = {
    title: await textOf(top(page).locator('.nav-title')),
    sentences: await textOf(top(page).locator('.ld-sentences')),
    legend: await textOf(top(page).locator('.ld-legend')),
  };
  assert(!/New\s*11/.test(before.legend), `progress recorded before reload: ${before.legend}`);
  await page.reload();
  await page.waitForSelector('#app > .screen', { state: 'attached' });
  await waitTop(page, SCREEN.detail);
  const after = {
    title: await textOf(top(page).locator('.nav-title')),
    sentences: await textOf(top(page).locator('.ld-sentences')),
    legend: await textOf(top(page).locator('.ld-legend')),
  };
  assert(after.title === before.title, `restored list detail "${after.title}"`);
  assert(after.sentences === before.sentences && after.sentences.includes('19 sentences'), `sentences after reload: ${after.sentences}`);
  assert(after.legend === before.legend, `progress after reload: ${after.legend} (was ${before.legend})`);
  const lists = await getLists(page);
  assert(lists.length === 1 && lists[0].sentences.length === 19, 'list and sentences stored');
  const progress = await page.evaluate(async () => (await (await import('/js/data/store.js')).getProgress()).size);
  assert(progress === 11, `progress for all 11 words (got ${progress})`);
  await shot(page, 'f1-restored');
}

async function flowG() {
  const { page } = journey;
  await waitTop(page, SCREEN.detail);
  // Escape on an open sheet closes the sheet only (iPad / desktop keyboards).
  await top(page).locator('.ld-item').first().tap();
  await page.waitForSelector('.overlay.open .sheet');
  await page.waitForTimeout(450);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 2000 });
  await waitTop(page, SCREEN.detail);
  const cdp = await page.context().newCDPSession(page);
  const y = 420;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 5, y }] });
  for (let x = 20; x <= 300; x += 20) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitTop(page, SCREEN.lists);
  assert((await top(page).locator('.lists-row').count()) === 1, 'Lists shows the list');
  const covered = await page.evaluate(() => document.querySelectorAll('#app > .screen').length);
  assert(covered === 1, `only the Lists screen is left (${covered})`);
  await shot(page, 'g1-lists');
}

async function flowI() {
  const { browser, page, errors } = await launch({ device: 'iphone' });
  try {
    await seedSamples(page);
    await waitTop(page, SCREEN.today);

    // Review from Today: answer two cards, then end early.
    await top(page).getByRole('button', { name: /Start review/ }).tap();
    await waitTop(page, SCREEN.practice);
    await page.waitForSelector('.practice-card:not(.leaving)');
    assert((await counter(page)) === '0/11', `review has every new word (${await counter(page)})`);
    for (let n = 0; n < 2; n++) {
      const ans = await clozeAnswer(page);
      assert(ans, 'review card is an In context card');
      await currentCard(page).locator('.cz-bank .chip').filter({ hasText: new RegExp(`^${ans.word}$`) }).tap();
      await tapPrimary(page);
      await expectState(page, 'right');
      await tapPrimary(page);
      await afterContinue(page);
    }
    await page.locator('.practice-top .icon-btn').tap();
    await page.waitForSelector('.overlay.open .alert');
    await page.locator('.alert button', { hasText: 'Keep going' }).tap();
    await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 2000 });
    await page.keyboard.press('Escape'); // asks too, instead of closing silently
    await page.waitForSelector('.overlay.open .alert', { timeout: 2000 }).catch(() => {});
    assert(await page.locator('.alert').count(), 'Escape asks before ending the session');
    await page.locator('.alert button', { hasText: 'End session' }).tap();
    await waitTop(page, SCREEN.results);
    const stats = await resultStats(page);
    assert(stats.Correct === 2 && stats.Mistake === 0, `ended-early results: ${JSON.stringify(stats)}`);
    assert((await textOf(top(page).locator('.res-sub'))) === 'Review', `results subtitle: ${await textOf(top(page).locator('.res-sub'))}`);
    await top(page).getByRole('button', { name: 'Done' }).tap();
    await waitTop(page, SCREEN.today);
    const progress = await page.evaluate(async () => (await (await import('/js/data/store.js')).getProgress()).size);
    assert(progress === 2, `progress saved for the 2 answered words (${progress})`);

    // Resume: leave a session half-way, reload, continue from the list.
    await openList(page, 'Sample list');
    await openMode(page, 'In context');
    for (let n = 0; n < 3; n++) {
      const ans = await clozeAnswer(page);
      await currentCard(page).locator('.cz-bank .chip').filter({ hasText: new RegExp(`^${ans.word}$`) }).tap();
      await tapPrimary(page);
      await tapPrimary(page);
      await afterContinue(page);
    }
    assert((await counter(page)) === '3/19', `counter before reload ${await counter(page)}`);
    await page.reload();
    await page.waitForSelector('#app > .screen', { state: 'attached' });
    await waitTop(page, SCREEN.detail); // practice is not restored; the list is
    const resume = top(page).locator('.ld-resume');
    assert(await resume.count(), 'list detail offers the paused session');
    assert((await textOf(resume)).includes('In context · 3 of 19'), `resume row: ${await textOf(resume)}`);
    await shot(page, 'i1-resume-row');
    await resume.locator('.row').tap();
    await waitTop(page, SCREEN.practice);
    await page.waitForSelector('.practice-card:not(.leaving)');
    assert((await counter(page)) === '3/19', `resumed at 3/19, got ${await counter(page)}`);
    // Finishing the resumed session clears the row.
    for (let n = 0; n < 40; n++) {
      const ans = await clozeAnswer(page);
      await currentCard(page).locator('.cz-bank .chip').filter({ hasText: new RegExp(`^${ans.word}$`) }).tap();
      await tapPrimary(page);
      await tapPrimary(page);
      if (await afterContinue(page)) break;
    }
    await waitTop(page, SCREEN.results);
    assert((await resultStats(page)).Correct === 19, 'resumed session counts all 19 cards');
    await top(page).getByRole('button', { name: 'Done' }).tap();
    await waitTop(page, SCREEN.detail);
    assert(!(await top(page).locator('.ld-resume').count()), 'resume row gone after finishing');
    assert(!errors.length, `console errors: ${errors.join(' | ')}`);
  } finally {
    await browser.close();
  }
}

async function smoke({ device, dark }) {
  const { browser, page, errors } = await launch({ device, dark });
  const tag = `${device}${dark ? '-dark' : ''}`;
  try {
    await seedSamples(page);
    await waitTop(page, SCREEN.today);
    await checkNoOverflow(page, 'Today');
    await shot(page, `h-${tag}-today`);
    await tapTab(page, 'lists');
    await checkNoOverflow(page, 'Lists');
    await shot(page, `h-${tag}-lists`);
    await openList(page, 'Sample list');
    await checkNoOverflow(page, 'List detail');
    await shot(page, `h-${tag}-detail`);
    await top(page).locator('.ld-item').first().tap();
    await page.waitForSelector('.overlay.open .sheet');
    await page.waitForTimeout(450);
    await checkNoOverflow(page, 'Word sheet');
    await shot(page, `h-${tag}-word-sheet`);
    await page.locator('.overlay.open .sheet .nav-action').first().tap();
    await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 2000 });

    await top(page).locator('.ld-sentences .row').tap();
    await waitTop(page, SCREEN.sentences);
    await checkNoOverflow(page, 'Sentences');
    await shot(page, `h-${tag}-sentences`);
    await top(page).locator('.nav-back').tap();
    await waitTop(page, SCREEN.detail);

    for (const mode of ['In context', 'Meaning', 'Word → Meaning']) {
      await openMode(page, mode);
      await checkNoOverflow(page, `${mode} card`);
      await shot(page, `h-${tag}-${mode.split(' ')[0].toLowerCase()}`);
      await page.locator('.practice-top .icon-btn').tap();
      await waitTop(page, SCREEN.detail);
    }

    // A checked card (wrong answer) and the results screen.
    await openMode(page, 'In context');
    await currentCard(page).locator('.cz-bank .chip').first().tap();
    await tapPrimary(page);
    await page.waitForFunction(() => document.querySelector('.practice-footer')?.dataset.state !== 'idle');
    await page.waitForTimeout(350);
    await checkNoOverflow(page, 'Checked card');
    await shot(page, `h-${tag}-checked`);
    await page.locator('.practice-top .icon-btn').tap();
    await page.locator('.overlay.open .alert button', { hasText: 'End session' }).tap();
    await waitTop(page, SCREEN.results);
    await checkNoOverflow(page, 'Results');
    await shot(page, `h-${tag}-results`);
    await top(page).getByRole('button', { name: 'Done' }).tap();
    await waitTop(page, SCREEN.detail);

    await top(page).locator('.nav-action[aria-label="More"]').tap();
    await page.locator('.action-sheet button', { hasText: 'Edit list' }).tap();
    await waitTop(page, SCREEN.import);
    await page.waitForTimeout(250);
    await checkNoOverflow(page, 'Edit list');
    await shot(page, `h-${tag}-edit`);
    await top(page).locator('.nav-action', { hasText: 'Cancel' }).tap();
    await waitTop(page, SCREEN.detail);

    await top(page).locator('.nav-back').tap();
    await waitTop(page, SCREEN.lists);
    await openList(page, 'Word families (sample)');
    await openMode(page, 'Word families');
    await checkNoOverflow(page, 'Family card');
    await shot(page, `h-${tag}-family`);
    await page.locator('.practice-top .icon-btn').tap();
    await waitTop(page, SCREEN.detail);
    await top(page).locator('.nav-back').tap();
    await waitTop(page, SCREEN.lists);
    await openList(page, 'Dictation (sample)');
    await openMode(page, 'Dictation');
    await checkNoOverflow(page, 'Dictation card');
    await shot(page, `h-${tag}-dictation`);
    await page.locator('.practice-top .icon-btn').tap();
    await waitTop(page, SCREEN.detail);

    await top(page).locator('.nav-back').tap();
    await waitTop(page, SCREEN.lists);
    await tapTab(page, 'settings');
    await checkNoOverflow(page, 'Settings');
    await shot(page, `h-${tag}-settings`);
    await tapTab(page, 'lists');
    await top(page).locator('.nav-action[aria-label="New list"]').tap();
    await waitTop(page, SCREEN.import);
    await page.waitForTimeout(250);
    await checkNoOverflow(page, 'New list');
    await shot(page, `h-${tag}-import`);
    assert(!errors.length, `console errors: ${errors.join(' | ')}`);
  } finally {
    await browser.close();
  }
}

const FLOWS = [
  { id: 'a', name: 'First run: empty Lists → New List → list detail', run: flowA, journey: true },
  { id: 'b', name: 'Sentences: copy prompt, app reopened, paste reply, save 19', run: flowB, journey: true },
  { id: 'c', name: 'In context (bank): wrong → Try again → results → Practise mistakes', run: flowC, journey: true },
  { id: 'd', name: 'Meaning → Word (right/close/wrong) and Word → Meaning', run: flowD, journey: true },
  { id: 'f', name: 'Persistence: reload restores list detail, sentences and progress', run: flowF, journey: true },
  { id: 'g', name: 'Escape closes a sheet only; swipe back from list detail to Lists', run: flowG, journey: true },
  { id: 'e', name: 'Word families and dictation sessions to results', run: flowE },
  { id: 'i', name: 'Review from Today, end early (button and Escape ask first), resume from list detail after reload', run: flowI },
  { id: 'h', name: 'Smoke 375×667 dark: every screen, no overflow, no errors', run: () => smoke({ device: 'se', dark: true }) },
  { id: 'h2', name: 'Smoke 375×667 light: every screen, no overflow, no errors', run: () => smoke({ device: 'se', dark: false }) },
];

let failed = 0;
let journeyBroken = null;
// A journey flow also runs the journey flows before it (it needs their state).
const journeyIds = FLOWS.filter((f) => f.journey).map((f) => f.id);
const lastJourney = Math.max(-1, ...only.map((id) => journeyIds.indexOf(id)));
const wanted = (f) => !only.length || only.includes(f.id) || (f.journey && journeyIds.indexOf(f.id) <= lastJourney);
for (const flow of FLOWS.filter(wanted)) {
  const label = `${flow.id}. ${flow.name}`;
  if (flow.journey && journeyBroken) {
    failed++;
    console.log(`FAIL  ${label} — skipped, needs flow ${journeyBroken}`);
    continue;
  }
  const errStart = journey.errors ? journey.errors.length : 0;
  const t0 = Date.now();
  try {
    await flow.run();
    if (flow.journey) {
      const errs = journey.errors.slice(errStart);
      assert(!errs.length, `console errors: ${errs.join(' | ')}`);
    }
    console.log(`PASS  ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failed++;
    if (flow.journey) journeyBroken = flow.id;
    console.log(`FAIL  ${label}\n      ${err instanceof FlowError ? err.message : err.stack}`);
    const page = flow.journey ? journey.page : null;
    if (page) await saveShot(page, `flows-fail-${flow.id}`).catch(() => {});
  }
}
if (journey.browser) await journey.browser.close();
console.log(failed ? `\n${failed} flow(s) failed` : '\nAll flows passed');
process.exit(failed ? 1 : 0);
