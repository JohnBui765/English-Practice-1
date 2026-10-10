// Helpers for Playwright scripts. Requires the dev server: node tools/serve.mjs 8080
import { chromium } from 'playwright';

export const BASE = process.env.BASE_URL || 'http://localhost:8080';

export const DEVICES = {
  se: { width: 375, height: 667 },      // iPhone SE (smallest supported)
  iphone: { width: 390, height: 844 },  // iPhone 13/14/15
  max: { width: 430, height: 932 },     // iPhone Pro Max
};

// Opens the app in a phone-sized, touch-enabled context.
// opts: { device: 'iphone', dark: false, serviceWorkers: 'block' | 'allow' }
export async function launch({ device = 'iphone', dark = false, serviceWorkers = 'block', headless = true } = {}) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: DEVICES[device] || DEVICES.iphone,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: dark ? 'dark' : 'light',
    serviceWorkers,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(BASE + '/');
  await page.waitForSelector('.screen');
  return { browser, context, page, errors };
}

// Seeds the sample vocab list (with sentences), a family list and a passage
// list straight into IndexedDB, then reloads the app on the Today tab.
export async function seedSamples(page) {
  const ids = await page.evaluate(async () => {
    const sample = await import('/js/data/sample.js');
    const v = await sample.createSampleVocabList();
    const f = await sample.createSampleFamilyList();
    const p = await sample.createSamplePassageList();
    localStorage.removeItem('vs.nav');
    return { vocab: v.id, family: f.id, passage: p.id };
  });
  await page.reload();
  await page.waitForSelector('.screen');
  return ids;
}

// Seeds the "Families 12" family list (made from root words, Claude's families
// already saved: 5 families, 21 members) and reloads the app on the Today
// tab. Returns the new list id. Can be combined with seedSamples.
export async function seedWordFamilies(page) {
  const id = await page.evaluate(async () => {
    const sample = await import('/js/data/sample.js');
    const list = await sample.createSampleWordFamilyList();
    localStorage.removeItem('vs.nav');
    return list.id;
  });
  await page.reload();
  await page.waitForSelector('.screen');
  return id;
}

export async function tap(page, selectorOrLocator) {
  const loc = typeof selectorOrLocator === 'string' ? page.locator(selectorOrLocator) : selectorOrLocator;
  await loc.first().tap();
}

// Waits for router transitions to finish.
export async function settle(page, ms = 520) {
  await page.waitForTimeout(ms);
}

export async function shot(page, name) {
  await page.screenshot({ path: `tests/e2e/out/${name}.png` });
}
