// INKWAVE LAN test — proves LAN play works with no browser, no internet and no dependencies.
//
//   node tools/lan-test.mjs
//
// Three layers, all local:
//   1. the relay's protocol (tools/relay.mjs): rooms, join refusal, host election, fan-out, ping/pong, lock, sweep;
//   2. the game's own client (src/net/transport.js) against that relay: address picking (LAN / virtual LAN / manual
//      override / fallback) and a real room handshake;
//   3. tools/serve.mjs serving the game *and* the relay on one port, including MIME types and path traversal.
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelayHub, relayRequestHandler } from './relay.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
const group = (t) => console.log(`\n${t}`);

// A raw WebSocket client that remembers everything it was sent, so assertions can look back as well as wait.
function client(url) {
  const ws = new WebSocket(url);
  const c = { ws, msgs: [], closed: null, url };
  ws.onmessage = (ev) => c.msgs.push(typeof ev.data === 'string' ? ev.data : '[binary]');
  ws.onclose = (ev) => { c.closed = { code: ev.code, reason: ev.reason }; };
  c.open = new Promise((res, rej) => {
    ws.onopen = () => res(c);
    setTimeout(() => rej(new Error('open timed out: ' + url)), 5000).unref?.();
  });
  c.objs = () => c.msgs.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  c.find = (pred) => c.objs().find(pred);
  c.wait = (pred, ms, label) => new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      const v = pred(c);
      if (v) return res(v);                      // every predicate here returns a found message / true, never 0 or ''
      if (Date.now() - t0 > ms) return rej(new Error(`timed out waiting for ${label || 'message'} (last: ${JSON.stringify(c.msgs.slice(-4))})`));
      setTimeout(tick, 10);
    };
    tick();
  });
  c.welcome = () => c.wait((x) => x.find((o) => o.t === 'welcome'), 3000, 'welcome');
  c.close = () => { try { ws.close(1000, 'bye'); } catch { /* */ } };
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const room = (relay, code, name, create) => client(`${relay}/room/${code}?name=${encodeURIComponent(name)}&v=1${create ? '&create=1' : ''}`);

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen({ port: 0, host: '127.0.0.1' }, r));
  return server;
}

