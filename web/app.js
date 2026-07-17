/* cadgang web UI: Three.js viewport + block/param editor over the REST API. */

import * as THREE from 'three';

const $ = (sel) => document.querySelector(sel);
const api = (p, opts) => fetch(`/api${p}`, opts).then(async (r) => {
  const isJson = (r.headers.get('content-type') || '').includes('json');
  const body = isJson ? await r.json() : await r.blob();
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
});
const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patch = (p, body) => api(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let catalog = {};
let doc = { nodes: {}, output: null, revision: 0 };

// ------------------------------------------------------------ viewport

const viewport = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f14);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);

const key = new THREE.DirectionalLight(0xffffff, 2.1);
key.position.set(60, -80, 100);
scene.add(key);
const fill = new THREE.DirectionalLight(0x8899ff, 0.7);
fill.position.set(-80, 60, -40);
scene.add(fill);
scene.add(new THREE.AmbientLight(0x404866, 1.2));

const grid = new THREE.GridHelper(200, 20, 0x2c3346, 0x1c2130);
grid.rotation.x = Math.PI / 2; // cadgang is Z-up
scene.add(grid);
scene.add(new THREE.AxesHelper(24));

const material = new THREE.MeshStandardMaterial({
  color: 0x609eff, metalness: 0.1, roughness: 0.45, side: THREE.DoubleSide,
});
let meshObj = null;

// Minimal Z-up orbit controls (drag = orbit, right-drag/shift = pan, wheel = zoom)
const orbit = { yaw: -0.6, pitch: 0.5, dist: 120, target: new THREE.Vector3(0, 0, 0) };
function applyCamera() {
  const cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch);
  camera.position.set(
    orbit.target.x + orbit.dist * cp * Math.sin(orbit.yaw),
    orbit.target.y - orbit.dist * cp * Math.cos(orbit.yaw),
    orbit.target.z + orbit.dist * sp
  );
  camera.up.set(0, 0, 1);
  camera.lookAt(orbit.target);
}

let dragging = null;
viewport.addEventListener('contextmenu', (e) => e.preventDefault());
viewport.addEventListener('pointerdown', (e) => {
  dragging = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
  viewport.setPointerCapture?.(e.pointerId);
});
window.addEventListener('pointerup', () => (dragging = null));
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
  dragging.x = e.clientX; dragging.y = e.clientY;
  if (dragging.pan) {
    const scale = orbit.dist * 0.0016;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    orbit.target.addScaledVector(right, -dx * scale);
    orbit.target.addScaledVector(up, dy * scale);
  } else {
    orbit.yaw += dx * 0.006;
    orbit.pitch = Math.max(-1.45, Math.min(1.45, orbit.pitch + dy * 0.006));
  }
  applyCamera();
});
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.dist *= Math.exp(e.deltaY * 0.0012);
  orbit.dist = Math.max(2, Math.min(2000, orbit.dist));
  applyCamera();
}, { passive: false });

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

(function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
})();

// ------------------------------------------------------------ meshing

let framedOnce = false;
let meshInFlight = false, meshAgain = false;

async function refreshMesh() {
  if (meshInFlight) { meshAgain = true; return; }
  meshInFlight = true;
  const status = $('#status');
  try {
    if (!doc.output || Object.keys(doc.nodes).length === 0) {
      if (meshObj) { scene.remove(meshObj); meshObj.geometry.dispose(); meshObj = null; }
      $('#stats').textContent = 'no output node — add a block to get started';
      status.textContent = '';
      return;
    }
    status.textContent = 'meshing…';
    status.classList.remove('err');
    const resolution = $('#resolution').value;
    const m = await api(`/mesh?resolution=${resolution}`);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3));
    geo.setIndex(m.indices);
    if (meshObj) { scene.remove(meshObj); meshObj.geometry.dispose(); }
    meshObj = new THREE.Mesh(geo, material);
    scene.add(meshObj);

    const s = m.stats;
    $('#stats').textContent =
      `${s.triangleCount.toLocaleString()} tris · ${s.vertexCount.toLocaleString()} verts · ` +
      `volume ${fmt(s.volume)} mm³ · area ${fmt(s.surfaceArea)} mm² · grid ${s.gridDims.join('×')}`;
    status.textContent = `rev ${m.revision}`;

    if (!framedOnce && s.triangleCount > 0) {
      framedOnce = true;
      const b = s.bounds;
      orbit.target.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
      orbit.dist = Math.max(20, 2.2 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 * 2);
      applyCamera();
    }
  } catch (e) {
    status.textContent = e.message;
    status.classList.add('err');
  } finally {
    meshInFlight = false;
    if (meshAgain) { meshAgain = false; refreshMesh(); }
  }
}

const fmt = (v) => (v >= 1000 ? Math.round(v).toLocaleString() : v.toPrecision(4));

// ------------------------------------------------------------ panel

function nodeOptions(selected, excludeId) {
  return Object.values(doc.nodes)
    .filter((n) => n.id !== excludeId)
    .map((n) => `<option value="${n.id}" ${n.id === selected ? 'selected' : ''}>${n.name}</option>`)
    .join('');
}

