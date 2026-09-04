/* 3Dconnexion SpaceMouse input for the viewport.
 *
 * Transport is WebHID first (Chrome / Edge / Opera on macOS, Windows and Linux —
 * no driver needed) with a best-effort Gamepad API fallback for browsers that lack
 * WebHID but enumerate the puck as a multi-axis joystick.
 *
 * The module knows nothing about Three.js or the DOM beyond `navigator`; the report
 * parser and axis shaping are pure functions so they can be unit-tested under node.
 *
 * Wire protocol (shared by the whole 3Dconnexion line, see spacenavd / pyspacemouse):
 *   report 1  6 bytes   tx ty tz               int16 LE, full scale ≈ ±350
 *   report 1  12 bytes  tx ty tz rx ry rz      newer firmware sends both in one report
 *   report 2  6 bytes   rx ry rz
 *   report 3  1–4 bytes button bitmask, LE      bit 0 = MENU, bit 1 = FIT on every model
 * A released cap reports all-zero, but we also treat silence as zero (see STALE_MS)
 * so a yanked cable can never leave the camera drifting.
 */

/** Vendor ids: 0x046d while 3Dconnexion was part of Logitech, 0x256f after the spin-out. */
export const VENDOR_IDS = [0x046d, 0x256f];

/** HID usage page 0x01 (Generic Desktop) / usage 0x08 = Multi-axis Controller: the 3D-mouse
 *  collection itself, so the browser's picker never lists ordinary Logitech mice/keyboards. */
export const HID_FILTERS = VENDOR_IDS.map((vendorId) => ({ vendorId, usagePage: 0x01, usage: 0x08 }));

const PRODUCTS = {
  0xc603: 'SpaceMouse Plus', 0xc605: 'CADman', 0xc606: 'SpaceMouse Classic',
  0xc621: 'SpaceBall 5000', 0xc623: 'SpaceTraveler', 0xc625: 'SpacePilot',
  0xc626: 'SpaceNavigator', 0xc627: 'SpaceExplorer', 0xc628: 'SpaceNavigator for Notebooks',
  0xc629: 'SpacePilot Pro', 0xc62b: 'SpaceMouse Pro', 0xc62e: 'SpaceMouse Wireless',
  0xc62f: 'SpaceMouse Wireless (receiver)', 0xc631: 'SpaceMouse Pro Wireless',
  0xc632: 'SpaceMouse Pro Wireless (receiver)', 0xc633: 'SpaceMouse Enterprise',
  0xc635: 'SpaceMouse Compact', 0xc636: 'SpaceMouse Module', 0xc638: 'SpaceMouse Pro Wireless BT',
  0xc63a: 'SpaceMouse Wireless BT', 0xc652: 'Universal Receiver',
};

/** Human name for a vendor/product pair, falling back to the hex ids. */
export function productName(vendorId, productId, fallback) {
  const known = PRODUCTS[productId];
  if (known) return known;
  if (fallback) return fallback;
  return `3Dconnexion ${(vendorId ?? 0).toString(16).padStart(4, '0')}:${(productId ?? 0).toString(16).padStart(4, '0')}`;
}

/** Raw full-scale deflection of a modern puck (older SpaceBalls run hotter; values are clamped). */
export const FULL_SCALE = 350;

/**
 * Sign convention applied to the raw HID axes so the result reads as a physical frame:
 * x = +right, y = +forward (push the cap away from you), z = +up (lift the cap),
 * rz = +twist counter-clockwise seen from above. This is the spacenavd / pyspacemouse
 * convention; individual devices and hands disagree, which is why the UI has per-axis invert.
 */
export const FRAME = { x: 1, y: -1, z: -1, rx: -1, ry: -1, rz: 1 };

export const AXES = ['x', 'y', 'z', 'rx', 'ry', 'rz'];

const clamp1 = (v) => Math.max(-1, Math.min(1, v));

function int16(view, off) {
  return off + 1 < view.byteLength ? view.getInt16(off, true) : 0;
}

/**
 * Parse one HID input report. `bytes` is the report payload without the id byte
 * (exactly what WebHID's `inputreport` event hands over as `event.data`).
 * Returns `{ axes: {x,y,z,rx,ry,rz…} }` for motion (only the axes the report carries,
 * already normalised to ±1 in the FRAME convention), `{ buttons }` for a button
 * bitmask, or null for anything else (battery, LCD, vendor chatter).
 */