// ------------------------------------------------------------------ 1. relay protocol
async function protocol() {
  group('relay protocol (tools/relay.mjs)');
  const hub = createRelayHub({ log: () => {} });
  const server = await listen(relayRequestHandler(hub));
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  const relay = `ws://127.0.0.1:${server.address().port}`;
  const http = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  const track = (c) => (clients.push(c), c);

  try {
    const health = await fetch(`${http}/health`).then((r) => r.text());
    ok('/health answers "ok"', health === 'ok', health.slice(0, 40));

    // create → welcome, host is you
    const A = track(room(relay, 'AAAAA', 'Ada', true));
    const wa = await A.welcome();
    ok('create → welcome with an id', !!wa.id, JSON.stringify(wa).slice(0, 80));
    ok('creator is host', wa.host === wa.id);
    ok('welcome lists the room', wa.members.length === 1 && wa.members[0].name === 'Ada', JSON.stringify(wa.members));
    A.ws.send('ping');
    const pong = await A.wait((x) => x.msgs.includes('pong'), 1500, 'pong');
    ok('"ping" → "pong" (the relay liveness signal)', !!pong);
    A.ws.send(JSON.stringify({ t: 'ping', c: 7 }));
    ok('{"t":"ping","c":n} → {"t":"pong","c":n}', await A.wait((x) => x.find((o) => o.t === 'pong' && o.c === 7), 1500, 'json pong') !== undefined);

    // second member: join is relayed, host stays the oldest
    const B = track(room(relay, 'AAAAA', 'Bo', false));
    const wb = await B.welcome();
    ok('join → welcome sees both members', wb.members.length === 2 && wb.members[0].id === wa.id, JSON.stringify(wb.members));
    ok('host is the oldest member', wb.host === wa.id);
    const jn = await A.wait((x) => x.find((o) => o.t === 'join'), 1500, 'join frame');
    ok('existing member hears {"t":"join"}', jn !== undefined);

    // payload fan-out: "b|" everywhere else, "s|to|" to one member
    A.ws.send('b|{"k":"hello"}');
    const got = await B.wait((x) => x.msgs.some((s) => s === `m|${wa.id}|{"k":"hello"}`), 1500, 'broadcast');
    ok('broadcast arrives as "m|<from>|<payload>"', !!got);
    ok('broadcast does not echo to the sender', !A.msgs.some((s) => s.startsWith('m|')));
    A.ws.send(`s|${wb.id}|{"k":"dm"}`);
    await B.wait((x) => x.msgs.some((s) => s === `m|${wa.id}|{"k":"dm"}`), 1500, 'direct message');
    await sleep(120);
    ok('direct message goes only to the addressee', A.msgs.filter((s) => s.includes('"dm"')).length === 0);
    A.ws.send('b|not json at all');
    A.ws.send('b|{"k":"after"}');
    ok('a malformed payload does not kill the link', await B.wait((x) => x.msgs.some((s) => s.endsWith('{"k":"after"}')), 1500, 'next broadcast') !== undefined);

    // refusals
    const bad = track(room(relay, 'AAAAA', 'Nope', true));
    await bad.wait((x) => x.find((o) => o.t === 'err'), 2000, 'err');
    ok('duplicate create → "Room code taken"', bad.find((o) => o.t === 'err')?.e === 'Room code taken');
    await bad.wait((x) => x.closed, 2000, 'close after err');
    ok('refusal carries the reason as the close reason', bad.closed?.reason === 'Room code taken', JSON.stringify(bad.closed));
    const missing = track(room(relay, 'ZZZZZ', 'Nobody', false));
    await missing.wait((x) => x.find((o) => o.t === 'err'), 2000, 'err');
    ok('unknown code → "Room not found"', missing.find((o) => o.t === 'err')?.e === 'Room not found');
    const old = track(client(`${relay}/room/AAAAA?name=Old&v=99`));
    await old.wait((x) => x.find((o) => o.t === 'err'), 2000, 'version err');
    ok('wrong protocol version → refresh message', /refresh/i.test(old.find((o) => o.t === 'err')?.e || ''));

    // lock (host only) + full room
    B.ws.send(JSON.stringify({ t: 'lock', v: true }));      // guest: must be ignored
    const C = track(room(relay, 'AAAAA', 'Cy', false));
    const wc = await C.welcome();
    ok('a guest cannot lock the room (the next join still works)', !!wc.id);
    A.ws.send(JSON.stringify({ t: 'lock', v: true }));
    await sleep(80);
    const D = track(room(relay, 'AAAAA', 'Dee', false));
    await D.wait((x) => x.find((o) => o.t === 'err'), 2000, 'locked err');
    ok('host lock → "Match in progress"', D.find((o) => o.t === 'err')?.e === 'Match in progress');
    C.close(); D.close(); await sleep(60);
    A.ws.send(JSON.stringify({ t: 'lock', v: false }));

    const full = track(room(relay, 'FULL1', 'F0', true));
    await full.welcome();
    const extras = [];
    for (let i = 1; i < 8; i++) { const c = track(room(relay, 'FULL1', 'F' + i, false)); extras.push(c); await c.welcome(); }
    const ninth = track(room(relay, 'FULL1', 'F9', false));
    await ninth.wait((x) => x.find((o) => o.t === 'err'), 2000, 'full err');
    ok('room caps at 8 players → "Room is full"', ninth.find((o) => o.t === 'err')?.e === 'Room is full');
    for (const c of extras) c.close();
    full.close();
    await sleep(80);

    // oversized payload is dropped, the link survives
    A.ws.send('b|' + 'x'.repeat(70000));
    await sleep(120);
    ok('an oversized payload is dropped', !B.msgs.some((s) => s.length > 60000));
    A.ws.send('b|{"k":"alive"}');
    ok('…and the link keeps working', await B.wait((x) => x.msgs.some((s) => s.endsWith('{"k":"alive"}')), 1500, 'post-oversize broadcast') !== undefined);

    // leave + host migration
    A.close();
    const lv = await B.wait((x) => x.find((o) => o.t === 'leave' && o.id === wa.id), 2500, "the host's leave frame");
    ok('leaving is announced', lv.id === wa.id, JSON.stringify(lv));
    ok('host migrates to the next member', lv.host === wb.id, JSON.stringify(lv));
    B.close();
    C.close();
    await sleep(100);

    // a plain HTTP request to a room is refused with 426, and the status page names open rooms
    const res = await fetch(`${http}/room/AAAAA`);
    ok('a non-upgrade /room request → 426', res.status === 426, String(res.status));
    const page = await fetch(http).then((r) => r.text());
    ok('status page answers', /INKWAVE/.test(page), page.split('\n')[0]);
  } finally {
    for (const c of clients) c.close();
    hub.closeAll();
    server.close();
  }
}

