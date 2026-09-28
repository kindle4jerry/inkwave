// INKWAVE LAN relay — the same room relay as server/src/index.js (Cloudflare Worker + Durable Object), but as a
// plain Node process with no dependencies and no internet: `node tools/relay.mjs` serves ws://<this machine>:8787.
//
// Why it exists: the deployed Worker is only reachable from the public internet. On a LAN (a real network or a
// virtual one — Tailscale, ZeroTier, Radmin, Hamachi) every player can reach the host machine directly, so this
// file speaks exactly the protocol the game already uses and nothing in src/net has to change to play that way.
//
//   GET /room/<CODE>?name=<name>&create=1&v=<proto>   (WebSocket upgrade) → the room for that code
//   GET /health                                        → "ok"
//
// Wire format (identical to the Worker's; game payloads are forwarded as raw strings, never parsed here):
//   client → room:  "b|<payload>" broadcast · "s|<toId>|<payload>" to one member · "ping" → "pong"
//                   {"t":"lock","v":bool} (host only: refuse joins while a match runs)
//   room → client:  "m|<fromId>|<payload>" · {"t":"welcome",id,host,members} · {"t":"join","m":{id,name}}
//                   {"t":"leave",id,host} · {"t":"err","e":"…"} (then close)
//
// The WebSocket server below is a small RFC 6455 implementation (handshake + frames) because Node ships no
// WebSocket *server* and this project has no dependencies. It handles what a browser actually sends: masked client
// frames, fragmentation, ping/pong/close, a size cap and a message budget.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const PROTO = 1;
export const MAX = 8;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CODE = /^[A-Z0-9]{4,8}$/;
// Same hygiene as the Worker: the game sends ~25 messages/s, so a runaway or hostile client is cut off before it can
// eat the host's CPU, and a socket whose "ping"s stop is dropped so that player is handed to a bot (docs/NET.md).
export const MSG_MAX = 65536;
const RATE = 90, BURST_STRIKES = 4, FRAME_MAX = 1 << 20;
export const SILENT_MATCH = 20000, SILENT_LOBBY = 150000, SWEEP = 4000;

const rid = () => Math.random().toString(36).slice(2, 6).toUpperCase();
const cleanName = (s) => String(s || 'Player').replace(/[^\p{L}\p{N} ._\-!?']/gu, '').slice(0, 16) || 'Player';

// ------------------------------------------------------------------ frames (RFC 6455)
function encode(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.allocUnsafe(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.allocUnsafe(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.allocUnsafe(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

/** One upgraded socket: frame parser in, framed text out. Reports every assembled text message. */
class Conn {
  constructor(socket, { onMessage, onClose }) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buf = Buffer.alloc(0);
    this.frag = null;         // Buffer while a fragmented message is being collected
    this.closed = false;      // no further frames from us
    this.dead = false;        // socket gone
    this.meta = null;         // the room's member record { id, name, seq, at, gone }
    this.room = null;
    this.seen = 0;            // last inbound message, ms
    this.rate = { t: 0, n: 0, strikes: 0 };
    socket.setNoDelay?.(true);
    socket.on('data', (c) => this._feed(c));
    socket.on('error', () => this._dead());
    socket.on('close', () => this._dead());
  }

  send(s) {
    if (this.closed || this.dead || !this.socket.writable) return false;
    try { this.socket.write(encode(0x1, Buffer.from(String(s), 'utf8'))); return true; } catch { this._dead(); return false; }
  }

  /** Send a close frame (if any), end the socket, and make sure we tear down even if the peer never answers. */
  _finish(frame) {
    try { if (frame) this.socket.write(frame); this.socket.end(); } catch { /* gone */ }
    const t = setTimeout(() => this._dead(), 250);
    t.unref?.();
  }

  close(code = 1000, reason = '') {
    if (this.closed || this.dead) return;
    this.closed = true;
    const body = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2, 'utf8');
    this._finish(encode(0x8, body));
  }

  _dead() {
    if (this.dead) return;
    this.dead = true;
    this.closed = true;
    try { this.socket.destroy(); } catch { /* gone */ }
    this.onClose?.(this);
  }

  _feed(chunk) {
    if (this.dead) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(FRAME_MAX)) { this.close(1009, 'Message too big'); return; }
        len = Number(big); off = 10;
      }
      if (!masked) { this.close(1002, 'Client frames must be masked'); return; }   // RFC 6455 §5.1
      if (len > FRAME_MAX) { this.close(1009, 'Message too big'); return; }
      if (b.length < off + 4 + len) return;                                        // wait for the rest of the frame
      const mask = b.subarray(off, off + 4); off += 4;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + i] ^ mask[i & 3];
      this.buf = b.subarray(off + len);
      if (!this._frame(fin, op, payload)) return;
    }
  }

  _frame(fin, op, payload) {
    if (op === 0x8) {                              // close: echo it, then tear down
      if (!this.closed) { this.closed = true; this._finish(encode(0x8, payload.subarray(0, 2))); }
      else this._dead();
      return false;
    }
    if (op === 0x9) {                              // ping → pong (we never send pings ourselves)
      if (!this.closed && !this.dead) { try { this.socket.write(encode(0xA, payload)); } catch { this._dead(); } }
      return true;
    }
    if (op === 0xA) return true;                   // pong: liveness comes from the game's "ping" text, nothing to do
    if (op === 0x0) {
      if (!this.frag) { this.close(1002, 'Unexpected continuation'); return false; }
      this.frag = Buffer.concat([this.frag, payload]);
    } else if (op === 0x1 || op === 0x2) {         // text / binary
      if (fin) { this._message(payload); return true; }
      this.frag = payload;
      return true;
    } else { this.close(1002, 'Unsupported opcode'); return false; }
    if (this.frag.length > FRAME_MAX) { this.close(1009, 'Message too big'); return false; }
    if (fin) { const m = this.frag; this.frag = null; this._message(m); }
    return true;
  }

  _message(buf) {
    this.seen = Date.now();
    if (buf.length > MSG_MAX) return;                                          // oversized: dropped, never fanned out
    const now = Date.now(), r = this.rate;
    if (now - r.t >= 1000) { r.strikes = r.n > RATE ? r.strikes + 1 : Math.max(0, r.strikes - 1); r.t = now; r.n = 0; }
    if (++r.n > RATE * 3 || r.strikes >= BURST_STRIKES) { this.close(4008, 'Too many messages'); return; }
    this.onMessage?.(buf.toString('utf8'));
  }
}

