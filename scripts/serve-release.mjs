#!/usr/bin/env node
// Serves a local release folder (from `npm run release:local`) so a dev build can update from it:
//   npm run release:serve                          -> http://127.0.0.1:8790/
//   MOTION_UPDATE_URL=http://127.0.0.1:8790 MOTION_UPDATE_PUBKEY=<public key> npx electron .
// (MOTION_UPDATE_PUBKEY is honoured by unpackaged builds only.)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export function serveDir(dir, port = 0) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = path.join(root, name);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('not found'); return; }
    const size = fs.statSync(file).size;
    res.writeHead(200, { 'content-length': size, 'content-type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || 'release/updates';
  const s = await serveDir(dir, Number(process.env.PORT || 8790));
  console.log(`serving ${dir} at http://127.0.0.1:${s.address().port}/`);
}
