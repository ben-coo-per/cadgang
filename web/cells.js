/**
 * cadgang v2 — the cell transcript.
 *
 * There is no LLM in here and no authoring surface: cells are written by Claude
 * Code over MCP. This page is where a human READS the stack — the prompts in
 * order, the status of each cell against its own prompt — and turns the knobs.
 * That division is the whole point of hoisting `params`: the model writes the
 * structure once, the human drives the numbers forever, and driving a number
 * never re-prompts anything.
 *
 * It is a separate page from the v1 node editor rather than a mode inside it.
 * The two documents share a server and nothing else, and keeping the 2000-line
 * graph editor out of this file is worth a second entry point.
 */

import * as THREE from 'three';

const $ = (sel) => document.querySelector(sel);
const API = '/api/cells';

// ---------------------------------------------------------------- transport

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let statusTimer = null;
function say(text, isError = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('err', isError);
  clearTimeout(statusTimer);
  if (text && !isError) statusTimer = setTimeout(() => { el.textContent = ''; }, 2600);
}

// ----------------------------------------------------------------- viewport

const viewport = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);

const key = new THREE.DirectionalLight(0xfffdf8, 2.4);
key.position.set(60, -80, 120);
const fill = new THREE.DirectionalLight(0xf3e9d8, 0.9);
fill.position.set(-90, 50, -30);
const ambient = new THREE.AmbientLight(0xffffff, 1.15);
const hemi = new THREE.HemisphereLight(0xffffff, 0xdedbd4, 0.6);
scene.add(key, fill, ambient, hemi, new THREE.AxesHelper(14));

const material = new THREE.MeshStandardMaterial({
  color: 0xb9b8b3, metalness: 0.25, roughness: 0.5, side: THREE.DoubleSide,
});
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x2f5d8a, transparent: true, opacity: 0.85 });
let meshObj = null;
let edgeObj = null;
let grid = null;

// Cells are exact B-rep all the way through, so there is always real topology
// to draw — the wireframe here is the true trimmed curves, never a triangle
// overlay pretending to be edges.
function setGeometry(mesh) {
  for (const obj of [meshObj, edgeObj]) {
    if (obj) { scene.remove(obj); obj.geometry.dispose(); }
  }
  meshObj = edgeObj = null;
  if (!mesh?.positions?.length) return;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
  if (mesh.normals?.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3));
  geo.setIndex(mesh.indices);
  if (!mesh.normals?.length) geo.computeVertexNormals();
  meshObj = new THREE.Mesh(geo, material);
  scene.add(meshObj);

  if (mesh.edges?.lines?.length) {
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(mesh.edges.lines, 3));
    edgeObj = new THREE.LineSegments(eg, edgeMaterial);
    edgeObj.renderOrder = 1;
    scene.add(edgeObj);
  }
}

const orbit = { yaw: -0.6, pitch: 0.5, dist: 160, target: new THREE.Vector3(0, 0, 0) };
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

/** Frame the part once, on first load — never on a parameter change, or the
 *  camera would lurch every time the user scrubbed a dimension. */
let framed = false;
function frame(bbox) {
  if (framed || !bbox) return;
  const c = [0, 1, 2].map((i) => (bbox.min[i] + bbox.max[i]) / 2);
  orbit.target.set(c[0], c[1], c[2]);
  orbit.dist = Math.max(30, Math.hypot(...bbox.size) * 1.6);
  framed = true;
}

let drag = null;
viewport.addEventListener('contextmenu', (e) => e.preventDefault());
viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 2) return;
  viewport.setPointerCapture?.(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
});
window.addEventListener('pointerup', () => { drag = null; });
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  if (drag.pan) {
    const scale = orbit.dist * 0.0016;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    orbit.target.addScaledVector(right, -dx * scale);
    orbit.target.addScaledVector(up, dy * scale);
  } else {
    orbit.yaw -= dx * 0.006;
    orbit.pitch = Math.max(-1.45, Math.min(1.45, orbit.pitch + dy * 0.006));
  }
});
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.dist = Math.max(2, Math.min(3000, orbit.dist * (1 + Math.sign(e.deltaY) * 0.1)));
}, { passive: false });

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

(function loop() {
  requestAnimationFrame(loop);
  applyCamera();
  renderer.render(scene, camera);
})();