// ------------------------------------------------------------------ rooms
class Room {
  constructor(code) { this.code = code; this.members = []; this.locked = false; this.seq = 0; }
  live() { return this.members.filter((m) => !m.meta.gone && !m.dead); }
  hostId() { const m = this.live().slice().sort((a, b) => a.meta.seq - b.meta.seq)[0]; return m ? m.meta.id : null; }

  joinFrom() { const ms = this.members.slice().sort((a, b) => a.meta.seq - b.meta.seq); return ms.length ? ms[0].meta.id : null; }

  /** Remove a member and tell the rest (the relay's host is always the oldest surviving member). */
  leave(conn) {
    if (!conn || !conn.meta || conn.meta.gone) return;
    conn.meta.gone = true;
    this.members = this.members.filter((m) => !m.meta.gone && !m.dead);
    const out = JSON.stringify({ t: 'leave', id: conn.meta.id, host: this.joinFrom() });
    for (const m of this.members) m.send(out);
    if (!this.members.length) this.locked = false;
  }
}

/** The relay itself: membership, host election, join refusal and blind fan-out. */
export function createRelayHub({ log = () => {}, silentMatch = SILENT_MATCH, silentLobby = SILENT_LOBBY, sweep = SWEEP } = {}) {
  const rooms = new Map();
  const roomOf = (code) => { let r = rooms.get(code); if (!r) rooms.set(code, (r = new Room(code))); return r; };

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://relay');
    const deny = (status, body) => {
      try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); } catch { /* gone */ }
      socket.destroy();
    };
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]+)$/);
    if (!m) return deny('404 Not Found', 'INKWAVE relay');
    const key = req.headers['sec-websocket-key'];
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) return deny('426 Upgrade Required', 'expected websocket');
    const code = m[1].toUpperCase();
    if (!CODE.test(code)) return deny('400 Bad Request', 'bad code');

    // Complete the handshake even when the join is refused: the client waits for {"t":"err"} to learn why
    // (exactly what the Cloudflare Durable Object does), and its close reason carries the same message.
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);

    const conn = new Conn(socket, { onClose: (c) => { c.room?.leave(c); } });
    if (head && head.length) conn._feed(head);
    const refuse = (reason) => { conn.send(JSON.stringify({ t: 'err', e: reason })); conn.close(4000, reason); };

    const r = roomOf(code);
    const ms = r.live();
    const create = url.searchParams.get('create') === '1';
    if (+(url.searchParams.get('v') || 0) !== PROTO) return refuse('Please refresh the page — the game was updated');
    if (create && ms.length) return refuse('Room code taken');
    if (!create && !ms.length) return refuse('Room not found');
    if (ms.length >= MAX) return refuse('Room is full');
    if (r.locked && ms.length) return refuse('Match in progress');
    if (!ms.length) r.locked = false;

    const name = cleanName(url.searchParams.get('name'));
    let id;
    do { id = rid(); } while (ms.some((x) => x.meta.id === id));
    conn.meta = { id, name, seq: r.seq++, at: Date.now(), gone: false };
    conn.room = r;
    conn.seen = Date.now();
    r.members.push(conn);

    const all = r.members.slice().sort((a, b) => a.meta.seq - b.meta.seq);
    conn.send(JSON.stringify({ t: 'welcome', id, host: all[0].meta.id, members: all.map((x) => ({ id: x.meta.id, name: x.meta.name })) }));
    const j = JSON.stringify({ t: 'join', m: { id, name } });
    for (const x of all) if (x !== conn) x.send(j);
    log(`${code}  ${name} (${id}) ${create ? 'opened the room' : 'joined'} — ${all.length}/${MAX}`);

    conn.onMessage = (msg) => {
      const c = msg.charCodeAt(0);
      if (c === 98 /* b */ && msg.charCodeAt(1) === 124) {                      // "b|json" → everyone else
        const out = 'm|' + id + '|' + msg.slice(2);
        for (const x of r.members) if (x !== conn) x.send(out);
        return;
      }
      if (c === 115 /* s */ && msg.charCodeAt(1) === 124) {                     // "s|to|json" → one member
        const k = msg.indexOf('|', 2);
        if (k < 0) return;
        const to = msg.slice(2, k), out = 'm|' + id + '|' + msg.slice(k + 1);
        for (const x of r.members) if (x.meta.id === to) { x.send(out); break; }
        return;
      }
      if (msg === 'ping') { conn.send('pong'); return; }                        // also the liveness signal
      if (c === 123 /* { */) {
        let o; try { o = JSON.parse(msg); } catch { return; }
        if (o.t === 'ping') conn.send(JSON.stringify({ t: 'pong', c: o.c }));
        else if (o.t === 'lock' && r.joinFrom() === id) r.locked = !!o.v;
      }
    };
  }

  // A socket whose "ping"s stop is a dead player: drop them so their squidkid is handed to a bot (docs/NET.md).
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [code, r] of rooms) {
      const limit = r.locked ? silentMatch : silentLobby;
      for (const m of r.members) if (now - Math.max(m.meta.at || 0, m.seen || 0) > limit) { m.close(4001, 'Connection timed out'); r.leave(m); }
      if (!r.members.length) rooms.delete(code);
    }
  }, sweep);
  timer.unref?.();

  return {
    handleUpgrade,
    stats: () => [...rooms.values()].map((r) => ({ code: r.code, players: r.live().length, locked: r.locked })),
    closeAll: () => { clearInterval(timer); for (const r of rooms.values()) for (const m of r.members) m.close(1001, 'Relay stopped'); rooms.clear(); },
  };
}

