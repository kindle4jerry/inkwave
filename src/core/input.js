// Keyboard + mouse (pointer lock) + standard gamepad. Produces a unified per-frame snapshot.
// Gamepad: radial dead zone + response curve sticks (padStick) and subtle dual-rumble (rumble), scaled by
// settings.rumble (0..1, default 1) and only while the pad is the active device.
import { G } from './ctx.js';

// keys whose browser default (focus moves, page scroll) must never fire while the game has the mouse
const GAME_KEYS = new Set(['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'Quote']);

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();       // keys pressed this frame
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false, rightPressed: false };
    this.locked = false;
    this.enabled = true;
    this.wantLock = false;          // the game asked for the mouse and hasn't been given it (see requestLock)
    this.lockError = false;         // …and the last request was refused (no user gesture / document not active / blocked)
    this.lockTries = 0;             // requests made for the current round (a retry after a click means the browser said no)
    this.relockAllowed = null;      // () => bool, set by main.js: is a live round on screen that wants the pointer?
    this.pad = null;
    this.padPrev = [];
    this.padPressed = new Set();
    this.lastDevice = 'kbm';
    this.onKey = null;              // (e) => bool consumed  (menus)
    window.addEventListener('keydown', (e) => {
      // the menus call preventDefault themselves when needed (text fields must still receive keystrokes)
      // auto-repeat must be swallowed too: holding TAB for the map used to let the repeats move browser focus off the
      // canvas → pointer lock dropped → the round paused ("opening the map opens the menu")
      if (e.repeat) {
        if (e.code === 'Tab' || (this.locked && GAME_KEYS.has(e.code))) e.preventDefault();
        if (this.onKey) this.onKey(e, true);
        return;
      }
      this.lastDevice = 'kbm';
      if (this.onKey && this.onKey(e, false)) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (GAME_KEYS.has(e.code) && this.locked) e.preventDefault();
      if (e.code === 'Tab') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX; this.mouse.dy += e.movementY;
      this.lastDevice = 'kbm';
    });
    window.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockerror', () => { if (!this.locked) this.lockError = true; });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (this.locked) { this.lockError = false; this.lockTries = 0; }
      if (!this.locked) { this.mouse.left = this.mouse.right = false; this.onUnlock?.(); }
    });
    // Pointer lock needs transient activation plus an active document, so a round that starts from a *network*
    // message — an online guest's "go" over the relay — cannot take the mouse on its own. The player's next click or
    // key press is the gesture that does it (the HUD asks for exactly that while the mouse is not captured), and the
    // same path covers a lock that was refused because the window was in the background. Gated by relockAllowed so
    // nothing grabs the pointer while a menu is up.
    const grab = () => {
      if (!this.wantLock || this.locked) return;
      if (this.relockAllowed && !this.relockAllowed()) return;
      this.requestLock();
    };
    window.addEventListener('pointerdown', grab, true);
    window.addEventListener('keydown', grab, true);
  }

  // Ask for the pointer. Chrome only grants this with transient user activation (and an active document), which the
  // caller cannot know: a refusal leaves wantLock set, so the next click or key press retries (see the grab listener)
  // and the HUD can tell the player to click.
  requestLock() {
    this.wantLock = true;
    if (this.locked) return;
    this.lockTries++;
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch((e) => {
        // a platform that has no raw-input option rejects the option itself — retry plainly; a refusal because the
        // document has no user activation is left to the next click or key press (the grab listener above)
        if (e && (e.name === 'TypeError' || e.name === 'NotSupportedError')) this._plainLock();
        else this.lockError = true;
      });
    } catch { this.lockError = true; }
  }
  _plainLock() {
    try {
      const q = this.canvas.requestPointerLock();
      if (q && q.catch) q.catch(() => { this.lockError = true; });
    } catch { this.lockError = true; }
  }
  exitLock() { this.wantLock = false; this.lockTries = 0; this.lockError = false; if (document.pointerLockElement) document.exitPointerLock(); }

  down(code) { return this.keys.has(code); }
  wasPressed(code) { return this.pressed.has(code); }

  pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) if (p && p.connected && p.mapping === 'standard') { pad = p; break; }
    if (!pad) for (const p of pads) if (p && p.connected) { pad = p; break; }
    this.pad = pad;
    this.padPressed.clear();
    if (!pad) return;
    pad.buttons.forEach((b, i) => {
      const was = this.padPrev[i] || false;
      if (b.pressed && !was) { this.padPressed.add(i); this.lastDevice = 'pad'; }
      this.padPrev[i] = b.pressed;
    });
    const ax = pad.axes;
    if (Math.abs(ax[0]) > 0.3 || Math.abs(ax[1]) > 0.3 || Math.abs(ax[2]) > 0.3 || Math.abs(ax[3]) > 0.3) this.lastDevice = 'pad';
  }
  padButton(i) { return !!(this.pad && this.pad.buttons[i] && this.pad.buttons[i].pressed); }
  padValue(i) { return this.pad && this.pad.buttons[i] ? this.pad.buttons[i].value : 0; }
  padAxis(i) {
    if (!this.pad) return 0;
    const v = this.pad.axes[i] || 0;
    const dz = 0.14;
    return Math.abs(v) < dz ? 0 : Math.sign(v) * (Math.abs(v) - dz) / (1 - dz);
  }

  // Stick with a RADIAL dead zone (no axis snapping on diagonals), an outer dead zone (full deflection is reachable
  // on worn sticks) and an optional response exponent applied to the magnitude only (direction is preserved).
  padStick(ix, iy, out, dz = 0.12, outer = 0.96, expo = 1) {
    out.x = 0; out.y = 0; out.mag = 0;
    if (!this.pad) return out;
    const x = this.pad.axes[ix] || 0, y = this.pad.axes[iy] || 0;
    const m = Math.hypot(x, y);
    if (m <= dz) return out;
    const k = Math.min(1, (m - dz) / (outer - dz));
    const c = expo === 1 ? k : Math.pow(k, expo);
    out.x = (x / m) * c; out.y = (y / m) * c; out.mag = c;
    return out;
  }

  // Dual-rumble pulse. strong = low-frequency motor, weak = high-frequency motor (0..1), ms = duration.
  // A pulse only pre-empts a running one if it is at least as strong, so rapid fire never becomes a constant buzz.
  rumble(strong, weak, ms = 60) {
    const pad = this.pad;
    if (!pad || this.lastDevice !== 'pad') return;
    const k = G.settings?.rumble ?? 1;
    if (!(k > 0)) return;
    const act = pad.vibrationActuator;
    if (!act || !act.playEffect) return;
    const now = performance.now();
    const mag = Math.max(strong, weak) * k;
    if (now < (this._rumbleUntil || 0) && mag < (this._rumbleMag || 0) * 0.95) return;
    this._rumbleUntil = now + ms; this._rumbleMag = mag;
    try {
      const p = act.playEffect('dual-rumble', { startDelay: 0, duration: Math.round(ms), strongMagnitude: Math.min(1, strong * k), weakMagnitude: Math.min(1, weak * k) });
      if (p && p.catch) p.catch(() => {});
    } catch { /* unsupported */ }
  }

  // Call once at the very end of each frame.
  endFrame() {
    this.pressed.clear();
    this.mouse.dx = 0; this.mouse.dy = 0;
    this.mouse.leftPressed = false; this.mouse.rightPressed = false;
  }
}
