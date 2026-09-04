/* 3Dconnexion driver transport: talk to 3DxWare's local Navigation Library server.
 *
 * When 3DxWare (the vendor driver) is installed it owns the puck outright, so WebHID
 * can't open it. The driver instead runs 3DxNLServer, a WAMP v1 WebSocket server on the
 * loopback alias 127.51.68.120, and does all navigation maths itself: it *reads* scene
 * properties from us (camera matrix, fov, model extents…) and *writes* back a new camera
 * matrix while the cap is deflected. This works with the driver present, on macOS and
 * Windows, in any browser that trusts the driver's certificate (the installer adds it).
 *
 * Wire format (reverse-engineered by the community; no vendor code is used here):
 *   GET  https://127.51.68.120:8181/3dconnexion/nlproxy   → { port, version }
 *   WSS  wss://127.51.68.120:<port>/  subprotocol "wamp"  → [0, session, 1, ident]
 *   [1, prefix, uri]                     CURIE prefixes
 *   [2, id, proc, ...args]               CALL      → [3, id, result] | [4, id, errUri, desc]
 *   [5, topic]                           SUBSCRIBE
 *   [8, topic, [2, id, "self:read"|"self:update", "", prop, value?]]
 *                                        server→client property calls, answered with [3, id, …]
 * The client must pump `frame.time` updates every animation frame while motion is on,
 * otherwise the driver never produces motion.
 */

const PROXY_HOST = '127.51.68.120';
export const NLPROXY_URL = `https://${PROXY_HOST}:8181/3dconnexion/nlproxy`;

const WELCOME = 0, PREFIX = 1, CALL = 2, CALL_RESULT = 3, CALL_ERROR = 4, SUBSCRIBE = 5, EVENT = 8;

const LAST_PORT_KEY = 'cadgang:navlib:lastPort';

/**
 * Is a 3Dconnexion driver running here? Resolves to { port, version } or null.
 * The discovery endpoint on 8181 drops out for a while after a session ends even though
 * the data port stays up, so on failure we retry briefly and then fall back to the port
 * that worked last time (it only changes when the driver restarts).
 */
export async function probeDriver({ timeoutMs = 1500, attempts = 3, delayMs = 700 } = {}) {
  if (typeof fetch !== 'function') return null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(NLPROXY_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.port === 'number') {
          try { localStorage.setItem(LAST_PORT_KEY, String(data.port)); } catch { /* storage blocked */ }
          return { port: data.port, version: String(data.version || '') };
        }
      }
    } catch { /* not answering (yet) */ }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  // Discovery is down: try the port that worked last time, then the driver's usual one.
  // A guessed port is only trusted once the WebSocket handshake actually succeeds.
  let last = null;
  try { last = Number(localStorage.getItem(LAST_PORT_KEY)) || null; } catch { /* storage blocked */ }
  return { port: last || DEFAULT_PORT, version: '', guessed: true };
}
const DEFAULT_PORT = 8182;

/**
 * Create a driver session.
 *   props    – { read(name) → value | undefined, write(name, value) }: the app's scene
 *              model. Unknown reads are answered as null, which the driver tolerates.
 *   onStatus – ({ connected, name, error }) on every state change
 *   onMotion – (moving: boolean) when the driver starts/stops driving the camera
 */
/** Node types of the driver's action tree (SiActionNodeType_t in the vendor SDK). */
export const NODE = { SET: 0, CATEGORY: 1, ACTION: 2 };

/**
 * Build the `commands` payload the driver wants: one action set holding categories of
 * actions. `sets` = [{ id, label, categories: [{ id, label, actions: [{ id, label, description }] }] }].
 * The driver lists these under the app's profile in 3Dconnexion Settings so the puck's
 * buttons can be mapped to them, and writes `commands.activeCommand = id` on a press.
 */
export function buildCommands(activeSet, sets) {
  const node = (type, n, nodes) => ({ type, id: n.id, label: n.label || n.id, description: n.description || '', ...(nodes ? { nodes } : {}) });
  return {
    activeSet,
    tree: {
      nodes: sets.map((set) => node(NODE.SET, set,
        (set.categories || []).map((cat) => node(NODE.CATEGORY, cat,
          (cat.actions || []).map((a) => node(NODE.ACTION, a)))))),
    },
  };
}

