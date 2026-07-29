// Why doesn't the poll fallback notice a revision change? Watch what the page's own fetch sees.
import { WebSocket } from 'ws';
const TARGET = process.argv[2];
const PORT = 9333;
let id = 0;
const pending = new Map();
const listTargets = async () => {
  for (let i = 0; i < 40; i++) {
    try { const js = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = js.find((t) => t.type === 'page'); if (p) return p; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('no chrome');
};
const page = await listTargets();
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 100e6 });
await new Promise((res) => ws.once('open', res));
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return `THREW: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`;
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: TARGET });
await new Promise((r) => setTimeout(r, 6000));

const BASE = await ev(`location.pathname.replace(/\\/[^/]*$/, '')`);
console.log('BASE =', JSON.stringify(BASE));
console.log('health as the page fetches it:', await ev(`fetch('${BASE}/api/health').then(r => r.text())`));
console.log('health, cache bypassed:      ', await ev(`fetch('${BASE}/api/health?x=' + Math.random(), {cache:'no-store'}).then(r => r.text())`));
console.log('response headers:', await ev(`fetch('${BASE}/api/health').then(r => JSON.stringify([...r.headers]))`));

// create a node from the page itself, then watch what health reports over the next few seconds
console.log('--- POSTing a node from the page ---');
console.log('post result:', await ev(`fetch('${BASE}/api/nodes', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type:'box'})}).then(r => r.status + ' ' + r.statusText)`));
for (let i = 0; i < 4; i++) {
  await new Promise((r) => setTimeout(r, 900));
  console.log(`  t+${((i + 1) * 0.9).toFixed(1)}s  page-fetch health:`, await ev(`fetch('${BASE}/api/health').then(r => r.text())`));
}
console.log('curl-equivalent truth: (compare externally)');
console.log('gnodes in DOM:', await ev(`document.querySelectorAll('#graph .gnode').length`));
ws.close();
process.exit(0);
