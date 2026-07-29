// CDP probe: does the graph pane receive a dblclick, and does the create menu open?
import { WebSocket } from 'ws';

const TARGET = process.argv[2];
const PORT = 9333;
let id = 0;
const pending = new Map();

const listTargets = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const js = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = js.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('chrome never came up');
};

const page = await listTargets();
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 100e6 });
await new Promise((res) => ws.once('open', res));
const errors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return `THREW: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`;
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: TARGET });
await new Promise((r) => setTimeout(r, 6000));

// instrument: count raw events arriving at #graph, capture phase so nothing can stop them
await ev(`window.__log = [];
  for (const t of ['pointerdown','mousedown','mouseup','click','dblclick']) {
    document.querySelector('#graph').addEventListener(t, (e) => {
      window.__log.push(t + '(' + e.detail + ')@' + (e.target.id || e.target.className || e.target.tagName));
    }, true);
  }
  'instrumented'`);

// find a genuinely empty spot: scan the graph rect for a point whose hit target is #graph itself
const spot = await ev(`(() => {
  const g = document.querySelector('#graph'); const r = g.getBoundingClientRect();
  for (let fy = 0.2; fy < 0.9; fy += 0.1) {
    for (let fx = 0.2; fx < 0.9; fx += 0.1) {
      const x = r.x + r.width * fx, y = r.y + r.height * fy;
      if (document.elementFromPoint(x, y) === g) return JSON.stringify([x, y]);
    }
  }
  return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]);
})()`);
const [cx, cy] = JSON.parse(spot);
console.log(`empty spot: ${Math.round(cx)},${Math.round(cy)}  target=${await ev(`(()=>{const e=document.elementFromPoint(${cx},${cy});return e.id||e.className||e.tagName})()`)}`);

await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none', buttons: 0 });
for (const clickCount of [1, 2]) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount });
  await new Promise((r) => setTimeout(r, 50));
}
await new Promise((r) => setTimeout(r, 1200));

console.log('event log:', await ev(`JSON.stringify(window.__log)`));
console.log('menu open after real dblclick:', await ev(`!document.querySelector('#createMenu').classList.contains('hidden')`));

// control: is the handler itself sound? fire a synthetic dblclick straight at #graph
await ev(`document.querySelector('#createMenu').classList.add('hidden');
  document.querySelector('#graph').dispatchEvent(new MouseEvent('dblclick', {bubbles:true, clientX:${cx}, clientY:${cy}}));
  'dispatched'`);
await new Promise((r) => setTimeout(r, 400));
console.log('menu open after synthetic dblclick:', await ev(`!document.querySelector('#createMenu').classList.contains('hidden')`),
            '| items:', await ev(`document.querySelectorAll('#createList .create-item').length`));
console.log('errors:', errors.join(' | ') || '(none)');
ws.close();
process.exit(0);
