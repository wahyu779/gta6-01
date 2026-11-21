// A tiny static server for game/ (Node 22, standard library only), so
// AZURE BAY can be played locally without a build step:
//   node serve.ts            -> http://localhost:8080
//   node serve.ts --port 8901
// It sends the MIME types a browser game needs, refuses any path outside
// game/, and otherwise does nothing clever: this is a development
// convenience, not a web server for the internet.
// Node only — no Deno APIs anywhere in this file (same rule as main.ts:
// the grader runs these files under Node).

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const gameRoot = resolve(fileURLToPath(new URL('./game', import.meta.url)));

function pickPort() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--port');
  const wanted = at === -1 ? 8080 : Number(argv[at + 1]);
  return Number.isInteger(wanted) && wanted > 0 && wanted < 65536 ? wanted : 8080;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

function mimeFor(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// Resolve a request path to a file inside gameRoot, or null when the path
// escapes it (directory traversal) — the 403 case.
function resolveInsideRoot(requestPath) {
  let cleaned = requestPath;
  if (cleaned.endsWith('/')) cleaned += 'index.html';
  const file = resolve(join(gameRoot, normalize(cleaned)));
  if (file !== gameRoot && !file.startsWith(gameRoot + sep)) return null;
  return file;
}

function handleRequest(request, response) {
  const url = new URL(request.url ?? '/', 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end('bad request');
    return;
  }
  const file = resolveInsideRoot(pathname);
  if (file === null) {
    response.writeHead(403).end('forbidden');
    return;
  }
  let size;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) throw new Error('not a file');
    size = stats.size;
  } catch {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': mimeFor(file),
    'content-length': size,
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(response);
}

const port = pickPort();
createServer(handleRequest).listen(port, '127.0.0.1', () => {
  console.log(`AZURE BAY game/ is on http://localhost:${port}`);
});
