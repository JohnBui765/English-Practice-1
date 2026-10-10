// End-to-end regression flows. Needs the dev server (node tools/serve.mjs 8080).
//   node tests/e2e/flows.mjs            run every flow
//   node tests/e2e/flows.mjs c e        run only these flows (ids; a journey flow
//                                       also runs the journey flows it needs)
//   SHOTS=1 node tests/e2e/flows.mjs    also save screenshots to tests/e2e/out/flows-*.png
// Prints one PASS/FAIL line per flow and exits with code 1 if any failed.
//
// Flows a → b → c → d → f → g are one user journey in one browser (each needs
// the state the previous one left). e, i, j, k, h and h2 each start a fresh browser.
import { readFileSync } from 'node:fs';
import { launch, seedSamples, seedWordFamilies, shot as saveShot } from './helpers.mjs';

const SHOTS = !!process.env.SHOTS;
const only = process.argv.slice(2).map((s) => s.toLowerCase());
const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

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
  families: '.families-screen',
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
const currentCardChecked = (page) => page.locator('.practice-card.checked:not(.leaving)').first();

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

// Word families: the forms to type on the current card, in field order
// (every member except the model, first spelling of each).
async function familyAnswers(page) {
  return currentCard(page).evaluate(async (cardEl) => {
    const store = await import('/js/data/store.js');
    const fam = await import('/js/core/families.js');
    const model = cardEl.querySelector('.fam-hero-word').textContent.trim();
    for (const list of await store.getLists()) {
      for (const item of list.kind === 'family' ? list.items : []) {
        const mi = fam.modelIndex(item);
        if ((item.members || []).length > 1 && item.members[mi].word === model) {
          return item.members.filter((_, i) => i !== mi).map((m) => fam.memberForms(m)[0]);
        }
      }
    }
    return null;
  });
}

// Word formation: the member whose example is on the current card →
// { answer (the bracketed form), word (first spelling), root }.
async function formationAnswer(page) {
  return currentCard(page).evaluate(async (cardEl) => {
    const store = await import('/js/data/store.js');
    const fam = await import('/js/core/families.js');
    const norm = (s) => s.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
    const shown = norm(cardEl.querySelector('.wf-sentence').textContent);
    for (const list of await store.getLists()) {
      for (const item of list.kind === 'family' ? list.items : []) {
        for (const m of item.members || []) {
          const b = fam.memberBlank(m);
          if (b && norm(b.before + b.after) === shown) return { answer: b.answer, word: fam.memberForms(m)[0], root: item.root, itemId: item.id };
        }
      }
    }
    return null;
  });
}