// ------------------------------------------------------------------ 2. the sweep drops dead players
async function sweep() {
  group('liveness sweep (a player whose Wi-Fi died is dropped)');
  const hub = createRelayHub({ log: () => {}, silentLobby: 200, sweep: 40 });
  const server = await listen(relayRequestHandler(hub));
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  const relay = `ws://127.0.0.1:${server.address().port}`;
  try {
    const A = room(relay, 'SWEEP', 'Alive', true);
    await A.welcome();
    const B = room(relay, 'SWEEP', 'Silent', false);
    const wb = await B.welcome();
    const ka = setInterval(() => { try { A.ws.send('ping'); } catch { /* */ } }, 40);
    const lv = await A.wait((x) => x.find((o) => o.t === 'leave'), 3000, 'leave for the silent player');
    clearInterval(ka);
    ok('the quiet socket is dropped', lv.id === wb.id, JSON.stringify(lv));
    ok('dropped with "Connection timed out"', B.closed?.reason === 'Connection timed out', JSON.stringify(B.closed));
    ok('the pinging socket survives', !A.closed);
    A.close();
    B.close();
  } finally { hub.closeAll(); server.close(); }
}

// ------------------------------------------------------------------ 3. the game's own client
async function transportClient() {
  group('game client address picking + a real room (src/net/transport.js)');
  const hub = createRelayHub({ log: () => {} });
  const server = await listen(relayRequestHandler(hub));
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  const relay = `ws://127.0.0.1:${server.address().port}`;

  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.location = { protocol: 'http:', hostname: '192.168.1.5', port: '8490', search: '' };
  const T = await import('../src/net/transport.js');

  try {
    const home = T.relayCandidates();
    ok('a LAN page tries its own origin first', home[0] === 'ws://192.168.1.5:8490', home.join(' '));
    ok('…then a standalone relay on :8787', home[1] === 'ws://192.168.1.5:8787', home.join(' '));
    ok('…and the public relay last', home[home.length - 1] === T.PROD_RELAY, home.join(' '));
    ok('relayURL() reports the first candidate', T.relayURL() === home[0]);

    // virtual LANs use addresses no RFC1918 rule matches: 100.x (Tailscale), 26.x (Radmin), 25.x (Hamachi)
    for (const ip of ['100.101.102.103', '26.31.44.9', '25.7.8.9', 'fd7a:115c:a1e0::1']) {
      globalThis.location = { protocol: 'http:', hostname: ip, port: '8490', search: '' };
      const c = T.relayCandidates();
      const host = ip.includes(':') ? `[${ip}]` : ip;
      ok(`virtual LAN ${ip} is used, not the public relay`, c[0] === `ws://${host}:8490`, c.join(' '));
    }

    globalThis.location = { protocol: 'https:', hostname: 'inkwave-aah.pages.dev', port: '', search: '' };
    ok('the public site still uses the deployed relay', T.relayCandidates()[0] === T.PROD_RELAY);

    // a manual address (the online screen's LAN RELAY row) wins, and ?relay= wins over it
    globalThis.location = { protocol: 'http:', hostname: '192.168.1.5', port: '8490', search: '' };
    ok('typing "192.168.1.9:8787" → ws://192.168.1.9:8787', T.normalizeRelay('192.168.1.9:8787') === 'ws://192.168.1.9:8787');
    ok('typing "192.168.1.9" keeps the page port', T.normalizeRelay('192.168.1.9') === 'ws://192.168.1.9:8490');
    ok('"auto" clears the override', T.setRelayOverride('auto') === '' && T.relayCandidates()[0] === 'ws://192.168.1.5:8490');
    T.setRelayOverride('10.0.0.5:9000');
    ok('a stored address is honoured', T.relayCandidates().length === 1 && T.relayCandidates()[0] === 'ws://10.0.0.5:9000');
    globalThis.location = { protocol: 'http:', hostname: '192.168.1.5', port: '8490', search: '?relay=wss://relay.example:443' };
    ok('?relay= beats the stored address', T.relayOverride() === 'wss://relay.example:443');
    globalThis.location = { protocol: 'http:', hostname: '192.168.1.5', port: '8490', search: '' };
    T.setRelayOverride('');

    // a real room through the game's client: host + guest, broadcast received
    T.setRelayOverride(relay);
    const host = new T.Transport();
    const welcome = await host.connect('LAN01', 'Host', true);
    ok('Transport.connect() opens a room', !!welcome.id, JSON.stringify(welcome).slice(0, 80));
    ok('the transport reports the address that answered', host.url === relay, String(host.url));
    const guest = new T.Transport();
    const inbox = [];
    let guestId = null;
    guest.onMessage = (from, d) => inbox.push([from, d]);
    const w2 = await guest.connect('LAN01', 'Guest', false);
    guestId = w2.id;
    ok('a second player joins the same relay', w2.members.length === 2 && w2.host === welcome.id);
    host.broadcast({ k: 'lobby', l: 'x' });
    host.sendTo(guestId, { k: 'me', name: 'Host' });
    const t0 = Date.now();
    while (inbox.length < 2 && Date.now() - t0 < 2000) await sleep(20);
    ok("the host's broadcast reaches the guest", inbox.some(([f, d]) => f === welcome.id && d.k === 'lobby'));
    ok("the host's direct message reaches the guest", inbox.some(([f, d]) => f === welcome.id && d.k === 'me'));
    const refused = new T.Transport();
    T.setRelayOverride(relay);
    let err = null;
    try { await refused.connect('NOPE1', 'Nobody', false); } catch (e) { err = e; }
    ok("a refused join reports the relay's reason", err?.message === 'Room not found', String(err && err.message));
    ok('a refusal is authoritative (no fallthrough)', err?.fatal === true);
    T.setRelayOverride('');
    host.close(); guest.close(); refused.close();

    // fallback: a page whose own origin is not a relay, with a standalone relay on :8787
    let second = null;
    try {
      second = createServer(relayRequestHandler(hub));
      await new Promise((res, rej) => { second.on('error', rej); second.listen({ port: 8787, host: '127.0.0.1' }, res); });
      second.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
      const dead = createServer();
      await new Promise((r) => dead.listen({ port: 0, host: '127.0.0.1' }, r));
      const deadPort = dead.address().port;
      await new Promise((r) => dead.close(r));
      globalThis.location = { protocol: 'http:', hostname: '127.0.0.1', port: String(deadPort), search: '' };
      const tr = new T.Transport();
      const w = await tr.connect('FALLB', 'Fallback', true);
      ok('the game falls through to :8787 when its origin is not a relay', !!w.id && tr.url === 'ws://127.0.0.1:8787', `tried ${tr.tried.join(' ')} → ${tr.url}`);
      tr.close();
    } catch (e) {
      console.log(`  skip fallback (:8787 is taken here: ${e.code || e.message})`);
    } finally {
      try { second?.close(); } catch { /* */ }
    }
  } finally {
    hub.closeAll();
    server.close();
  }
}

