// Rewrites the PRECACHE list and VERSION in sw.js from the files the app
// actually ships. VERSION is a content hash, so it only changes when a file
// changes. Usage: node tools/update-sw.mjs [--check]
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SHIPPED_DIRS = ['css', 'js', 'icons'];
const SHIPPED_FILES = ['index.html', 'manifest.webmanifest'];
const EXTENSIONS = /\.(html|css|js|svg|png|webmanifest|json)$/;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(rel)));
    else if (EXTENSIONS.test(entry.name)) out.push(rel.split(sep).join('/'));
  }
  return out;
}

export async function shippedFiles() {
  const files = [...SHIPPED_FILES];
  for (const d of SHIPPED_DIRS) files.push(...(await walk(d)));
  return files.sort();
}

export async function computeVersion(files) {
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(f);
    hash.update(await readFile(join(root, f)));
  }
  return hash.digest('hex').slice(0, 10);
}

async function main() {
  const files = await shippedFiles();
  const version = await computeVersion(files);
  const swPath = join(root, 'sw.js');
  const sw = await readFile(swPath, 'utf8');
  const list = ['./', ...files].map((f) => `  '${f}',`).join('\n');
  const next = sw
    .replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`)
    .replace(/const PRECACHE = \[[\s\S]*?\n\];/, `const PRECACHE = [\n${list}\n];`);
  if (process.argv.includes('--check')) {
    if (next !== sw) {
      console.error('sw.js is out of date — run: node tools/update-sw.mjs');
      process.exit(1);
    }
    console.log('sw.js is up to date', version);
    return;
  }
  await writeFile(swPath, next);
  console.log(`sw.js: ${files.length + 1} files, version ${version}`);
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') main();
