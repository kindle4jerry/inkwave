<p align="center">
  <img src="assets/stages/halyard-day.webp" alt="Halyard Marina at golden hour" width="100%">
</p>

<h1 align="center">INKWAVE</h1>

<p align="center">
  An original Splatoon-style 4v4 turf-war shooter that runs in your browser.<br>
  Paint the ground, swim through your ink, out-turf the other team.
</p>

<p align="center">
  <a href="https://inkwave-aah.pages.dev"><b>▶ Play now</b></a> ·
  <a href="#controls">Controls</a> ·
  <a href="#playing-online">Online</a> ·
  <a href="#running-locally">Run locally</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/jaydendavisnc/inkwave/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jaydendavisnc/inkwave/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="three.js r186" src="https://img.shields.io/badge/three.js-r186-000000?logo=three.js&logoColor=white">
  <img alt="No build step" src="https://img.shields.io/badge/build-none%20needed-2ea44f">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

---

## Features

- **Turf war, 4 v 4.** Three minutes, most ground painted wins. Play against bots on three difficulty levels.
- **Online with friends.** Create a private room, share the five-character code, and up to eight players line up in the lobby with their loadouts and looks. Empty slots fill with bots; if someone drops, a bot takes over their squidkid mid-match.
- **Squid form.** Hold to dive into your ink: swim fast, refill your tank, climb inked walls, dolphin-jump water gaps.
- **Seven weapons**, each with its own feel: Spritzer (shooter), Swell Roller, Glint Charger, Popper Blaster, Twinfin Dualies (dodge roll), Tidebucket Slosher and Gyre Splatling. Every kit comes with Splat Bombs and a special.
- **Three stages, day or dusk.** Tidewater Plaza, Kelpline Terminal and Halyard Marina, a working marina with a car ferry moored across the middle where the water gaps are the whole point.
- **Ink that behaves like liquid.** Splats spread and settle, fresh ink is glossy and dries, drips run down walls, and swimming leaves a wake in the surface itself.
- **A map you can actually read.** Hold <kbd>Tab</kbd> and the camera cranes up into a tilt-shift diorama of the live stage, with pins for your team and one-click Super Jumps.
- **Locker.** Choose your squidkid: tentacle style, headgear, face, outfit.
- **Everything procedural.** Characters, animation, weapons, textures, props, sound effects and music are all generated in code. There are no downloaded assets except two fonts.

<p align="center">
  <img src="assets/stages/tidewater-day.webp" width="49%" alt="Tidewater Plaza">
  <img src="assets/stages/kelpline-dusk.webp" width="49%" alt="Kelpline Terminal at dusk">
</p>

## Controls

| Action | Keyboard / mouse | Gamepad |
|---|---|---|
| Move | <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> | Left stick |
| Aim | Mouse | Right stick |
| Fire | Left click | RT |
| Squid form | <kbd>Shift</kbd> | LT |
| Jump / dodge roll | <kbd>Space</kbd> | A |
| Sub weapon (bomb) | Right click / <kbd>E</kbd> | RB |
| Special | <kbd>F</kbd> | Y |
| Map + Super Jump | Hold <kbd>Tab</kbd> or <kbd>M</kbd>, then <kbd>1</kbd>–<kbd>4</kbd> or click a pin | View |
| Pause | <kbd>Esc</kbd> | Start |

Gamepads work on the hosted (https) version. On a plain `http://` LAN address browsers block the Gamepad API.

## Playing online

From the main menu choose **Online**, then **Create a room** and send your friends the code (or **Join a room** and
type theirs). The host picks the stage, time of day, match length and whether bots fill empty slots; everyone else
picks a team, weapon and look and readies up. The lineup, emotes and ready state are live for everyone in the room.

Rooms run on a tiny relay: one process that tracks membership, elects the host and forwards messages. It only
forwards: every player simulates their own squidkid and streams it, and everyone else draws it through the same
animation system on a smoothed timeline about a tenth of a second behind. How that works, and the tools used to
measure it, are in [`docs/NET.md`](docs/NET.md).

### Playing on a LAN (no internet needed)

The public site uses the deployed Cloudflare relay, but the relay is also just a small Node process in
[`tools/relay.mjs`](tools/relay.mjs) — no dependencies, no account, no outbound connection. On one machine
(the host) run:

```bash
npm start                 # serves the game *and* the relay on http://<this machine>:8490
```