// -------------------------------------------------------------------- theme

let theme = localStorage.getItem('cadgang-theme') || 'light';
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $('#themeToggle').textContent = theme === 'dark' ? 'LIGHT' : 'DARK';
  const dark = theme === 'dark';
  scene.background = new THREE.Color(dark ? 0x1a1a18 : 0xf6f5f2);
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  grid = new THREE.GridHelper(200, 20,
    dark ? 0x2c2b28 : 0xd8d7d3, dark ? 0x242320 : 0xe9e8e4);
  grid.rotation.x = Math.PI / 2; // cadgang is Z-up
  scene.add(grid);
  key.intensity = dark ? 2.0 : 2.4;
  fill.intensity = dark ? 0.75 : 0.9;
  ambient.intensity = dark ? 0.5 : 1.15;
  hemi.intensity = dark ? 0.4 : 0.6;
}
$('#themeToggle').onclick = () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('cadgang-theme', theme);
  applyTheme();
};

// ------------------------------------------------------------------- layout

let dragBar = false;
$('#dragbar').addEventListener('pointerdown', (e) => {
  dragBar = true;
  $('#dragbar').setPointerCapture?.(e.pointerId);
});
window.addEventListener('pointerup', () => { if (dragBar) { dragBar = false; resize(); } });
window.addEventListener('pointermove', (e) => {
  if (!dragBar) return;
  const w = Math.max(300, Math.min(window.innerWidth * 0.7, e.clientX));
  $('#panel').style.flexBasis = `${w}px`;
  resize();
});

// --------------------------------------------------------------- the stack

let doc = { cells: [] };
let report = new Map();   // cell id -> evaluation entry
let structureSig = null;

const badge = (status) => `<span class="badge ${status}">${status.replace('_', ' ')}</span>`;
const fmt = (n) => (Math.abs(n) >= 1000 ? n.toFixed(0) : parseFloat(n.toPrecision(6)).toString());

/**
 * Rebuild the transcript.
 *
 * Only called when the STRUCTURE changed — ids, prompts, code, refs. A
 * parameter change updates values in place instead, because rebuilding the DOM
 * mid-scrub would yank focus out of the field being dragged.
 */
function renderStack() {
  const stack = $('#stack');
  $('#stackCount').textContent = doc.cells.length
    ? `${doc.cells.length} cell${doc.cells.length === 1 ? '' : 's'}`
    : '';

  if (!doc.cells.length) {
    stack.innerHTML = `<div class="empty">
      No cells yet.<br /><br />
      Cells are authored from Claude Code over MCP — ask it to model something and
      it will call <code>cadgang_cells_add</code>. This page is the transcript:
      prompts, parameters, and status.
    </div>`;
    return;
  }

  stack.innerHTML = '';
  doc.cells.forEach((cell, i) => {
    const entry = report.get(cell.id);
    const status = entry?.status === 'error' ? 'error' : cell.status;
    const el = document.createElement('div');
    el.className = `cell${status === 'error' ? ' failed' : ''}`;
    el.dataset.id = cell.id;

    const refs = cell.refs?.length
      ? `← ${cell.refs.join(', ')}`
      : (i > 0 ? `← ${doc.cells[i - 1].id}` : '');

    el.innerHTML = `
      <div class="cell-head">
        <span class="cell-index">${i + 1}</span>
        <span class="cell-id" title="Make this the output">${cell.id}</span>
        ${badge(status)}
        <span class="cell-refs">${refs}</span>
        <span class="cell-ms">${entry?.ms ? `${entry.ms}ms` : ''}</span>
      </div>
      <textarea class="cell-prompt" rows="2" placeholder="no prompt">${escapeHtml(cell.prompt || '')}</textarea>
      <div class="params"></div>
      ${cell.code ? '<button class="cell-toggle">Show code</button><pre class="cell-code" hidden></pre>' : ''}
      <div class="cell-meta"></div>
    `;

    // Params: the human's half of the document.
    const params = el.querySelector('.params');
    for (const [name, value] of Object.entries(cell.params || {})) {
      params.append(paramRow(cell.id, name, value));
    }

    const prompt = el.querySelector('.cell-prompt');
    // Grow to the text. A prompt is a sentence, not a form field, and a stack of
    // half-empty boxes stops the transcript reading like a document.
    const autosize = () => {
      prompt.style.height = 'auto';
      prompt.style.height = `${prompt.scrollHeight}px`;
    };
    prompt.addEventListener('input', autosize);
    requestAnimationFrame(autosize);
    prompt.addEventListener('blur', async () => {
      const next = prompt.value.trim();
      if (next === (cell.prompt || '')) return;
      try {
        await api(`/${encodeURIComponent(cell.id)}`, { method: 'PATCH', body: { prompt: next } });
        say(`'${cell.id}' is stale — recompile it from Claude Code`);
        await refresh();
      } catch (e) { say(e.message, true); }
    });

    const toggle = el.querySelector('.cell-toggle');
    if (toggle) {
      const pre = el.querySelector('.cell-code');
      pre.textContent = cell.code;
      toggle.onclick = () => {
        pre.hidden = !pre.hidden;
        toggle.textContent = pre.hidden ? 'Show code' : 'Hide code';
      };
    }

    el.querySelector('.cell-id').onclick = async () => {
      try {
        await api('/document/output', { method: 'POST', body: { cell: cell.id } });
        framed = false;
        await refresh();
      } catch (e) { say(e.message, true); }
    };

    stack.append(el);
  });
  paintReport();
}