export function parseReport(reportId, bytes) {
  const view = bytes instanceof DataView
    ? bytes
    : new DataView(bytes.buffer, bytes.byteOffset ?? 0, bytes.byteLength);
  const norm = (off, key) => clamp1((int16(view, off) / FULL_SCALE) * FRAME[key]);

  if (reportId === 1) {
    const axes = { x: norm(0, 'x'), y: norm(2, 'y'), z: norm(4, 'z') };
    if (view.byteLength >= 12) {
      axes.rx = norm(6, 'rx'); axes.ry = norm(8, 'ry'); axes.rz = norm(10, 'rz');
    }
    return { axes };
  }
  if (reportId === 2) {
    return { axes: { rx: norm(0, 'rx'), ry: norm(2, 'ry'), rz: norm(4, 'rz') } };
  }
  if (reportId === 3) {
    let buttons = 0;
    for (let i = 0; i < Math.min(4, view.byteLength); i++) buttons |= view.getUint8(i) << (8 * i);
    return { buttons: buttons >>> 0 };
  }
  return null;
}

/**
 * Dead-zone + quadratic response: tiny cap pressure does nothing, moderate pressure is
 * fine-grained, a hard shove goes fast. Sign-preserving, output in ±1.
 */
export function shapeAxis(v, deadzone = 0.05) {
  const m = Math.abs(v);
  if (!(m > deadzone)) return 0;
  const t = Math.min(1, (m - deadzone) / (1 - deadzone));
  return Math.sign(v) * t * t;
}

/** Does a Gamepad API id string look like a 3Dconnexion puck? */
export function looksLikeSpaceMouse(id) {
  if (!id) return false;
  const s = String(id).toLowerCase();
  return /3dconnexion|spacemouse|spacenavigator|spacepilot|spaceexplorer|spaceball/.test(s)
    || /vendor:\s*0?(46d|256f)\b/.test(s);
}

/** A cap that has gone quiet for this long is treated as released. */
export const STALE_MS = 150;

/**
 * Create the input source. Call `autoConnect()` once at startup (re-opens devices the
 * user granted earlier), `request()` from a click handler to pair a new device, and
 * `poll(now)` once per animation frame to get the current shaped axes (or null when idle).
 */