/** Everything the relay answers outside an upgrade: /health plus a tiny status page (a handy reachability check). */
export function relayRequestHandler(hub, { name = 'INKWAVE LAN relay' } = {}) {
  return (req, res) => {
    const url = new URL(req.url || '/', 'http://relay');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    if (url.pathname.startsWith('/room/')) { res.writeHead(426, { 'content-type': 'text/plain' }); res.end('expected websocket'); return; }
    const rooms = hub.stats();
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${name}\n\n${rooms.length
      ? rooms.map((r) => `${r.code}  ${r.players} player${r.players === 1 ? '' : 's'}${r.locked ? '  (match running)' : ''}`).join('\n')
      : 'no open rooms'}\n`);
  };
}

// ------------------------------------------------------------------ standalone: node tools/relay.mjs [port=8787]
export function startRelay(port = 8787, { host = '::', onLog = console.log } = {}) {
  return import('node:http').then(({ createServer }) => {
    const hub = createRelayHub({ log: (m) => onLog(`  ${m}`) });
    const server = createServer(relayRequestHandler(hub));
    server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
    server.listen({ port, host, ipv6Only: false });
    server.on('error', (e) => { onLog(`[relay] ${e.code === 'EADDRINUSE' ? `port ${port} is already in use` : e.message}`); process.exitCode = 1; });
    return { hub, server };
  });
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { networkInterfaces } = await import('node:os');
  const port = +(process.argv[2] || process.env.PORT || 8787);
  const ips = new Set();
  for (const i of Object.values(networkInterfaces()).flat()) if (i && i.family === 'IPv4' && !i.internal) ips.add(i.address);
  const { server } = await startRelay(port, { onLog: (m) => console.log(m) });
  server.on('listening', () => {
    console.log(`INKWAVE relay  (rooms + /health, no internet needed)`);
    console.log(`  this machine : ws://localhost:${port}`);
    for (const ip of ips) console.log(`  your network : ws://${ip}:${port}`);
    console.log(`  the game finds it automatically at ws://<page host>:8787, or point it with ?relay=ws://<address>:${port}`);
    console.log(`  tip: node tools/serve.mjs serves the game and this relay on one port instead`);
  });
  const stop = () => { try { server.close(); } catch { /* */ } setTimeout(() => process.exit(0), 100).unref?.(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
