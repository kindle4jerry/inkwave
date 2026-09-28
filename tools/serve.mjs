// INKWAVE LAN server — the game and the room relay on one port, from a plain Node process with no dependencies:
//
//   node tools/serve.mjs [port=8490] [--no-relay] [--root <dir>] [--host <addr>]
//
// Open http://<this machine>:<port> on every player's browser and the game's relay is *same-origin*, which is what
// makes LAN play work everywhere: whatever address the page was loaded from is the address the relay is found at, so
// real LANs, virtual LANs (Tailscale 100.x, ZeroTier, Radmin 26.x, Hamachi 25.x), IPv6 and .local names all work
// with no configuration. `tools/relay.mjs` alone still serves a relay on :8787 for a plain static host.
//
// Same serving rules as tools/serve.py: no-cache (so a reload never mixes a fresh module with a cached one) but with
// an ETag for cheap 304s, correct MIME types for ES modules and fonts, and a 404 for anything outside the root.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelayHub, relayRequestHandler } from './relay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, def = null) => { const i = argv.indexOf('--' + name); return i >= 0 ? (argv[i + 1] ?? true) : def; };
const port = +(argv.find((a) => /^\d+$/.test(a)) || 8490);
const root = resolve(String(flag('root', join(HERE, '..'))));
const host = String(flag('host', '::'));
const withRelay = !argv.includes('--no-relay');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.webm': 'video/webm', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.bin': 'application/octet-stream',
};

const hub = withRelay ? createRelayHub({ log: (m) => console.log(`  room ${m}`) }) : null;
const relayHandler = hub ? relayRequestHandler(hub) : null;

function send(res, status, headers, body) {
  res.writeHead(status, { 'cache-control': 'no-cache', ...headers });
  if (body == null) res.end(); else res.end(body);
}

function serve(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { 'content-type': 'text/plain' }, 'method not allowed');
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(res, 400, { 'content-type': 'text/plain' }, 'bad path'); }
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(root, '.' + path);
  if (file !== root && !file.startsWith(root + sep)) return send(res, 403, { 'content-type': 'text/plain' }, 'forbidden');
  let st;
  try {
    st = statSync(file);
    if (st.isDirectory()) { st = statSync(join(file, 'index.html')); return serve2(req, res, join(file, 'index.html'), st); }
  } catch { return send(res, 404, { 'content-type': 'text/plain' }, 'not found'); }
  return serve2(req, res, file, st);
}

function serve2(req, res, file, st) {
  const etag = `W/"${st.mtimeMs.toString(36)}-${st.size.toString(36)}"`;
  const headers = {
    'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    'last-modified': st.mtime.toUTCString(),
    etag,
  };
  if (req.headers['if-none-match'] === etag) return send(res, 304, headers, null);
  headers['content-length'] = st.size;
  res.writeHead(200, { 'cache-control': 'no-cache', ...headers });
  if (req.method === 'HEAD') return res.end();
  const rs = createReadStream(file);
  rs.on('error', () => res.destroy());
  rs.pipe(res);
}

const server = createServer((req, res) => {
  const url = req.url || '/';
  if (relayHandler && (url === '/health' || url.startsWith('/health?') || url.startsWith('/room/'))) return relayHandler(req, res);
  return serve(req, res);
});
if (hub) server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));

// A Windows machine's firewall will block the port until node.exe is allowed on private networks; print what to do.
const isWin = process.platform === 'win32';
// Names of the usual virtual-LAN adapters, so the printed addresses are actually the ones friends can reach.
const VIRTUAL = /tailscale|zerotier|radmin|hamachi|logmein|mixi|openvpn|wireguard|nordlynx|softether|wan ?miniport|tap|tun|vpn/i;

function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list || []) if (!a.internal && (a.family === 'IPv4' || a.family === 'IPv6')) out.push({ name, address: a.address, v6: a.family === 'IPv6' });
  }
  return out;
}

function line(a) {
  const label = a.v6 ? 'IPv6' : VIRTUAL.test(a.name) ? 'virtual LAN' : 'network';
  const url = a.v6 ? `http://[${a.address}]:${port}` : `http://${a.address}:${port}`;
  return `  ${label.padEnd(12)} : ${url}   (${a.name})`;
}

// A virtual-LAN adapter (Tailscale, MIXI, ZeroTier, …) is often still coming up when the server starts, so keep
// announcing new addresses instead of only printing the ones that existed at launch.
const announced = new Set();
function announce() {
  const fresh = addresses().filter((a) => !announced.has(a.address));
  for (const a of fresh) announced.add(a.address);
  return fresh;
}

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `[serve] port ${port} is already in use — pass another one: node tools/serve.mjs 8491` : `[serve] ${e.message}`);
  process.exit(1);
});

server.listen({ port, host, ipv6Only: false }, () => {
  console.log(`INKWAVE serving ${root}`);
  console.log(`  this machine : http://localhost:${port}`);
  const first = announce();
  for (const a of first) console.log(line(a));
  console.log(withRelay
    ? `  relay        : same origin (ws://<that address>:${port}) — LAN rooms work with no other setup`
    : `  relay        : off (--no-relay)`);
  console.log(`  how to play  : everyone opens the *same* address from the list above; new addresses are printed as they appear`);
  if (isWin) console.log(`  firewall     : if friends can't open the page, allow node.exe on private networks,\n                 or run (as admin): netsh advfirewall firewall add rule name="INKWAVE ${port}" dir=in action=allow protocol=TCP localport=${port}`);
  console.log(`  stop         : Ctrl+C`);
});

setInterval(() => {
  const fresh = announce().filter((a) => !a.v6);
  for (const a of fresh) console.log(`  + new address, open this from the other machines:\n${line(a)}`);
}, 5000).unref?.();

const stop = () => {
  try { hub?.closeAll(); } catch { /* */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 400).unref?.();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