export function createSpaceMouse({ onStatus, onButton, onAxes, disableHid = false } = {}) {
  const hid = typeof navigator !== 'undefined' && !disableHid ? navigator.hid : undefined;
  const hasGamepad = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';

  const state = {
    x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0,
    buttons: 0,
    at: 0,                 // performance.now() of the last motion report
    transport: null,       // 'hid' | 'gamepad' | null
    name: '',
    device: null,          // HIDDevice while connected over WebHID
  };
  const listeners = new Set();
  let gamepadIndex = -1;
  let lastGamepadScan = 0;

  const emitStatus = () => onStatus?.({ connected: !!state.transport, transport: state.transport, name: state.name });

  function setButtons(mask) {
    const prev = state.buttons;
    if (mask === prev) return;
    state.buttons = mask;
    for (let i = 0; i < 32; i++) {
      const was = (prev >>> i) & 1, now = (mask >>> i) & 1;
      if (was !== now) onButton?.(i, !!now);
    }
  }

  function applyAxes(axes, now) {
    for (const k of AXES) if (k in axes) state[k] = axes[k];
    state.at = now;
    onAxes?.(state);
  }

  // ---- WebHID

  async function attach(device) {
    if (state.device === device) return true;
    try {
      if (!device.opened) await device.open();
    } catch (e) {
      onStatus?.({ connected: false, transport: null, name: '', error: e.message || String(e) });
      return false;
    }
    detach(false);
    state.device = device;
    state.transport = 'hid';
    state.name = productName(device.vendorId, device.productId, device.productName);
    const onReport = (ev) => {
      const r = parseReport(ev.reportId, ev.data);
      if (!r) return;
      if (r.axes) applyAxes(r.axes, performance.now());
      if (r.buttons !== undefined) setButtons(r.buttons);
    };
    device.addEventListener('inputreport', onReport);
    listeners.add(() => device.removeEventListener('inputreport', onReport));
    emitStatus();
    return true;
  }

  function detach(announce = true) {
    for (const off of listeners) off();
    listeners.clear();
    const dev = state.device;
    state.device = null;
    if (state.transport === 'hid') { state.transport = null; state.name = ''; }
    for (const k of AXES) state[k] = 0;
    setButtons(0);
    if (dev?.opened) dev.close().catch(() => {});
    if (announce) emitStatus();
  }

  const isPuck = (d) => VENDOR_IDS.includes(d.vendorId)
    && (d.collections || []).some((c) => c.usagePage === 0x01 && c.usage === 0x08);

  /** Re-open any puck the user already granted (no gesture needed) and watch for hot-plug. */
  async function autoConnect() {
    if (!hid) return false;
    hid.addEventListener?.('connect', (e) => { if (isPuck(e.device) && !state.device) attach(e.device); });
    hid.addEventListener?.('disconnect', (e) => { if (e.device === state.device) detach(); });
    try {
      const devices = await hid.getDevices();
      for (const d of devices) if (isPuck(d) && await attach(d)) return true;
    } catch (e) {
      onStatus?.({ connected: false, transport: null, name: '', error: e.message || String(e) });
    }
    return false;
  }

  /** Ask the browser for a device. Must be called from a user gesture (click). */
  async function request() {
    if (!hid) throw new Error('WebHID is not available in this browser (use Chrome, Edge or Opera over localhost/https)');
    const devices = await hid.requestDevice({ filters: HID_FILTERS });
    if (!devices.length) return false;
    return attach(devices[0]);
  }

  /** Drop the HID device (the browser keeps the permission; the device is forgotten from the picker only via `forget`). */
  async function disconnect() {
    const dev = state.device;
    detach();
    if (dev?.forget) { try { await dev.forget(); } catch { /* older Chrome */ } }
    gamepadIndex = -1;
    if (state.transport === 'gamepad') { state.transport = null; state.name = ''; emitStatus(); }
  }

  // ---- Gamepad fallback (Firefox etc.; also Chrome when the OS driver is absent)

  function pollGamepad(now) {
    if (!hasGamepad) return;
    let gp = gamepadIndex >= 0 ? navigator.getGamepads()[gamepadIndex] : null;
    if (!gp || !gp.connected) {
      gamepadIndex = -1;
      if (state.transport === 'gamepad') { state.transport = null; state.name = ''; emitStatus(); }
      if (now - lastGamepadScan < 1000) return;      // cheap rescan once a second
      lastGamepadScan = now;
      for (const g of navigator.getGamepads()) {
        if (g && g.connected && g.axes.length >= 6 && looksLikeSpaceMouse(g.id)) { gp = g; gamepadIndex = g.index; break; }
      }
      if (!gp) return;
      state.transport = 'gamepad';
      state.name = gp.id.replace(/\s*\(.*$/, '').replace(/^3dconnexion\s*/i, '') || 'SpaceMouse (gamepad)';
      emitStatus();
    }
    const ax = {};
    AXES.forEach((k, i) => { ax[k] = clamp1((gp.axes[i] || 0) * FRAME[k]); });
    applyAxes(ax, now);
    let mask = 0;
    gp.buttons.forEach((b, i) => { if (b.pressed && i < 32) mask |= 1 << i; });
    setButtons(mask >>> 0);
  }

  /**
   * Per-frame read. Returns `{x,y,z,rx,ry,rz}` shaped through the dead-zone curve, or
   * null when nothing is deflected (or nothing is connected).
   */
  function poll(now = performance.now(), { deadzone = 0.05 } = {}) {
    if (!state.device) pollGamepad(now);
    if (!state.transport) return null;
    if (now - state.at > STALE_MS) return null;
    const out = {};
    let any = false;
    for (const k of AXES) { out[k] = shapeAxis(state[k], deadzone); if (out[k]) any = true; }
    return any ? out : null;
  }

  return {
    state,
    supported: { hid: !!hid, gamepad: hasGamepad },
    autoConnect, request, disconnect, poll,
  };
}
