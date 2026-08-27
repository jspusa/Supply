import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist');
const port = Number(process.env.SUPPLY_DIST_PORT || 4173);
const host = '127.0.0.1';
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
]);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new TypeError('SUPPLY_DIST_PORT must be an integer from 1 through 65535');
}
if (!fs.existsSync(path.join(distRoot, 'release.json'))) {
  throw new Error('dist/release.json is missing; build the exact artifact before starting the browser server');
}

function resolveRequestPath(rawUrl) {
  const url = new URL(rawUrl || '/', `http://${host}:${port}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/Boss' || pathname === '/Boss/') pathname = '/Boss/index.html';
  const candidate = path.resolve(distRoot, `.${pathname}`);
  const relative = path.relative(distRoot, candidate);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return null;
  return candidate;
}

const server = http.createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method || '')) {
    response.writeHead(405, { Allow:'GET, HEAD' });
    response.end();
    return;
  }
  const file = resolveRequestPath(request.url);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404, { 'Content-Type':'text/plain; charset=utf-8', 'Cache-Control':'no-store' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type':mimeTypes.get(path.extname(file).toLowerCase()) || 'application/octet-stream',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
  });
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(file).pipe(response);
});

server.listen(port, host, () => {
  process.stdout.write(`Supply dist server listening on http://${host}:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