export function createNavlib({ props, onStatus, onMotion, appName = 'cadgang', appVersion = '0.8', commands = null, debug = false } = {}) {
  const log = debug ? (...a) => console.log('[navlib]', ...a) : () => {};
  let ws = null;
  let seq = 0;
  const pending = new Map();
  let instance = null;
  let controllerUri = null;
  let moving = false;
  let pumpId = 0;
  let version = '';
  let wanted = false;          // true between connect() and disconnect(): reconnect on drops
  let retryTimer = 0;
  let retryDelay = 1000;

  const state = { get connected() { return instance !== null; }, get moving() { return moving; }, get version() { return version; } };
  const emit = (extra = {}) => onStatus?.({ connected: instance !== null, name: `3DxWare driver${version ? ` ${version}` : ''}`, ...extra });

  const send = (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const isPump = (m) => m[0] === CALL && m[3]?.frame?.time !== undefined;
  const call = (proc, ...args) => new Promise((resolve, reject) => {
    const id = `c${++seq}`;
    pending.set(id, { resolve, reject });
    send([CALL, id, proc, ...args]);
  });

  // The driver only computes motion when we hand it frame times, so while it says the
  // cap is deflected we feed it one update per animation frame.
  function pump() {
    if (!moving || instance === null) return;
    call('3dx_rpc:update', controllerUri, { frame: { time: Date.now() } }).catch(() => {});
    pumpId = requestAnimationFrame(pump);
  }
  function setMoving(on) {
    if (moving === on) return;
    moving = on;
    if (on) pumpId = requestAnimationFrame(pump);
    else { cancelAnimationFrame(pumpId); pumpId = 0; }
    onMotion?.(on);
  }

  function onServerCall(payload) {
    const [, id, method, , prop, value] = payload;
    if (method === 'self:read') {
      let v;
      try { v = props.read(prop); } catch { v = undefined; }
      log('read', prop, '→', v === undefined ? null : v);
      send([CALL_RESULT, id, v === undefined ? null : v]);
    } else if (method === 'self:update') {
      log('write', prop, value);
      if (prop === 'motion') setMoving(!!value);
      try { props.write(prop, value); } catch { /* never let an app error stall the driver */ }
      send([CALL_RESULT, id, {}]);
    } else {
      send([CALL_ERROR, id, 'wamp.error.not_found', `unknown method ${method}`]);
    }
  }

  async function onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    switch (msg[0]) {
      case WELCOME: {
        send([PREFIX, '3dx_rpc', `wss://${PROXY_HOST}/3dconnexion#`]);
        send([PREFIX, '3dconnexion', `wss://${PROXY_HOST}/3dconnexion`]);
        send([PREFIX, 'self', 'spacemouse://local']);
        try {
          const mouse = await call('3dx_rpc:create', '3dconnexion:3dmouse', '0.8.1');
          const ctl = await call('3dx_rpc:create', '3dconnexion:3dcontroller', mouse.connexion,
            { version: Number(appVersion) || 0.8, name: appName, rowMajorOrder: false });
          instance = ctl.instance;
          controllerUri = `3dconnexion:3dcontroller/${instance}`;
          send([SUBSCRIBE, controllerUri]);
          try { localStorage.setItem(LAST_PORT_KEY, String(new URL(ws.url).port)); } catch { /* storage blocked */ }
          await call('3dx_rpc:update', controllerUri, { focus: true });
          await call('3dx_rpc:update', controllerUri, { frame: { timingSource: 1 } });
          // the driver keeps commands per session, so they go up on every connect
          if (commands) await call('3dx_rpc:update', controllerUri, { commands }).catch((e) => log('commands rejected', e));
          emit();
        } catch (e) {
          emit({ error: `driver refused the session (${Array.isArray(e) ? e.join(' ') : e})` });
          disconnect();
        }
        break;
      }
      case CALL_RESULT: { const p = pending.get(msg[1]); pending.delete(msg[1]); p?.resolve(msg[2]); break; }
      case CALL_ERROR: { const p = pending.get(msg[1]); pending.delete(msg[1]); log('call error', msg.slice(1)); p?.reject(msg.slice(2)); break; }
      case EVENT: {
        const inner = msg[2];
        if (Array.isArray(inner) && inner[0] === CALL) onServerCall(inner);
        else log('event', msg[1], inner);
        break;
      }
      default: log('unhandled', msg); break;
    }
  }

  /** Connect to the driver. Resolves true once the controller is live. */
  async function connect(known) {
    if (ws) return instance !== null;
    wanted = true;
    const info = known || await probeDriver();
    if (!info) { emit({ error: 'no 3Dconnexion driver answering on this machine' }); return false; }
    version = info.version;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      try {
        ws = new WebSocket(`wss://${PROXY_HOST}:${info.port}/`, 'wamp');
      } catch (e) {
        emit({ error: e.message }); ws = null; return finish(false);
      }
      ws.onmessage = (ev) => { onMessage(ev.data).then(() => { if (instance !== null) finish(true); }); };
      ws.onerror = () => { if (!info.guessed) emit({ error: 'could not reach the 3Dconnexion driver (is its certificate trusted?)' }); };
      ws.onclose = () => {
        const was = instance !== null;
        ws = null; instance = null; controllerUri = null;
        for (const p of pending.values()) p.reject(['closed']);
        pending.clear();
        setMoving(false);
        if (was) emit();
        finish(false);
        if (wanted) {   // the driver restarted or dropped us: come back quietly
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => { if (wanted && !ws) connect().then((ok) => { retryDelay = ok ? 1000 : Math.min(retryDelay * 2, 15000); }); }, retryDelay);
        }
      };
    });
  }

  function disconnect() {
    wanted = false;
    clearTimeout(retryTimer); retryTimer = 0; retryDelay = 1000;
    setMoving(false);
    if (ws) { try { ws.close(); } catch { /* already gone */ } }
    ws = null; instance = null; controllerUri = null;
    emit();
  }

  /** Tell the driver whether this app has keyboard/pointer focus (it only drives the focused app). */
  function setFocus(on) {
    if (instance !== null) call('3dx_rpc:update', controllerUri, { focus: !!on }).catch(() => {});
  }

  return { state, connect, disconnect, setFocus };
}
