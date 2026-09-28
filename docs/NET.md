# Online play — session contract (`G.net`)

Private rooms with a 5-character code, up to 8 players (4 v 4, empty slots optionally filled with bots). The room
creator is the **host**: their browser runs the bots, the match clock and the final judge. Every player simulates their
own squidkid locally (instant controls) and streams it to the others, who render it through the same animation system
as a local character, interpolated ~100 ms behind. Ink is replicated splat-for-splat from whoever painted it, so every
screen shows the same turf.

Transport: one WebSocket per player to a room relay — the public Cloudflare Worker (`server/`, one Durable Object per
code) or, for LAN play, the dependency-free Node relay in `tools/relay.mjs`, which speaks the same protocol. Which
address a screen uses is decided by `src/net/transport.js` (see [Relays and addresses](#relays-and-addresses)).

## `G.net` — the session (src/net/session.js)

```js
G.net.state      // 'offline' | 'connecting' | 'lobby' | 'starting' | 'match' | 'error'
G.net.code       // 'K7QXM' while in a room, else null
G.net.relay      // the relay address this room is on ('ws://192.168.1.5:8490'), else null
G.net.myId       // this player's id in the room
G.net.hostId
G.net.isHost     // boolean
G.net.error      // last error message (string) or null
G.net.lobby = {
  map: 'tidewater', time: 'day' | 'dusk', duration: 180, bots: true, difficulty: 'normal',
  players: [{ id, name, team: 0 | 1, weapon, style, ready, host, you, ping }],   // stable order: join order
  maxPlayers: 8,
}

// actions (all safe to call in any state; invalid ones are ignored)
await G.net.create(name)          // → code; state goes connecting → lobby (you are host)
await G.net.join(code, name)      // rejects with Error('Room not found' | 'Room is full' | 'Match in progress' | 'Could not connect')
G.net.leave()                     // back to 'offline'
G.net.setMe({ name, weapon, style, ready, team })   // any subset; team: 0 | 1 | 'auto'
G.net.setSettings({ map, time, duration, bots, difficulty })   // host only
G.net.canStart()                  // host: true when everyone present is ready (host counts as ready)
G.net.start()                     // host only → state 'starting' for everyone, then 'match'
G.net.emote(name)                 // 'booyah' | 'wave' | 'dance' | 'flex' — shown on your lobby character for everyone
G.net.on(event, fn) → unsubscribe
//   'state'  { state }                 any state change
//   'lobby'  { lobby }                 settings / players changed (fires after join / leave / setMe / setSettings)
//   'join'   { player }                'leave' { player, reason }       'host' { hostId }   (host migrated)
//   'emote'  { id, name }              'error'  { message }
//   'match'  { phase: 'start' | 'end' }  match launched / ended (results shown, then everyone returns to 'lobby')
```

Rules the UI can rely on:
- `lobby.players` always contains you (`you: true`) while in a room; the host is `host: true`.
- Teams are kept balanced by the host (≤ 4 per team). `setMe({ team })` is a request; the host may refuse.
- `start()` launches the match on every client; the menus should hide themselves when `state === 'match'` (main.js
  also does it). When the match's results finish, everyone returns to the lobby screen with `state === 'lobby'`.
- A player leaving mid-match is replaced by a bot on the same actor; if the host leaves, the room migrates to the next
  player (bots and clock move with it).
- Your locker look (`profile.style`) and loadout weapon (`profile.weapon`) are sent automatically on join; call
  `setMe` again when they change in the lobby.

## How the netcode works (src/net/netmatch.js)

**Ownership.** Every squidkid has one owner: players own themselves, the host owns the bots and runs the match clock
and the judge. Owners simulate at full frame rate and stream a 20 Hz tick (`{k:'t', ts, a:[packed actors], e:[events]}`)
through the relay; nobody else ever simulates someone else's squidkid. A player who leaves (or whose connection dies)
is adopted by the host as a bot, starting exactly where everyone last saw it; when the host leaves, the oldest
remaining player becomes host and adopts the bots, clock and judge.

**Timeline.** For each sender there is one playback clock in the sender's time, running a little behind "now":
- *offset* — the fastest packet seen sets the clock offset (network floor); it creeps up slowly for drift;
- *delay* — one tick of buffer plus 2.5 × the measured jitter, clamped to 85–300 ms and eased;
- the clock advances with this client's own frame time and steers toward `now − offset − delay` at ±20–25 %, so a
  local hitch never makes remote squidkids leap, and it slows (down to 0.35×) when the sender's samples are about
  to run out instead of running off the end of the path.

**Path.** Positions are a cubic Hermite through the owner's samples using the owner's velocities (C1: no corners at
tick boundaries); vertical motion never dips through a floor either end stands on. Past the newest sample it
extrapolates ballistically for at most 180 ms, then holds. A teleport counter (`netTp`, bumped on respawn) makes
proxies cut instead of gliding across the map; a respawning squidkid stays hidden until its new life's first sample.

**Corrections.** The only discontinuities are new data rewriting a moment already shown (leaving an extrapolation,
an ownership handoff). Each frame the path is re-evaluated at last frame's time; any difference is carried as an
offset that settles on a critically damped curve (ω = 13), so nothing pops and nothing lurches.

**Animation.** Remote squidkids run the same `_finishFrame` / character animation as local ones, fed from the
replicated state (form, grounded, climbing, weapon pose flags, turn rate) plus the owner's animation triggers and
events (`['tr' …]`, `['ev' …]`) played on the same timeline, so a remote roller flick or dodge roll is the real clip.

**Ink and hits.** Every splat is sent by whoever painted it and replayed exactly (seeded shape), so all screens show
the same turf; other players' shots are visual-only ghosts. Hits are decided by the shooter's screen and applied by
the victim's owner (`{k:'hit'}`); splats, specials and respawns are forwarded as events. The host's final count is the
result on every screen.

**Relay (server/, tools/relay.mjs).** One room per code: membership, host election, join refusal (unknown / full /
match running) and blind fan-out of `b|` / `s|to|` payloads. Clients send `"ping"` every 2 s, answered without waking
the room; a sweep drops sockets silent for 20 s during a match (150 s in the lobby). The Worker implementation keeps a
Durable Object per code and hibernates when quiet; `tools/relay.mjs` keeps rooms in memory (they end when the relay
does) and needs no account, no internet and no dependencies, which is what makes LAN play work offline.

**Testing.** `npm run lan-test` (no browser, no internet) checks the relay protocol — create / join / refusals / host
election / fan-out / lock / ping / liveness sweep / rate and size caps — the game's own address picking and a real
room handshake through `Transport`, and `tools/serve.mjs` serving the game and the relay on one port.
`node tools/net-test.mjs` (game on :8490, `cd server && npx wrangler dev --port 8787`) plays real headless
clients against the local relay and reports consistency (clock, coverage, rosters, results) and what is drawn:
per-frame "kink" and path error of every remote squidkid against its owner's own frames.
`--clients 3 --leave host --drop kill|freeze` tests migration, `--full` plays through results back to the lobby,
`--net "netlag=40&netjitter=30&netspike=0.01"` simulates a real connection, `WORST=8` explains the worst frames.

## Relays and addresses

`src/net/transport.js` picks the relay, best first, and always says which one answered (`Transport.url` →
`G.net.relay`):

1. `?relay=…`, else `localStorage['inkwave.relay']` (the online screen's **LAN RELAY** row, `relayOverride()` /
   `setRelayOverride()`) — `normalizeRelay()` accepts `192.168.1.9`, `box.local:8490`, `ws://…` and `wss://…`, and
   fills in the page's own port when none is typed; `auto`/empty clears it;
2. the page's own origin (`ws(s)://<page host>:<page port>`) — what `tools/serve.mjs` provides, so **any** address the
   page is reachable at is also the relay address: real LANs, virtual LANs (Tailscale `100.x`, ZeroTier, Radmin `26.x`,
   Hamachi `25.x`), IPv6 literals and `.local` names;
3. `ws://<page host>:8787` — a standalone `npm run relay`;
4. the public Worker (`wss://inkwave-net.inkwave.workers.dev`).

A candidate that doesn't answer (refused connection, no WebSocket upgrade, timeout) falls through to the next one; a
relay that answers with a refusal ("Room not found", "Room is full", "Match in progress", …) is authoritative — the
game reports that and stops, so two players can never be split across different relays by a fallback. `?relay=` and the
stored address are the escape hatch for a page hosted somewhere the relay isn't (a static host, or another machine's
LAN address) and for pointing every player at the same machine. Everyone in a room must be on the same relay; the usual
way is the simplest one — everybody opens the host's URL (`npm start`).

## Showcase lobby set (src/game/showcase.js)

Both online screens are staged in the **lobby set** (`src/game/lobbySet.js`, a back alley at blue hour after rain; its own
scene and lights), which the showcase draws full-frame. `showcase.fullFrame` is true while the set covers the whole
screen: main.js then skips drawing and simulating the world (the showcase clears the canvas and draws the frame itself).
It is false during the set's ~0.45 s cross-dissolves (to / from the world, the loadout / locker pedestal, the results
podium), which need the live world underneath. The set is built lazily on the first `showHub` / `showLobby`, parked
(not drawn) through locker trips and whole matches, and released ~1.5 s after the online screens are left for good.