// The router's current route ({ name, params }), from the app's own module.
function route(page) {
  return page.evaluate(async () => (await import('/js/ui/router.js')).current());
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

async function flowJ() {
  const { browser, page, errors } = await launch({ device: 'iphone' });
  try {
    await waitTop(page, SCREEN.today);
    await tapTab(page, 'lists');

    // Plain words → a family list whose families Claude will make.
    await top(page).locator('.nav-action[aria-label="New list"]').tap();
    await waitTop(page, SCREEN.import);
    await top(page).locator('textarea.imp-text').fill(fixture('family-words.txt'));
    const rootsHeader = '5 words — Claude will build their families next';
    await page.waitForFunction((want) => document.querySelector('.imp-preview .section-header')?.textContent.trim() === want, rootsHeader, { timeout: 3000 }).catch(() => {});
    const header = await textOf(top(page).locator('.imp-preview .section-header'));
    assert(header === rootsHeader, `preview header: "${header}"`);
    assert((await top(page).locator('.imp-preview .imp-item').count()) === 5, 'preview shows 5 words');
    const pressed = (group) => textOf(top(page).locator(`.segmented[aria-label="${group}"] button[aria-pressed="true"]`));
    assert((await pressed('List type')) === 'Auto', `type stays on Auto (${await pressed('List type')})`);
    assert((await textOf(top(page).locator('.imp-kind .imp-detected').first())) === 'Detected: Word list', 'detected as a word list');
    assert(await top(page).locator('.imp-family').isVisible(), 'the Families choice shows');
    assert((await pressed('Families')) === 'Make with Claude', `families made with Claude (${await pressed('Families')})`);
    const save = top(page).locator('.footer .btn');
    assert((await textOf(save)) === 'Save 5 words', `footer label: ${await textOf(save)}`);
    await shot(page, 'j1-import');
    await save.tap();
    await waitTop(page, SCREEN.detail);
    let [list] = await getLists(page);
    assert(list.kind === 'family' && list.items.length === 5, `saved a family list of 5 (${list.kind}, ${list.items.length})`);
    assert(list.items.map((i) => i.root).join('|') === 'authority|demonstrate|able|decide|come up with', `roots: ${list.items.map((i) => i.root)}`);
    assert(list.items.every((i) => Array.isArray(i.members) && !i.members.length), 'every family waits for Claude');
    const hero = top(page).locator('.ld-hero');
    assert((await textOf(hero)).includes('Make word families'), 'list detail shows the "Make word families" card');
    assert((await top(page).locator('.ld-fam-row.pending').count()) === 5, 'five rows waiting for Claude');
    await shot(page, 'j2-detail');

    // Copy the prompt; iOS closes the app while the learner is in Claude.
    await hero.getByRole('button', { name: 'Make families' }).tap();
    await waitTop(page, SCREEN.families);
    assert((await textOf(top(page).locator('.fm-status-title'))) === 'No families yet', 'status: no families yet');
    assert((await textOf(top(page).locator('.fm-status-sub'))) === '5 words waiting for Claude', `status sub: ${await textOf(top(page).locator('.fm-status-sub'))}`);
    await shot(page, 'j3-families');
    await top(page).getByRole('button', { name: 'Copy prompt', exact: true }).tap();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Prompt copied'), null, { timeout: 3000 });
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    for (const want of ['1. authority', '2. demonstrate', '3. able', '4. decide', '5. come up with', 'word family', '[[authorized]]', 'example_vi', '"families"', 'American IPA', 'note']) {
      assert(clip.includes(want), `prompt should contain ${JSON.stringify(want)}`);
    }
    await page.reload();
    await page.waitForSelector('#app > .screen', { state: 'attached' });
    await waitTop(page, SCREEN.families);
    assert(await top(page).locator('.fm-step-num.done').count(), 'step 1 is ticked after coming back');
    const replyBox = top(page).locator('textarea.fm-reply');
    const inView = await replyBox.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.top < window.innerHeight - 100;
    });
    assert(inView, 'the screen comes back at step 2 (reply box in view)');

    // Paste Claude's reply and save.
    await replyBox.fill(fixture('family-reply.md'));
    await page.waitForFunction(() => /5 families · 21 forms ready/.test(document.querySelector('.fm-result')?.textContent || ''), null, { timeout: 3000 }).catch(() => {});
    const result = await textOf(top(page).locator('.fm-result'));
    assert(result.includes('5 families · 21 forms ready'), `result: "${result}"`);
    assert(!/missing|skipped|worth a check/i.test(result), `no problems reported: "${result}"`);
    const saveFamilies = top(page).locator('.footer .btn');
    assert((await textOf(saveFamilies)) === 'Save 5 families', `save label: ${await textOf(saveFamilies)}`);
    await shot(page, 'j4-reply');
    await saveFamilies.tap();
    await waitTop(page, SCREEN.detail);
    const famRow = await textOf(top(page).locator('.ld-families'));
    assert(famRow.includes('5 families · 21 forms'), `detail should show "5 families · 21 forms", got "${famRow}"`);
    assert(!(await top(page).locator('.ld-hero').count()), 'hero card gone');
    [list] = await getLists(page);
    assert(list.items.map((i) => i.members.length).join(',') === '6,4,5,5,1', `members per family: ${list.items.map((i) => i.members.length)}`);
    assert(/no word family/.test(list.items[4].note), 'the phrasal verb keeps its note');
    assert(!(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('vs.families.')).length)), 'draft cleared after saving');
    await shot(page, 'j5-detail');

    // The family sheet: every form with its example and translation.
    await top(page).locator('.ld-fam-row', { hasText: 'authority' }).tap();
    await page.waitForSelector('.overlay.open .sheet');
    await page.waitForTimeout(450);
    const sheetEl = page.locator('.overlay.open .sheet');
    assert((await textOf(sheetEl.locator('.ld-fs-forms .section-header'))) === '6 forms', 'sheet lists 6 forms');
    assert((await sheetEl.locator('.ld-member').count()) === 6, 'one row per form');
    assert((await textOf(sheetEl.locator('.ld-member-ex .ld-answer').first())) === 'authority', 'the form is bold in its example');
    assert((await textOf(sheetEl.locator('.ld-member').nth(1))).includes('authorize / authorise'), 'both spellings shown');
    assert(!(await textOf(sheetEl)).includes('[['), 'no brackets in the sheet');
    assert((await sheetEl.locator('.ld-member-exvi').count()) === 6, 'every example has its translation');
    await shot(page, 'j6-sheet');
    await sheetEl.locator('.nav-action').first().tap();
    await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 2000 });

    // Word families: one card right, then end the session.
    await openMode(page, 'Word families');
    assert((await counter(page)) === '0/4', `4 families with forms (${await counter(page)})`);
    const forms = await familyAnswers(page);
    assert(forms, 'could not find the family on the card');
    const fields = currentCard(page).locator('input.fam-field');
    assert((await fields.count()) === forms.length, 'one field per other form');
    for (let i = 0; i < forms.length; i++) await fields.nth(i).fill(forms[i]);
    await tapPrimary(page);
    await expectState(page, 'right');
    assert((await currentCardChecked(page).locator('.fam-example-vi').count()) > 0, 'translations shown after Check');
    await shot(page, 'j7-family');
    await page.locator('.practice-top .icon-btn').tap();
    await page.locator('.overlay.open .alert button', { hasText: 'End session' }).tap();
    await waitTop(page, SCREEN.results);
    let stats = await resultStats(page);
    assert(stats.Correct === 1 && stats.Mistake === 0, `family results: ${JSON.stringify(stats)}`);
    await top(page).getByRole('button', { name: 'Done' }).tap();
    await waitTop(page, SCREEN.detail);

    // Word formation: a full session with a wrong form, a slip and hints.
    await openMode(page, 'Word formation');
    assert((await counter(page)) === '0/18', `18 formation cards (${await counter(page)})`);
    await page.waitForFunction(() => document.activeElement?.classList.contains('wf-field'), null, { timeout: 2000 }).catch(() => {});
    assert(await page.evaluate(() => document.activeElement?.classList.contains('wf-field')), 'the answer field has focus');
    const missed = [];
    let sawRetry = false;
    for (let n = 0; n < 40; n++) {
      const ans = await formationAnswer(page);
      assert(ans, 'could not find the member on the card');
      const cardEl = currentCard(page);
      assert((await textOf(cardEl.locator('.wf-root'))) === ans.root, `card shows the root "${ans.root}"`);
      const field = page.locator('.practice-card:not(.leaving) input.wf-field');
      assert((await field.getAttribute('autocorrect')) === 'off' && (await field.getAttribute('autocapitalize')) === 'off', 'answer field has autocorrect/autocapitalize off');
      const retry = await cardEl.locator('.retry-tag').count();
      if (retry) {
        assert(missed.some((m) => m.answer === ans.answer), `only missed cards come back (${ans.answer})`);
        sawRetry = true;
      }
      const kind = retry ? 'right' : ['wrongForm', 'close', 'hints'][n] || 'right';
      if (kind === 'wrongForm') {
        await field.fill(ans.word !== ans.answer ? ans.word : `${ans.answer}s`);
        await tapPrimary(page);
        await expectState(page, 'wrong');
        const fb = await feedback(page);
        assert(fb.title === 'Right word, wrong form' && fb.detail === `The sentence needs "${ans.answer}".`, `wrong form feedback: ${fb.title} / ${fb.detail}`);
        assert((await textOf(currentCardChecked(page).locator('.wf-blank .wf-ans'))) === ans.answer, 'the blank shows the answer');
        missed.push(ans);
        await shot(page, 'j8-formation-wrong-form');
      } else if (kind === 'close') {
        await field.fill(typo(ans.answer));
        await tapPrimary(page);
        await expectState(page, 'close');
        const fb = await feedback(page);
        assert(fb.title === 'Almost — check the spelling' && fb.detail === `Answer: ${ans.answer}`, `close feedback: ${fb.title} / ${fb.detail}`);
        assert(await field.evaluate((el) => el.classList.contains('is-close')), 'near miss marks the field orange');
        missed.push(ans);
      } else if (kind === 'hints') {
        const hint = cardEl.locator('.wf-hint-btn');
        await hint.tap();
        await cardEl.locator('.wf-callout:not([hidden])').waitFor();
        assert(/^Needs an? /.test(await textOf(cardEl.locator('.wf-callout-strong').first())), 'hint 1 names the part of speech');
        await page.waitForTimeout(400); // a double tap uses one hint, not two
        await hint.tap();
        const chips = cardEl.locator('.wf-forms .chip');
        await chips.first().waitFor();
        assert((await chips.count()) >= 3, 'hint 2 shows the family as chips');
        await chips.first().tap();
        assert((await field.inputValue()) === (await textOf(chips.first())), 'a chip fills the field');
        await page.waitForTimeout(400);
        await hint.tap();
        assert((await textOf(cardEl.locator('.wf-callout-text'))).includes('Starts with'), 'hint 3 gives the first letter');
        assert(await hint.isHidden(), 'no more hints after the third');
        await shot(page, 'j9-formation-hints');
        await field.fill(ans.answer);
        await footerSettled(page);
        await field.press('Enter'); // Enter checks
        await expectState(page, 'right');
        assert((await feedback(page)).title === 'Correct — with a hint', 'hinted answer');
      } else {
        await field.fill(ans.answer);
        await tapPrimary(page);
        await expectState(page, 'right');
      }
      if (n === 0) {
        assert(await currentCardChecked(page).locator('.wf-reveal .wf-word').isVisible(), 'after Check the card shows the member with its speaker');
        assert(await field.evaluate((el) => el.readOnly && document.activeElement === el), 'the checked field is read-only and keeps focus');
      }
      await tapPrimary(page); // Continue
      if (await afterContinue(page)) break;
    }
    assert(sawRetry, 'missed cards came back as "Try again"');
    await waitTop(page, SCREEN.results);
    stats = await resultStats(page);
    assert(stats.Correct === 16 && stats.Mistake === 2, `formation results: ${JSON.stringify(stats)}`);
    const bold = await top(page).locator('.res-missed-form').allTextContents();
    for (const m of missed) assert(bold.includes(m.word), `"${m.word}" is marked under To review (${bold})`);
    assert((await textOf(top(page).locator('.res-sub'))).includes('Word formation'), 'results name the mode');
    await shot(page, 'j10-results');
    await top(page).getByRole('button', { name: 'Practise mistakes' }).tap();
    await waitTop(page, SCREEN.practice);
    await page.waitForSelector('.practice-card:not(.leaving)');
    assert((await counter(page)) === '0/2', `mistakes round asks only the 2 missed forms (${await counter(page)})`);
    const again = await formationAnswer(page);
    assert(missed.some((m) => m.answer === again.answer), `mistakes round card is a missed form (${again.answer})`);
    await page.locator('.practice-top .icon-btn').tap(); // nothing answered: closes at once
    await waitTop(page, SCREEN.detail);
    assert(!errors.length, `console errors: ${errors.join(' | ')}`);
  } finally {
    await browser.close();
  }
}

