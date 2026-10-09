// Minimal static server for local testing:
//   node tools/serve.mjs [port] [--base=/english-vocab-studio/]
// --base serves the app under a sub-path, like GitHub Pages does.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) || process.env.PORT || 8080);
const baseArg = process.argv.find((a) => a.startsWith('--base='));
const base = baseArg ? '/' + baseArg.slice(7).replace(/^\/+|\/+$/g, '') + '/' : '/';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (base !== '/' && url.pathname === base.slice(0, -1)) {
      res.writeHead(301, { Location: base });
      return res.end();
    }
    if (!url.pathname.startsWith(base)) throw new Error('outside base');
    let path = normalize(decodeURIComponent(url.pathname.slice(base.length - 1))).replace(/^([/\\])+/, '');
    let file = join(root, path);
    if (!file.startsWith(root)) throw new Error('outside root');
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, () => console.log(`Serving ${root} on http://localhost:${port}${base}`));