Everyone else opens `http://<the host's address>:8490` — the address printed by the server, over a real network or a
virtual one (Tailscale, ZeroTier, Radmin, Hamachi all work; so do `.local` names and IPv6). Because the game and the
relay are on the same address, there is nothing to configure: create a room, share the five-character code, play.
Test it without a browser with `npm run lan-test`.

If your friends really can't reach the page, allow `node.exe` through the Windows firewall (private networks) for
that port, or use `?relay=ws://<address>:8787` with a relay started separately by `npm run relay`. The online screen's
**LAN RELAY** row shows which address a screen is talking to and lets you type another one (no internet is ever
required for LAN play — if a room can't be reached, that row is the first thing to check).

**Can walk but can't aim or shoot?** A browser only hands the game the mouse (`pointer lock`) after the player
themselves clicks or presses a key, and an online round starts from a network message — so when the HUD says
*Click to take the mouse*, that one click (or any key) is all it takes. On Chrome 131+ a plain `http://` address may
also ask permission for pointer lock the first time; allow it once per machine. The machine serving the page never
sees this because `localhost` is trusted and its clicks come first.

To play online on the public internet, deploy the relay next to the game:

```bash
npm install      # once: the Worker relay runs on wrangler
npm run relay:worker   # local Worker relay on :8787, or: npm run deploy-relay
```

A page opened from `localhost` or a LAN address uses a local relay automatically; `?relay=wss://…` points it anywhere
else.

## Running locally

There is no build step. Any static file server works; the included one (`tools/serve.mjs`, Node, no dependencies) also
serves the relay on the same port and sends no-cache headers so module updates are never stale.

```bash
git clone https://github.com/jaydendavisnc/inkwave.git
cd inkwave
npm start        # http://localhost:8490 (+ your LAN addresses)
```

`npm start` needs nothing but Node. `npm run start:py` runs the equivalent Python server (`tools/serve.py`) if you
prefer it — that one serves only files, so run `npm run relay` next to it for rooms.

Useful URL parameters: `?map=halyard&time=dusk` picks a stage, `&autostart=180` skips the menus into a 180 s match,
`&autopilot` lets a bot drive you, `?relay=ws://host:8787` picks a relay.

```bash
npm install      # once, for the headless tools
npm run check    # syntax-check every module
npm run smoke    # boot + 8 s of autopilot in headless Chrome, fails on console errors
npm run lan-test # LAN rooms end to end: relay protocol, address picking, one-port server (no browser needed)
npm run build    # assemble dist/ (game + only the three.js addons it imports)
```

With the relay running, `npm run net-test` plays a real match between headless clients and reports what each
screen drew (see [`docs/NET.md`](docs/NET.md#how-the-netcode-works-srcnetnetmatchjs)).

## How it works

- **Ink is painted in texture space.** Every paintable face owns a region of one 4K atlas; splats are drawn into it on the GPU while a coarse CPU grid keeps the turf score and gameplay queries in sync. The level shader layers the ink over the surface with its own height, gloss and wetness. See [`src/world/paint.js`](src/world/paint.js) and [`src/world/inkShading.js`](src/world/inkShading.js).
- **Stages are data.** A layout is a list of boxes and ramps for one half of the arena; the other half is the 180° rotation, so both teams always get an identical field. Ambient occlusion is baked offline (`tools/bake-ao.mjs`). See [`src/world/maps.js`](src/world/maps.js).
- **Characters are fully procedural.** Geometry, materials, a 60-bone rig and every animation (locomotion, squid form, weapon poses, secondary motion) are code, driven by a spring-based pose system. See [`docs/RIG.md`](docs/RIG.md).
- **Systems talk through events.** Weapons, actors and the match emit typed events; effects, HUD and audio subscribe. The contract is documented in [`docs/EVENTS.md`](docs/EVENTS.md) and [`docs/CONTRACTS.md`](docs/CONTRACTS.md).
- **Deterministic tooling.** The game exposes a freeze/step debug interface so filmstrips, handling measurements and bot simulations are reproducible frame by frame (`tools/film.py`, `tools/measure-handling.mjs`).

Rendering is three.js r186 (vendored, plain ES modules with an import map) with GTAO, bloom and a custom grade pass.

## Browser support

Chrome and Edge are the target; Firefox works. Safari runs but is slower. A discrete or recent integrated GPU is recommended for the High preset; the settings menu has Medium and Low tiers.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and the checks to run first.

## License

[MIT](LICENSE) © 2026 Jayden Davis. INKWAVE is an independent project and is not affiliated with Nintendo; Splatoon is a trademark of Nintendo.
