/**
 * Demo: build a gyroid-filled, shelled rounded box with a cylindrical bore —
 * the classic nTopology party trick — through the cadgang REST API.
 *
 *   npm start          (in one terminal)
 *   npm run demo       (in another)
 */

const BASE = process.env.CADGANG_URL || 'http://localhost:4477';

async function api(path, method = 'GET', body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.arrayBuffer();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

console.log('clearing document…');
await api('/document/clear', 'POST', {});

console.log('building blocks…');
await api('/nodes', 'POST', { type: 'box', id: 'body', name: 'body', params: { size: [60, 40, 24], round: 6 } });
await api('/nodes', 'POST', { type: 'cylinder', id: 'bore', name: 'bore', params: { radius: 9, height: 60 } });
await api('/nodes', 'POST', { type: 'subtract', id: 'bored_body', inputs: { a: 'body', b: 'bore' } });
await api('/nodes', 'POST', { type: 'shell', id: 'skin', name: 'outer skin', params: { thickness: 2 }, inputs: { shape: 'bored_body' } });
await api('/nodes', 'POST', { type: 'gyroid', id: 'lattice', params: { cell: 9, thickness: 1.6 } });
await api('/nodes', 'POST', { type: 'intersect', id: 'infill', name: 'lattice infill', inputs: { shapes: ['bored_body', 'lattice'] } });
await api('/nodes', 'POST', { type: 'union', id: 'part', name: 'final part', inputs: { shapes: ['skin', 'infill'] } });
await api('/document/output', 'POST', { node: 'part' });

console.log('meshing…');
const stats = await api('/mesh/stats?resolution=110');
console.log(`  ${stats.stats.triangleCount} triangles, volume ${Math.round(stats.stats.volume)} mm³, area ${Math.round(stats.stats.surfaceArea)} mm²`);

console.log('exporting STL…');
const stl = await api('/export/stl?resolution=150&file=demo_part');
console.log(`  wrote exports/demo_part.stl (${stl.byteLength} bytes)`);

console.log(`done — open ${BASE} to see it.`);
