// The service worker must precache every file the app ships, and nothing that
// does not exist — otherwise the app breaks offline or fails to install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { shippedFiles, computeVersion } from '../../tools/update-sw.mjs';

const root = new URL('../../', import.meta.url);

async function precacheList() {
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  const block = sw.match(/const PRECACHE = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'PRECACHE array not found');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('every precached file exists', async () => {
  for (const f of await precacheList()) {
    if (f === './') continue;
    await assert.doesNotReject(access(new URL(f, root)), `missing ${f}`);
  }
});

test('every shipped file is precached', async () => {
  const listed = new Set(await precacheList());
  const missing = (await shippedFiles()).filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], 'run: node tools/update-sw.mjs');
});

// VERSION is a hash of the shipped files. If a file changes and sw.js does
// not, installed apps keep serving the old files from the cache forever.
test('VERSION matches the shipped files', async () => {
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  const version = sw.match(/const VERSION = '([^']+)'/)?.[1];
  assert.ok(version, 'VERSION not found');
  assert.equal(version, await computeVersion(await shippedFiles()), 'run: node tools/update-sw.mjs');
});

test('index.html only links files that exist', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]);
  for (const ref of refs) await assert.doesNotReject(access(new URL(ref, root)), `missing ${ref}`);
});