`showcase.showHub(style, color, weapon)` — your squidkid on the set's hub spot, framed right of the create / join cards
(it bursts out of an ink puddle when the alley first comes up; look / weapon changes get the pedestal's reactions).
`showcase.showLobby(players, colors, { reduced })` — the room: the set's camera glides from the hub framing to the
line-up while you duck into the ink and burst out of a puddle on your mark (front centre); whoever is already in the
room surfaces on their marks right after you. `showcase.updateLobby(players, colors)` diffs the list:
- **join** → the squidkid swims in from the alley mouth along `set.lanes(mark)` (a low, fast squid swim laying a wet
  ink trail in its team colour; rivals hop up the dock stairs), leaps out as a kid, splashes down on its mark and turns
  to camera; several joins are spaced out; paths steer round kids already standing;
- **leave** → it turns, dives into its own ink and swims out along `set.exitPath(mark)`;
- **team change** → swims from its old mark to the new one (out along its exit path, in along the new lane); when *you*
  change teams everyone ducks through the ink and resurfaces on the other side;
- weapon / look swaps and ready / unready get a reaction on the spot (queued until landing for a kid still arriving).

`showcase.lobbyEmote(id, name)`, `lobbyGetSet()` (countdown: everyone squares up, the camera leans in),
`lobbyLaunch()` → seconds (everyone super-jumps out, front centre first), `lobbyAnchor(id, out)` → screen point above
a player's head for the DOM nameplate — it follows the squid while it swims in (`out.vis` 0 while hidden or when the
point would sit under a UI panel), `lobbySlotAnchor(row, i, out)` (unclaimed marks → "OPEN" / "BOT" plates),
`leaveLobby()` (the others duck away; your kid stays and heads back to the hub spot on `showHub`). Coming back to the
room (locker, a match) finds everyone already standing on their marks: arrivals never replay. `opts.quick` is still
accepted and no longer needed. Audits: `showcase.debugCam = { pos, target, fov }` overrides the set camera.
