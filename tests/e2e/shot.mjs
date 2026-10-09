// Quick screenshot helper: node tests/e2e/shot.mjs <outfile> [path] [--dark] [--w=390 --h=844]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const out = args[0] || 'tests/e2e/out/shot.png';
const path = args.find((a, i) => i > 0 && !a.startsWith('--')) || '/';
const dark = args.includes('--dark');
const w = Number((args.find((a) => a.startsWith('--w=')) || '--w=390').slice(4));
const hgt = Number((args.find((a) => a.startsWith('--h=')) || '--h=844').slice(4));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light' });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:8080' + path);
await page.waitForTimeout(800);
await page.screenshot({ path: out });
console.log(logs.join('\n') || 'no console output');
await browser.close();