// ------------------------------------------------------------------ 4. one-port server: game + relay
async function onePort() {
  group('tools/serve.mjs — game and relay on one port');
  const port = 8600 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, [join('tools', 'serve.mjs'), String(port)], { cwd: ROOT, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(`${base}/health`)).ok; } catch { await sleep(100); }
    }
    ok('the server answers /health, so the relay runs on the game port', up);
    if (!up) return;
    const index = await fetch(base + '/');
    const html = await index.text();
    ok('GET / serves index.html', index.status === 200 && /INKWAVE/.test(html) && /text\/html/.test(index.headers.get('content-type') || ''));
    ok('responses are no-cache but carry an ETag', /no-cache/.test(index.headers.get('cache-control') || '') && !!index.headers.get('etag'));
    const etag = index.headers.get('etag');
    const cached = await fetch(base + '/', { headers: { 'if-none-match': etag } });
    ok('the ETag gives a 304', cached.status === 304, String(cached.status));
    const mod = await fetch(base + '/src/net/transport.js');
    ok('ES modules are served as text/javascript', mod.status === 200 && /text\/javascript/.test(mod.headers.get('content-type') || ''), mod.headers.get('content-type') || '');
    const font = await fetch(base + '/assets/fonts/Rubik-latin.woff2');
    ok('fonts are served as font/woff2', font.status === 200 && /font\/woff2/.test(font.headers.get('content-type') || ''));
    ok('a missing file is a 404', (await fetch(base + '/nope.js')).status === 404);
    const escape = await new Promise((res) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/..%2fpackage.json' }, (r) => { r.resume(); res(r.statusCode); });
      req.on('error', () => res(0));
      req.end();
    });
    ok('a path outside the root is refused', escape === 403 || escape === 404, String(escape));

    const c = client(`ws://127.0.0.1:${port}/room/PORT1?name=One&v=1&create=1`);
    const w = await c.welcome();
    ok('a room opens through the same port', !!w.id && w.host === w.id);
    c.close();
  } catch (e) {
    ok('one-port server', false, e.message);
  } finally {
    child.kill();
  }
}

const watchdog = setTimeout(() => { console.log('\nWATCHDOG — stuck, giving up'); process.exit(2); }, 90000);
watchdog.unref?.();

for (const t of [protocol, sweep, transportClient, onePort]) {
  try { await t(); } catch (e) { fail++; console.log(`  FAIL ${t.name} threw — ${e.message}`); }
}
console.log(`\n${fail ? 'FAILED' : 'PASS'} — ${pass} checks passed${fail ? `, ${fail} failed` : ''}`);
process.exit(fail ? 1 : 0);