async function flowK() {
  const { browser, page, errors } = await launch({ device: 'iphone' });
  try {
    const ids = await seedSamples(page);
    await waitTop(page, SCREEN.today);
    await openList(page, 'Sample list');
    const make = top(page).locator('.ld-fam-link .row[aria-label="Make word families from these words"]');
    assert(await make.count(), 'the vocabulary list offers "Make word families"');
    assert((await textOf(make)).includes('From these 11 words'), `row text: ${await textOf(make)}`);
    await make.tap();
    await waitTop(page, SCREEN.families);
    let linked = (await getLists(page)).filter((l) => l.sourceListId === ids.vocab);
    assert(linked.length === 1, `one linked list (${linked.length})`);
    const fam = linked[0];
    assert(fam.kind === 'family' && fam.title === 'Sample list · families', `linked list: ${fam.kind} "${fam.title}"`);
    const vocab = (await getLists(page)).find((l) => l.id === ids.vocab);
    assert(fam.items.map((i) => i.root).join('|') === vocab.items.map((i) => i.word).join('|'), 'one root per word of the vocabulary list');
    assert(fam.items.every((i) => !i.members.length && i.rootMeaning), 'roots keep their meanings and wait for Claude');
    assert((await route(page)).params.listId === fam.id, 'families screen opened for the new list');
    assert((await textOf(top(page).locator('.fm-status-sub'))) === '11 words waiting for Claude', `status: ${await textOf(top(page).locator('.fm-status-sub'))}`);
    await shot(page, 'k1-families');

    // Back on the vocabulary list the row now leads to the same family list.
    await top(page).locator('.nav-back').tap();
    await waitTop(page, SCREEN.detail);
    const linkRow = top(page).locator('.ld-fam-link.linked .row');
    const linkText = await textOf(linkRow);
    assert(linkText.includes('Word families') && linkText.includes('11 families · waiting for Claude'), `linked row: ${linkText}`);
    await shot(page, 'k2-linked-row');
    await linkRow.tap();
    await waitTop(page, SCREEN.detail);
    assert((await route(page)).params.listId === fam.id, 'second tap opens the same family list');
    assert((await textOf(top(page).locator('.nav-title'))) === 'Sample list · families', 'family list title');
    assert((await textOf(top(page).locator('.ld-hero'))).includes('Make word families'), 'family list shows the "Make word families" card');
    await top(page).locator('.nav-back').tap();
    await waitTop(page, SCREEN.detail);

    // The … menu reaches the same list too, without making another one.
    await top(page).locator('.nav-action[aria-label="More"]').tap();
    await page.locator('.action-sheet button', { hasText: 'Make word families' }).tap();
    await waitTop(page, SCREEN.families);
    assert((await route(page)).params.listId === fam.id, '… menu opens the same family list');
    const lists = await getLists(page);
    linked = lists.filter((l) => l.sourceListId === ids.vocab);
    assert(linked.length === 1 && lists.length === 4, `no second family list (${linked.length} linked, ${lists.length} lists)`);
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
    await seedWordFamilies(page);
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

    // Word families made by Claude: list, sheet, families screen, Word formation.
    await openList(page, 'Families 12');
    await checkNoOverflow(page, 'Family list detail');
    await shot(page, `h-${tag}-family-detail`);
    await top(page).locator('.ld-fam-row').first().tap();
    await page.waitForSelector('.overlay.open .sheet');
    await page.waitForTimeout(450);
    await checkNoOverflow(page, 'Family sheet');
    await shot(page, `h-${tag}-family-sheet`);
    await page.locator('.overlay.open .sheet .nav-action').first().tap();
    await page.waitForFunction(() => !document.querySelector('.overlay'), null, { timeout: 2000 });
    await top(page).locator('.ld-families .row').tap();
    await waitTop(page, SCREEN.families);
    await checkNoOverflow(page, 'Word families screen');
    await shot(page, `h-${tag}-families`);
    // A reply with problems: the notes, the missing list and every family row must fit.
    const partial = [
      'Here you go:',
      '```json',
      JSON.stringify({
        families: [
          {
            w: 1,
            members: [
              { word: 'authority', pos: 'n', ipa: 'əˈθɔːrəti', vi: 'quyền lực', example: 'Only the director has the [[authority]] to approve the payment.' },
              { word: 'authorize / authorise', pos: 'v', vi: 'cho phép', example: 'The director has not signed the form yet.' },
              { pos: 'adj', vi: 'đáng tin cậy' },
            ],
          },
          { w: 3, members: [{ word: 'able', pos: 'adj', vi: 'có thể', example: 'She was [[able]] to follow the news in English.' }] },
        ],
      }),
      '```',
    ].join('\n');
    await top(page).locator('textarea.fm-reply').fill(partial);
    await page.waitForFunction(() => document.querySelector('.fm-result')?.childElementCount > 1, null, { timeout: 3000 });
    await top(page).locator('.fm-cur-head').tap();
    await page.waitForTimeout(300);
    await checkNoOverflow(page, 'Word families screen with a reply');
    await shot(page, `h-${tag}-families-reply`);
    await top(page).locator('.fm-clear').tap();
    await top(page).locator('.nav-back').tap();
    await waitTop(page, SCREEN.detail);

    await openMode(page, 'Word formation');
    await checkNoOverflow(page, 'Formation card');
    await shot(page, `h-${tag}-formation`);
    const hintBtn = currentCard(page).locator('.wf-hint-btn');
    for (let i = 0; i < 3 && (await hintBtn.isVisible()); i++) {
      await hintBtn.tap();
      await page.waitForTimeout(400);
    }
    await checkNoOverflow(page, 'Formation hints');
    await shot(page, `h-${tag}-formation-hints`);
    await page.locator('.practice-card:not(.leaving) input.wf-field').fill('zzzz');
    await tapPrimary(page);
    await page.waitForFunction(() => document.querySelector('.practice-footer')?.dataset.state !== 'idle');
    await page.waitForTimeout(350);
    await checkNoOverflow(page, 'Checked formation card');
    await shot(page, `h-${tag}-formation-checked`);
    await page.locator('.practice-top .icon-btn').tap();
    await page.locator('.overlay.open .alert button', { hasText: 'End session' }).tap();
    await waitTop(page, SCREEN.results);
    await checkNoOverflow(page, 'Formation results');
    await shot(page, `h-${tag}-formation-results`);
    await top(page).getByRole('button', { name: 'Done' }).tap();
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
  { id: 'j', name: 'Word families: paste words, copy prompt, app reopened, paste reply, sheet, Word families + Word formation to results', run: flowJ },
  { id: 'k', name: 'Make word families from a vocabulary list: linked list, second tap opens the same list', run: flowK },
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