/** One parameter: a scrubbable name and an exact number field. */
function paramRow(cellId, name, value) {
  const frag = document.createDocumentFragment();
  const label = document.createElement('span');
  label.className = 'param-name';
  label.textContent = name;
  const input = document.createElement('input');
  input.className = 'param-input';
  input.dataset.cell = cellId;
  input.dataset.param = name;
  input.value = value;

  const numeric = typeof value === 'number';
  if (numeric) {
    // Drag the NAME to scrub. A slider would need a min and a max the program
    // never declares; a drag needs neither and stays exact at any magnitude.
    let scrub = null;
    label.addEventListener('pointerdown', (e) => {
      scrub = { x: e.clientX, start: parseFloat(input.value) || 0 };
      label.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    label.addEventListener('pointermove', (e) => {
      if (!scrub) return;
      const step = e.shiftKey ? 0.01 : e.altKey ? 10 : 0.1;
      const next = Math.round((scrub.start + (e.clientX - scrub.x) * step) * 1000) / 1000;
      input.value = next;
      push(cellId, name, next);
    });
    label.addEventListener('pointerup', () => { scrub = null; });
  } else {
    label.style.cursor = 'default';
  }

  input.addEventListener('change', () => {
    const next = numeric ? parseFloat(input.value) : input.value;
    if (numeric && !Number.isFinite(next)) { input.value = value; return; }
    push(cellId, name, next);
  });

  frag.append(label, input);
  return frag;
}

/**
 * Send a parameter change.
 *
 * Coalesced: a scrub fires on every pointermove, and the server would happily
 * re-run the whole stack for each one. Only the latest value per parameter is
 * ever in flight, and a new value queued during a request supersedes it.
 */
const pending = new Map();
let inFlight = false;
function push(cellId, name, value) {
  pending.set(`${cellId} ${name}`, { cellId, name, value });
  drain();
}
async function drain() {
  if (inFlight || !pending.size) return;
  inFlight = true;
  const batch = new Map();
  for (const { cellId, name, value } of pending.values()) {
    if (!batch.has(cellId)) batch.set(cellId, {});
    batch.get(cellId)[name] = value;
  }
  pending.clear();
  try {
    for (const [cellId, params] of batch) {
      await api(`/${encodeURIComponent(cellId)}`, { method: 'PATCH', body: { params } });
    }
    await refresh({ structural: false });
  } catch (e) {
    say(e.message, true);
  } finally {
    inFlight = false;
    if (pending.size) drain();
  }
}

/** Paint evaluation results onto the already-rendered cells. */
function paintReport() {
  for (const el of document.querySelectorAll('.cell')) {
    const cell = doc.cells.find((c) => c.id === el.dataset.id);
    const entry = report.get(el.dataset.id);
    const status = entry?.status === 'error' ? 'error' : cell?.status ?? 'ok';

    const b = el.querySelector('.badge');
    if (b) { b.className = `badge ${status}`; b.textContent = status.replace('_', ' '); }
    el.classList.toggle('failed', status === 'error');
    el.querySelector('.cell-ms').textContent = entry?.ms ? `${entry.ms}ms` : '';

    el.querySelectorAll('.cell-error, .cell-log').forEach((n) => n.remove());
    if (entry?.error) {
      const err = document.createElement('div');
      err.className = 'cell-error';
      err.textContent = entry.error;
      el.append(err);
    }
    for (const line of entry?.logs || []) {
      const log = document.createElement('div');
      log.className = 'cell-log';
      log.textContent = `${line.level}: ${line.text}`;
      el.append(log);
    }

    const meta = el.querySelector('.cell-meta');
    if (meta && cell) {
      meta.textContent = cell.compiledAt
        ? `compiled ${new Date(cell.compiledAt).toLocaleString()}${cell.compiledBy ? ` · ${cell.compiledBy}` : ''}`
        : '';
    }
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ------------------------------------------------------------------ refresh

/**
 * Pull the document, evaluate it, and pull the mesh.
 *
 * `stopOnError: 0` so one broken cell does not hide the state of every other
 * one — the transcript should show the whole stack's health at once, which is
 * exactly what the authoring loop wants to look at after an edit.
 */
async function refresh({ structural = true } = {}) {
  try {
    doc = await api('/document');
  } catch (e) {
    say(e.message, true);
    return;
  }

  const sig = JSON.stringify(doc.cells.map((c) => [c.id, c.prompt, c.code, c.refs, c.status, Object.keys(c.params || {})]));
  const changed = sig !== structureSig;
  structureSig = sig;

  let evaluation = null;
  if (doc.cells.length) {
    try {
      evaluation = await api('/evaluate?stopOnError=0');
      report = new Map(evaluation.cells.map((c) => [c.id, c]));
    } catch (e) {
      report = new Map();
      say(e.message, true);
    }
  } else {
    report = new Map();
  }

  if (changed || structural) renderStack();
  else {
    paintReport();
    // Values the server settled on (a clamp, a coerced type) win over what the
    // field currently shows — unless the user is typing in it.
    for (const input of document.querySelectorAll('.param-input')) {
      if (input === document.activeElement) continue;
      const cell = doc.cells.find((c) => c.id === input.dataset.cell);
      const value = cell?.params?.[input.dataset.param];
      if (value !== undefined && String(value) !== input.value) input.value = value;
    }
  }

  const m = evaluation?.measures;
  $('#measures').textContent = m
    ? `vol ${fmt(m.volume)} mm³ · area ${fmt(m.area)} mm² · bbox ${m.bbox.size.map(fmt).join(' × ')} mm`
    : '';

  if (!doc.cells.length) { setGeometry(null); $('#stats').textContent = ''; return; }

  try {
    const mesh = await api('/mesh');
    setGeometry(mesh);
    frame(m?.bbox);
    // When the newest cell is broken the server falls back to the deepest one
    // that built. Say so — a viewport quietly showing an older state is worse
    // than one showing nothing.
    const showing = mesh.partial ? ` · showing ${mesh.cell}` : '';
    $('#stats').textContent =
      `${mesh.indices.length / 3} tris · ${mesh.faces?.length ?? 0} faces · exact${showing}`;
  } catch (e) {
    setGeometry(null);
    $('#stats').textContent = 'no geometry';
  }
}

// -------------------------------------------------------------- undo / redo

async function history(which) {
  try {
    await api(`/${which}`, { method: 'POST' });
    await refresh();
  } catch (e) { say(e.message, true); }
}
$('#undoBtn').onclick = () => history('undo');
$('#redoBtn').onclick = () => history('redo');
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
  if (document.activeElement?.matches('input, textarea')) return;
  e.preventDefault();
  history(e.shiftKey ? 'redo' : 'undo');
});

// ------------------------------------------------------------------- live

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    // Only cell traffic matters here; the v1 graph shares the socket.
    if (msg.type === 'cells_changed' && msg.revision !== doc.revision) refresh();
  };
  // Claude Code authoring in the background is the normal case, so a dropped
  // socket must not leave the transcript silently stale.
  ws.onclose = () => setTimeout(connect, 1500);
}

// -------------------------------------------------------------------- boot

applyTheme();
resize();
fetch('/api/health')
  .then((r) => r.json())
  .then((h) => { $('#version').textContent = `v${h.version}`; })
  .catch(() => {});
await refresh();
connect();
