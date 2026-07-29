// End-to-end probe: double-click empty canvas, pick a block, confirm it renders.
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
const reqs = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Network.requestWillBeSent') reqs.push(`${m.params.request.method} ${m.params.request.url.replace(/^https?:\/\/[^/]+/, '')}`);
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
await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url: TARGET });
await new Promise((r) => setTimeout(r, 6000));

const spot = await ev(`(() => {
  const g = document.querySelector('#graph'); const r = g.getBoundingClientRect();
  for (let fy = 0.2; fy < 0.9; fy += 0.1) for (let fx = 0.2; fx < 0.9; fx += 0.1) {
    const x = r.x + r.width * fx, y = r.y + r.height * fy;
    if (document.elementFromPoint(x, y) === g) return JSON.stringify([x, y]);
  }
  return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]);
})()`);
const [cx, cy] = JSON.parse(spot);

await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none', buttons: 0 });
for (const clickCount of [1, 2]) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount });
  await new Promise((r) => setTimeout(r, 50));
}
await new Promise((r) => setTimeout(r, 800));
console.log('menu open:', await ev(`!document.querySelector('#createMenu').classList.contains('hidden')`));

// pick "sphere" out of the list the way a user would
const picked = await ev(`(() => {
  const items = [...document.querySelectorAll('#createList .create-item')];
  const it = items.find((e) => e.textContent.trim() === 'sphere') || items[0];
  if (!it) return 'no items';
  it.click(); return it.textContent.trim();
})()`);
console.log('picked:', picked);

// the render depends on the poll fallback noticing the revision move
for (let i = 0; i < 12; i++) {
  const n = await ev(`document.querySelectorAll('#graph .gnode').length`);
  if (n > 0) { console.log(`blocks rendered: ${n} (after ~${(i + 1) * 0.5}s)`); break; }
  await new Promise((r) => setTimeout(r, 500));
  if (i === 11) console.log('blocks rendered: 0 — NEVER APPEARED');
}
console.log('api requests:', reqs.filter(r=>r.includes('/api/')).join('\n  ') || '(none)');
console.log('ws state:', await ev(`(()=>{const p=performance.getEntriesByType('resource').filter(e=>e.name.includes('/ws'));return JSON.stringify(p.map(e=>e.name))})()`));
console.log('canvas in viewport:', await ev(`!!document.querySelector('#viewport canvas')`));
console.log('block label:', await ev(`document.querySelector('#graph .gnode .gname')?.textContent || '(none)'`));
console.log('errors:', errors.join(' | ') || '(none)');
ws.close();
process.exit(0);