function renderPanel() {
  const list = $('#nodeList');
  list.innerHTML = '';
  const ordered = Object.values(doc.nodes).reverse();
  for (const node of ordered) {
    const spec = catalog[node.type] || { params: {}, inputs: {} };
    const card = document.createElement('div');
    card.className = 'node-card' + (doc.output === node.id ? ' output' : '');

    let html = `<div class="node-head">
      <span class="type">${node.type}</span>
      <span class="name" title="${node.id}">${node.name}</span>
      <button data-act="output" title="Make this the model output">${doc.output === node.id ? '◉' : '○'}</button>
      <button data-act="delete" title="Delete block">✕</button>
    </div>`;

    for (const [pname, pdef] of Object.entries(spec.params)) {
      const val = node.params?.[pname] ?? pdef.default;
      if (pdef.type === 'vec3') {
        html += `<div class="param-row"><span class="pname" title="${pdef.description || ''}">${pname}</span>
          ${[0, 1, 2].map((i) => `<input type="number" step="any" data-param="${pname}" data-index="${i}" value="${val[i]}" />`).join('')}
        </div>`;
      } else {
        html += `<div class="param-row"><span class="pname" title="${pdef.description || ''}">${pname}</span>
          <input type="number" step="any" data-param="${pname}" value="${val}" /></div>`;
      }
    }

    for (const [slot, sdef] of Object.entries(spec.inputs)) {
      const cur = node.inputs?.[slot];
      if (sdef.many) {
        const ids = Array.isArray(cur) ? cur : cur ? [cur] : [];
        html += `<div class="input-row">${slot}: <span class="chips">
          ${ids.map((id) => `<span class="chip" data-slot="${slot}" data-remove="${id}" title="Click to disconnect">${doc.nodes[id]?.name ?? id} ✕</span>`).join('')}
          </span>
          <select data-slot="${slot}" data-many="1"><option value="">+ connect…</option>${nodeOptions(null, node.id)}</select>
        </div>`;
      } else {
        html += `<div class="input-row">${slot}:
          <select data-slot="${slot}"><option value="">— none —</option>${nodeOptions(cur, node.id)}</select>
        </div>`;
      }
    }

    card.innerHTML = html;

    card.querySelector('[data-act="output"]').onclick = () => post('/document/output', { node: node.id }).catch(showErr);
    card.querySelector('[data-act="delete"]').onclick = () => api(`/nodes/${node.id}`, { method: 'DELETE' }).catch(showErr);

    card.querySelectorAll('input[data-param]').forEach((input) => {
      input.onchange = () => {
        const pname = input.dataset.param;
        const pdef = spec.params[pname];
        let value;
        if (pdef.type === 'vec3') {
          value = [...card.querySelectorAll(`input[data-param="${pname}"]`)].map((el) => parseFloat(el.value) || 0);
        } else {
          value = parseFloat(input.value) || 0;
        }
        patch(`/nodes/${node.id}`, { params: { [pname]: value } }).catch(showErr);
      };
    });

    card.querySelectorAll('select[data-slot]').forEach((sel) => {
      sel.onchange = () => {
        const slot = sel.dataset.slot;
        if (sel.dataset.many) {
          if (!sel.value) return;
          const ids = Array.isArray(node.inputs?.[slot]) ? [...node.inputs[slot]] : node.inputs?.[slot] ? [node.inputs[slot]] : [];
          if (!ids.includes(sel.value)) ids.push(sel.value);
          patch(`/nodes/${node.id}`, { inputs: { [slot]: ids } }).catch(showErr);
        } else {
          patch(`/nodes/${node.id}`, { inputs: { [slot]: sel.value || null } }).catch(showErr);
        }
      };
    });

    card.querySelectorAll('.chip[data-remove]').forEach((chip) => {
      chip.onclick = () => {
        const slot = chip.dataset.slot;
        const ids = (Array.isArray(node.inputs?.[slot]) ? node.inputs[slot] : [node.inputs?.[slot]]).filter((id) => id && id !== chip.dataset.remove);
        patch(`/nodes/${node.id}`, { inputs: { [slot]: ids } }).catch(showErr);
      };
    });

    list.appendChild(card);
  }
}

function showErr(e) {
  const status = $('#status');
  status.textContent = e.message;
  status.classList.add('err');
}

// ------------------------------------------------------------ top bar

$('#addNode').onclick = () => {
  const type = $('#addNodeType').value;
  post('/nodes', { type }).catch(showErr);
};

$('#clearDoc').onclick = () => {
  if (confirm('Delete all blocks?')) post('/document/clear', {}).catch(showErr);
};

$('#exportStl').onclick = () => {
  window.location.href = `/api/export/stl?resolution=${Math.min(200, $('#resolution').value * 2)}`;
};

$('#resolution').oninput = () => { $('#resolutionValue').textContent = $('#resolution').value; };
$('#resolution').onchange = () => refreshMesh();

// ------------------------------------------------------------ sync

async function refreshDocument() {
  doc = await api('/document');
  renderPanel();
  refreshMesh();
}

function connectWS() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'document_changed') refreshDocument().catch(showErr);
  };
  ws.onclose = () => setTimeout(connectWS, 1500);
}

(async function init() {
  catalog = await api('/node-types');
  const sel = $('#addNodeType');
  const groups = {};
  for (const [name, spec] of Object.entries(catalog)) {
    (groups[spec.category] ??= []).push(name);
  }
  sel.innerHTML = Object.entries(groups)
    .map(([cat, names]) => `<optgroup label="${cat}">${names.map((n) => `<option>${n}</option>`).join('')}</optgroup>`)
    .join('');
  resize();
  applyCamera();
  await refreshDocument();
  connectWS();
})().catch(showErr);
