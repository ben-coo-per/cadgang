/* cadgang web UI: Three.js viewport + node-graph editor over the REST API. */

import * as THREE from 'three';
import { createSpaceMouse, AXES as SM_AXES, STALE_MS as SM_STALE_MS } from './spacemouse.js';

const $ = (sel) => document.querySelector(sel);
// everything is addressed relative to the directory index.html was served from, so the
// app works both at the server root and mounted under a subpath (e.g. /cadgang)
const BASE = location.pathname.replace(/\/[^/]*$/, '');
// cache:'no-store' because an intermediary may declare these responses fresh for days —
// a cached /api/health pins the client to a revision the server has long moved past
const api = (p, opts) => fetch(`${BASE}/api${p}`, { cache: 'no-store', ...opts }).then(async (r) => {
  const isJson = (r.headers.get('content-type') || '').includes('json');
  const body = isJson ? await r.json() : await r.blob();
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  // a mutation bumps the server revision; when the live socket is unavailable the poll
  // fallback is what notices, so kick it immediately instead of waiting for the next tick
  if (opts && opts.method && opts.method !== 'GET') pollSoon();
  return body;
});
const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patch = (p, body) => api(p, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const del = (p) => api(p, { method: 'DELETE' });

const SVGNS = 'http://www.w3.org/2000/svg';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// machined-metal swatch per category (CW&T palette) — used for create-menu dots.
// sketch/brep are the exact (B-rep) lineage and get their own blueprint-blue.
const CAT_COLOR = {
  primitive: '#b9b8b3', boolean: '#3a3a38', modify: '#b08a4d', output: '#e35a1e',
  sketch: '#4a7fb5', brep: '#2f5d8a',
};
// create-menu group order (unknown categories fall after these, alphabetically)
const CAT_ORDER = ['sketch', 'brep', 'primitive', 'boolean', 'modify', 'output'];

let catalog = {};
let doc = { nodes: {}, output: null, revision: 0 };

// view mode state (persisted)
let theme = localStorage.getItem('cadgang:theme') === 'dark' ? 'dark' : 'light';
let colorMode = localStorage.getItem('cadgang:colorMode') === '1';
let splitLayout = localStorage.getItem('cadgang:split') === 'stacked' ? 'stacked' : 'side';

// Deterministic per-node hue: golden-angle rotation over the SORTED node ids.
function nodeHue(id) {
  const ids = Object.keys(doc.nodes).sort();
  const idx = ids.indexOf(id);
  return idx < 0 ? null : (idx * 137.508) % 360;
}
function nodeColorCss(id) {
  const h = nodeHue(id);
  if (h == null) return null;
  return theme === 'dark' ? `hsl(${h.toFixed(1)}, 60%, 62%)` : `hsl(${h.toFixed(1)}, 55%, 42%)`;
}
function nodeColorThree(id) {
  const c = new THREE.Color();
  const h = nodeHue(id);
  if (h == null) { c.set(0xb9b8b3); return c; }          // stainless fallback
  c.setHSL(h / 360, theme === 'dark' ? 0.60 : 0.55, theme === 'dark' ? 0.62 : 0.42);
  return c;
}

// ------------------------------------------------------------ viewport

const viewport = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);

// Studio-lit, warm-neutral: white-ish key, soft warm fill, generous ambient.
const key = new THREE.DirectionalLight(0xfffdf8, 2.4);
key.position.set(60, -80, 120);
scene.add(key);
const fill = new THREE.DirectionalLight(0xf3e9d8, 0.9);
fill.position.set(-90, 50, -30);
scene.add(fill);
const ambient = new THREE.AmbientLight(0xffffff, 1.15);
scene.add(ambient);
const hemi = new THREE.HemisphereLight(0xffffff, 0xdedbd4, 0.6);
scene.add(hemi);

let grid = null;
const axes = new THREE.AxesHelper(14);
scene.add(axes);

const STAINLESS = 0xb9b8b3;
const material = new THREE.MeshStandardMaterial({
  color: STAINLESS, metalness: 0.25, roughness: 0.5, side: THREE.DoubleSide, // machined stainless
});
let meshObj = null;

// B-rep edge overlay: the real trimmed curves of an exact solid (and the whole
// of a sketch). Field geometry has no topology to draw, so this stays empty for
// it — which is itself an honest signal of which lineage you are looking at.
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x2f5d8a, transparent: true, opacity: 0.85 });
let edgeObj = null;

/** Replace the edge overlay with `edges` ({lines:[x,y,z,...]}), or clear it. */
function setEdgeOverlay(edges) {
  if (edgeObj) { scene.remove(edgeObj); edgeObj.geometry.dispose(); edgeObj = null; }
  if (!edges?.lines?.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(edges.lines, 3));
  edgeObj = new THREE.LineSegments(geo, edgeMaterial);
  // Nudge toward the camera so edges are not z-fought by the faces they bound.
  edgeObj.renderOrder = 1;
  scene.add(edgeObj);
}

// Retint the 3D scene (background, grid, lighting) to match the UI theme.
function applyViewportTheme() {
  const dark = theme === 'dark';
  scene.background = new THREE.Color(dark ? 0x1a1a18 : 0xf6f5f2);
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  grid = new THREE.GridHelper(200, 20,
    dark ? 0x2c2b28 : 0xd8d7d3, dark ? 0x242320 : 0xe9e8e4); // warm greys, never blue
  grid.rotation.x = Math.PI / 2; // cadgang is Z-up
  scene.add(grid);
  // dimmer, still-warm key on dark so the stainless part reads against near-black
  key.intensity = dark ? 2.0 : 2.4;
  fill.intensity = dark ? 0.75 : 0.9;
  ambient.intensity = dark ? 0.5 : 1.15;
  hemi.intensity = dark ? 0.4 : 0.6;
}

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

// Home = the startup view; fit = frame whatever is in the scene (model and/or edge overlay).
const HOME_VIEW = { yaw: orbit.yaw, pitch: orbit.pitch, dist: orbit.dist };
function homeView() {
  orbit.yaw = HOME_VIEW.yaw; orbit.pitch = HOME_VIEW.pitch; orbit.dist = HOME_VIEW.dist;
  orbit.target.set(0, 0, 0);
  applyCamera();
}
function fitView() {
  const box = new THREE.Box3();
  if (meshObj) box.expandByObject(meshObj);
  if (edgeObj) box.expandByObject(edgeObj);
  if (box.isEmpty()) { homeView(); return; }
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const vfov = THREE.MathUtils.degToRad(camera.fov) / 2;
  const fov = Math.min(vfov, Math.atan(Math.tan(vfov) * camera.aspect)); // tighter of the two half-angles
  orbit.target.copy(sphere.center);
  orbit.dist = clamp((sphere.radius / Math.sin(fov)) * 1.1, 2, 2000);
  applyCamera();
}

// The document/SDF space is Z-up and maps DIRECTLY onto the Three.js world (no group
// rotation or axis swizzle — camera.up is +Z). So mesh/asset positions and any world-space
// drag delta are already document coordinates; no conversion needed.
const raycaster = new THREE.Raycaster();
const DRAG_THRESH = 4; // px of movement before a viewport press becomes a part-drag

function pointerNDC(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
}
function inViewport(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  return e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
}

let vpDrag = null;      // orbit / pan on empty space
let partDrag = null;    // dragging a part of the model → transform block
let faceMode = false;   // STEP face-picking mode active

viewport.addEventListener('contextmenu', (e) => e.preventDefault());
viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 2) return;
  // Presses on viewport UI controls (e.g. the Pick face button) must keep
  // their normal click behavior — capturing the pointer here would retarget
  // pointerup to the viewport and the button's click would never fire.
  if (e.target.closest('button')) return;
  viewport.setPointerCapture?.(e.pointerId);

  // face-pick: let the press orbit, but remember it so a no-drag release extrudes
  if (faceMode) {
    vpDrag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey, downX: e.clientX, downY: e.clientY, faceClick: e.button === 0 };
    return;
  }
  // part pick: left press directly on the model starts a (deferred) part drag
  if (e.button === 0 && meshObj && lastMesh && lastMesh.owners) {
    const hit = pickPart(e);
    if (hit) { partDrag = { ...hit, downX: e.clientX, downY: e.clientY, active: false, base: null, verts: null, delta: new THREE.Vector3() }; return; }
  }
  vpDrag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
});

window.addEventListener('pointerup', (e) => {
  if (partDrag) { endPartDrag(e); partDrag = null; return; }
  if (vpDrag) {
    if (faceMode && vpDrag.faceClick && Math.hypot(e.clientX - vpDrag.downX, e.clientY - vpDrag.downY) < DRAG_THRESH) doFaceExtrude();
    vpDrag = null;
  }
});

window.addEventListener('pointermove', (e) => {
  if (partDrag) { movePartDrag(e); return; }
  if (faceMode && inViewport(e)) faceHover(e);
  if (!vpDrag) return;
  const dx = e.clientX - vpDrag.x, dy = e.clientY - vpDrag.y;
  vpDrag.x = e.clientX; vpDrag.y = e.clientY;
  if (vpDrag.pan) {
    const scale = orbit.dist * 0.0016;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    orbit.target.addScaledVector(right, -dx * scale);
    orbit.target.addScaledVector(up, dy * scale);
  } else {
    orbit.yaw -= dx * 0.006;
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

// ---- part picking + drag (feature: drag a part in the viewport → transform block)

// Raycast the model; return the part id (a direct-input node, or the output itself) and hit point.
function pickPart(e) {
  raycaster.setFromCamera(pointerNDC(e), camera);
  const hits = raycaster.intersectObject(meshObj, false);
  if (!hits.length) return null;
  const hit = hits[0];
  const f = hit.face;
  if (!f) return null;
  const pos = meshObj.geometry.attributes.position;
  // nearest of the triangle's three vertices to the hit point → its owner → part id
  let bestV = f.a, bestD = Infinity;
  for (const v of [f.a, f.b, f.c]) {
    const d = (pos.getX(v) - hit.point.x) ** 2 + (pos.getY(v) - hit.point.y) ** 2 + (pos.getZ(v) - hit.point.z) ** 2;
    if (d < bestD) { bestD = d; bestV = v; }
  }
  const owner = lastMesh.owners[bestV];
  const partId = lastMesh.partIds[owner];
  if (!partId) return null;
  return { partId, owner, point: hit.point.clone() };
}

// Intersect the pointer ray with the drag plane through `origin`. Horizontal = document XY
// (plane normal +Z); vertical (Shift) = a camera-facing vertical plane, we keep only ΔZ.
const _plane = new THREE.Plane();
const _pt = new THREE.Vector3();
function dragDelta(e, origin, vertical) {
  raycaster.setFromCamera(pointerNDC(e), camera);
  if (vertical) {
    const n = new THREE.Vector3().subVectors(camera.position, origin); n.z = 0;
    if (n.lengthSq() < 1e-9) n.set(1, 0, 0);
    _plane.setFromNormalAndCoplanarPoint(n.normalize(), origin);
    if (!raycaster.ray.intersectPlane(_plane, _pt)) return null;
    return new THREE.Vector3(0, 0, _pt.z - origin.z);
  }
  _plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), origin);
  if (!raycaster.ray.intersectPlane(_plane, _pt)) return null;
  return new THREE.Vector3(_pt.x - origin.x, _pt.y - origin.y, 0);
}

function movePartDrag(e) {
  if (!partDrag.active) {
    if (Math.hypot(e.clientX - partDrag.downX, e.clientY - partDrag.downY) < DRAG_THRESH) return;
    partDrag.active = true;
    const pos = meshObj.geometry.attributes.position;
    partDrag.base = Float32Array.from(pos.array);        // snapshot to offset from / restore
    partDrag.verts = [];
    for (let v = 0; v < lastMesh.owners.length; v++) if (lastMesh.owners[v] === partDrag.owner) partDrag.verts.push(v);
  }
  const d = dragDelta(e, partDrag.point, e.shiftKey);
  if (!d) return;
  partDrag.delta.copy(d);
  const pos = meshObj.geometry.attributes.position;
  const base = partDrag.base;
  for (const v of partDrag.verts) {
    pos.setXYZ(v, base[v * 3] + d.x, base[v * 3 + 1] + d.y, base[v * 3 + 2] + d.z);
  }
  pos.needsUpdate = true;
}

function restorePartDrag() {
  if (partDrag?.base && meshObj) {
    meshObj.geometry.attributes.position.array.set(partDrag.base);
    meshObj.geometry.attributes.position.needsUpdate = true;
  }
}

async function endPartDrag(e) {
  if (!partDrag.active) return;                          // never crossed threshold → treated as a click
  const d = partDrag.delta;
  const base = partDrag.base;                            // capture before the caller nulls partDrag
  const restore = () => { if (base && meshObj) { meshObj.geometry.attributes.position.array.set(base); meshObj.geometry.attributes.position.needsUpdate = true; } };
  if (d.x === 0 && d.y === 0 && d.z === 0) { restore(); return; }
  const partId = partDrag.partId;
  const node = doc.nodes[partId];
  const delta = [tidyNumber(d.x), tidyNumber(d.y), tidyNumber(d.z)]; // world == document space
  try {
    if (node && node.type === 'transform') {
      const cur = Array.isArray(node.params?.translate) ? node.params.translate : [0, 0, 0];
      const t = cur.map((v, i) => tidyNumber((Number(v) || 0) + delta[i]));
      await patch(`/nodes/${partId}`, { params: { translate: t } });
    } else {
      const created = await post('/nodes', {
        type: 'transform', name: `${node ? node.name : partId}_move`,
        params: { translate: delta }, inputs: { shape: partId },
      });
      if (doc.output === partId) await post('/document/output', { node: created.id });
      else rewireOutputInput(partId, created.id);
    }
    // the resulting document_changed re-fetches the mesh (correct positions); no manual restore
  } catch (err) { showErr(err); restore(); }
}

// Replace a reference to `oldId` with `newId` in whichever input slot of the output node holds it.
function rewireOutputInput(oldId, newId) {
  const outNode = doc.nodes[doc.output];
  if (!outNode) return;
  const spec = catalog[outNode.type] || { inputs: {} };
  for (const slot of Object.keys(spec.inputs)) {
    const ref = outNode.inputs?.[slot];
    if (Array.isArray(ref)) {
      if (ref.includes(oldId)) { patch(`/nodes/${doc.output}`, { inputs: { [slot]: ref.map((id) => (id === oldId ? newId : id)) } }).catch(showErr); return; }
    } else if (ref === oldId) {
      patch(`/nodes/${doc.output}`, { inputs: { [slot]: newId } }).catch(showErr); return;
    }
  }
}

// ---- STEP face picking + extrude (feature: pick a B-rep face → extrude_face)

const assetCache = {};        // asset id -> full geometry {positions, indices, faces, ...}
let overlayObjs = [];         // [{ mesh, assetId, faces }] invisible raycast targets
let highlightObj = null;      // emissive overlay of the hovered face's triangles
let hoverFace = null;         // { assetId, face } currently under the cursor

async function getAsset(id) {
  if (assetCache[id]) return assetCache[id];
  const a = await api(`/assets/${encodeURIComponent(id)}`);
  assetCache[id] = a;
  return a;
}

// Triangle index -> B-rep face index via binary search over the contiguous {first,count} ranges.
function faceOfTriangle(faces, tri) {
  let lo = 0, hi = faces.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, f = faces[mid];
    if (tri < f.first) hi = mid - 1;
    else if (tri >= f.first + f.count) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Resolve a param scalar that may be a number, numeric string, or var name. */
function numParam(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(v);
  if (!Number.isNaN(n)) return n;
  return typeof doc.vars?.[v] === 'number' ? doc.vars[v] : 0;
}

/** Node ids on the input path from `fromId` down to `targetId` (or null). */
function pathToNode(fromId, targetId, seen = new Set()) {
  if (fromId === targetId) return [fromId];
  if (!fromId || seen.has(fromId)) return null;
  seen.add(fromId);
  const node = doc.nodes[fromId];
  if (!node) return null;
  for (const ref of Object.values(node.inputs || {})) {
    for (const id of Array.isArray(ref) ? ref : ref ? [ref] : []) {
      const rest = pathToNode(id, targetId, seen);
      if (rest) return [fromId, ...rest];
    }
  }
  return null;
}

/**
 * Where the graph actually displays `nodeId`: the composition of every
 * `transform` node between the output and it (outer to inner). Euler order
 * 'ZYX' matches the kernel's R = Rz*Ry*Rx.
 */
function displayMatrixFor(nodeId) {
  const m = new THREE.Matrix4();
  const path = doc.output ? pathToNode(doc.output, nodeId) : null;
  if (!path) return m;
  const d = Math.PI / 180;
  for (const id of path) {
    const n = doc.nodes[id];
    if (n.type !== 'transform') continue;
    const t = (n.params?.translate || [0, 0, 0]).map(numParam);
    const r = (n.params?.rotate || [0, 0, 0]).map(numParam);
    const s = numParam(n.params?.scale ?? 1) || 1;
    m.multiply(new THREE.Matrix4().compose(
      new THREE.Vector3(t[0], t[1], t[2]),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] * d, r[1] * d, r[2] * d, 'ZYX')),
      new THREE.Vector3(s, s, s)
    ));
  }
  return m;
}

async function enterFaceMode() {
  const imported = Object.values(doc.nodes).filter((n) => n.type === 'imported_mesh' && n.params?.asset);
  if (!imported.length) { showErr(new Error('no imported mesh to pick a face on')); return; }
  faceMode = true;
  $('#pickFace').classList.add('active');
  clearFaceOverlays();
  showOk('LOADING STEP GEOMETRY…');
  for (const n of imported) {
    try {
      const asset = await getAsset(n.params.asset);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(asset.positions, 3));
      geo.setIndex(asset.indices);
      // Ghosted so there is something to aim at even when the rendered output
      // (e.g. a drape) doesn't show the import itself.
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0x7f8fa0, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide,
      }));
      // Place the overlay where the graph displays this import (transform chain).
      displayMatrixFor(n.id).decompose(mesh.position, mesh.quaternion, mesh.scale);
      scene.add(mesh);
      overlayObjs.push({ mesh, assetId: n.params.asset, faces: asset.faces || [] });
    } catch (err) { showErr(err); }
  }
  if (overlayObjs.length) showOk('PICK A FACE');
}

function exitFaceMode() {
  faceMode = false;
  hoverFace = null;
  $('#pickFace').classList.remove('active');
  clearFaceOverlays();
}

function clearFaceOverlays() {
  for (const o of overlayObjs) { scene.remove(o.mesh); o.mesh.geometry.dispose(); o.mesh.material.dispose(); }
  overlayObjs = [];
  clearFaceHighlight();
}
function clearFaceHighlight() {
  if (highlightObj) { scene.remove(highlightObj); highlightObj.geometry.dispose(); highlightObj.material.dispose(); highlightObj = null; }
}

let lastFaceHover = 0;
function faceHover(e) {
  // Imported meshes can be 100k+ triangles and three's raycast is brute-force;
  // cap the hover work so pointer movement stays smooth.
  const now = performance.now();
  if (now - lastFaceHover < 30) return;
  lastFaceHover = now;
  raycaster.setFromCamera(pointerNDC(e), camera);
  const hits = raycaster.intersectObjects(overlayObjs.map((o) => o.mesh), false);
  if (!hits.length) { clearFaceHighlight(); hoverFace = null; return; }
  const hit = hits[0];
  const ov = overlayObjs.find((o) => o.mesh === hit.object);
  const face = faceOfTriangle(ov.faces, hit.faceIndex);
  if (face < 0) { clearFaceHighlight(); hoverFace = null; return; }
  hoverFace = { assetId: ov.assetId, face };
  showFaceHighlight(ov, face);
}

function showFaceHighlight(ov, faceIdx) {
  const asset = assetCache[ov.assetId];
  const f = ov.faces[faceIdx];
  const idx = asset.indices, p = asset.positions;
  const verts = new Float32Array(f.count * 9);
  for (let t = 0; t < f.count; t++) {
    const tri = f.first + t;
    for (let k = 0; k < 3; k++) {
      const vi = idx[tri * 3 + k];
      verts[t * 9 + k * 3] = p[vi * 3];
      verts[t * 9 + k * 3 + 1] = p[vi * 3 + 1];
      verts[t * 9 + k * 3 + 2] = p[vi * 3 + 2];
    }
  }
  clearFaceHighlight();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  highlightObj = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xe35a1e, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthTest: false }));
  highlightObj.renderOrder = 3;
  // Same placement as the overlay it was picked on.
  highlightObj.position.copy(ov.mesh.position);
  highlightObj.quaternion.copy(ov.mesh.quaternion);
  highlightObj.scale.copy(ov.mesh.scale);
  scene.add(highlightObj);
}

async function doFaceExtrude() {
  if (!hoverFace) return;
  const { assetId, face } = hoverFace;
  const sel = selectedNodes.size === 1 ? doc.nodes[[...selectedNodes][0]] : null;
  try {
    if (sel && sel.type === 'extrude_face' && sel.params?.asset === assetId) {
      await patch(`/nodes/${sel.id}`, { params: { face } });
      showOk(`FACE ${face}`);
    } else {
      await post('/nodes', { type: 'extrude_face', params: { asset: assetId, face, distance: 10 } });
      showOk(`EXTRUDE FACE ${face}`);
    }
  } catch (err) { showErr(err); }
}

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ------------------------------------------------------------ 3D mouse (3Dconnexion SpaceMouse)
//
// "Object mode": the model is in your hand. Push the cap right/up and the model moves
// right/up; push it away to zoom in; tilt to tumble, twist to spin. Roll (ry) has no
// meaning in a Z-up turntable camera and is ignored. Left button = home, right = fit.

const SM_DEFAULTS = {
  pan: 1, zoom: 1, orbit: 1, deadzone: 0.05,
  invert: { x: false, y: false, z: false, rx: false, ry: false, rz: false },
};
function loadSmSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('cadgang:spacemouse') || 'null');
    if (saved && typeof saved === 'object') {
      return { ...SM_DEFAULTS, ...saved, invert: { ...SM_DEFAULTS.invert, ...(saved.invert || {}) } };
    }
  } catch { /* corrupt entry → defaults */ }
  return { ...SM_DEFAULTS, invert: { ...SM_DEFAULTS.invert } };
}
let smSettings = loadSmSettings();
const saveSmSettings = () => localStorage.setItem('cadgang:spacemouse', JSON.stringify(smSettings));

const settingsModal = $('#settingsModal');
const mousePane = settingsModal.querySelector('[data-pane="mouse"]');
const mousePaneVisible = () => !settingsModal.classList.contains('hidden') && !mousePane.classList.contains('hidden');
let smStatusText = 'not connected', smStatusKind = '';

const sm = createSpaceMouse({
  // `?nohid` simulates a browser without WebHID (Safari/Firefox) for testing the fallback path
  disableHid: new URLSearchParams(location.search).has('nohid'),
  onStatus: ({ connected, transport, name, error }) => {
    smStatusText = error ? `error · ${error}`
      : connected ? `${name} · ${transport === 'hid' ? 'WebHID' : 'Gamepad API'}` : 'not connected';
    smStatusKind = error ? 'err' : connected ? 'ok' : '';
    if (error) showErr(new Error(error));
    else if (connected) showOk(`3D MOUSE · ${name.toUpperCase()}`);
    if (mousePaneVisible()) syncSmForm();
  },
  onButton: (i, pressed) => {
    if (!pressed) return;
    if (i === 0) homeView();
    else if (i === 1) fitView();
  },
});
sm.autoConnect();

const SM_ROT = 2.2;   // rad/s at full deflection (× the ORBIT slider)
const SM_PAN = 0.8;   // view-widths per second at full deflection (× PAN)
const SM_ZOOM = 1.2;  // e-folds of camera distance per second (× ZOOM)
const _smRight = new THREE.Vector3(), _smUp = new THREE.Vector3();
function driveSpaceMouse(dt, now) {
  const a = sm.poll(now, { deadzone: smSettings.deadzone });
  if (!a) return;
  const inv = smSettings.invert;
  const g = (k) => (inv[k] ? -a[k] : a[k]);
  _smRight.setFromMatrixColumn(camera.matrix, 0);
  _smUp.setFromMatrixColumn(camera.matrix, 1);
  // moving the model right on screen == moving the camera target left (same as right-drag pan)
  const pan = orbit.dist * SM_PAN * smSettings.pan * dt;
  orbit.target.addScaledVector(_smRight, -g('x') * pan);
  orbit.target.addScaledVector(_smUp, -g('z') * pan);
  orbit.dist = clamp(orbit.dist * Math.exp(-g('y') * SM_ZOOM * smSettings.zoom * dt), 2, 2000);
  const rot = SM_ROT * smSettings.orbit * dt;
  orbit.yaw -= g('rz') * rot;   // twist counter-clockwise → model spins counter-clockwise (as a right-drag does)
  orbit.pitch = clamp(orbit.pitch + g('rx') * rot, -1.45, 1.45);
  applyCamera();
}

// ---- settings modal: connect, live axis readout, speeds, per-axis invert

const smAxisFills = {};
const smAxisVals = {};
{
  const host = $('#smAxes');
  const LABEL = { x: 'X pan', y: 'Y zoom', z: 'Z pan', rx: 'RX tilt', ry: 'RY roll', rz: 'RZ twist' };
  for (const k of SM_AXES) {
    const row = document.createElement('div');
    row.className = 'sm-axis' + (k === 'ry' ? ' dim' : '');
    if (k === 'ry') row.title = 'Roll has no meaning in a Z-up turntable camera and is ignored';
    row.innerHTML = `<span class="sm-axis-name">${LABEL[k]}</span><span class="sm-bar"><span class="sm-fill"></span></span><span class="sm-val">0.00</span>`;
    smAxisFills[k] = row.querySelector('.sm-fill');
    smAxisVals[k] = row.querySelector('.sm-val');
    host.appendChild(row);
  }
}
function renderSmAxes(now) {
  const live = sm.state.transport && now - sm.state.at <= SM_STALE_MS;
  for (const k of SM_AXES) {
    const v = live ? (smSettings.invert[k] ? -sm.state[k] : sm.state[k]) : 0;
    const fill = smAxisFills[k];
    fill.style.left = `${50 + Math.min(0, v) * 50}%`;
    fill.style.width = `${Math.abs(v) * 50}%`;
    smAxisVals[k].textContent = (v >= 0 ? '+' : '') + v.toFixed(2);
  }
}

const SM_SLIDERS = [['pan', '#smPan'], ['zoom', '#smZoom'], ['orbit', '#smOrbit'], ['deadzone', '#smDead']];
function syncSmForm() {
  for (const [key, sel] of SM_SLIDERS) {
    const input = $(sel);
    input.value = smSettings[key];
    input.nextElementSibling.textContent = key === 'deadzone' ? `${Math.round(smSettings.deadzone * 100)}%` : `${smSettings[key].toFixed(1)}×`;
  }
  for (const box of mousePane.querySelectorAll('input[data-axis]')) box.checked = !!smSettings.invert[box.dataset.axis];
  $('#smDisconnect').disabled = !sm.state.transport;
  $('#smConnect').disabled = !sm.supported.hid;
  $('#smSupport').textContent = sm.supported.hid
    ? 'Left button = home view · right button = fit to model.'
    : 'No WebHID in this browser, so a SpaceMouse can\'t be paired here. Use Chrome, Edge or another Chromium browser over localhost or https.';
  setSettingsStatus(smStatusText, smStatusKind);
}
for (const [key, sel] of SM_SLIDERS) {
  $(sel).addEventListener('input', (e) => {
    smSettings[key] = parseFloat(e.target.value);
    saveSmSettings();
    syncSmForm();
    flashSettingsStatus(`${key === 'deadzone' ? 'dead zone' : key} · ${e.target.nextElementSibling.textContent}`);
  });
}
for (const box of mousePane.querySelectorAll('input[data-axis]')) {
  box.addEventListener('change', () => {
    smSettings.invert[box.dataset.axis] = box.checked; saveSmSettings();
    flashSettingsStatus(`${box.dataset.axis} ${box.checked ? 'inverted' : 'normal'}`);
  });
}
$('#smReset').onclick = () => { smSettings = { ...SM_DEFAULTS, invert: { ...SM_DEFAULTS.invert } }; saveSmSettings(); syncSmForm(); flashSettingsStatus('3D mouse defaults restored'); };
$('#smConnect').onclick = async () => {
  try {
    const ok = await sm.request();
    if (!ok) showOk('NO 3D MOUSE SELECTED');
  } catch (e) { showErr(e); }
  syncSmForm();
};
$('#smDisconnect').onclick = async () => { await sm.disconnect(); syncSmForm(); };
// ---- settings modal: tabs on the left, one pane on the right, status line at the foot.
// Every control applies the moment it changes; there is no save step.

const settingsStatus = $('#settingsStatus');
const SETTINGS_TABS = [...settingsModal.querySelectorAll('.settings-tab')].map((b) => b.dataset.tab);
let settingsTab = SETTINGS_TABS.includes(localStorage.getItem('cadgang:settingsTab')) ? localStorage.getItem('cadgang:settingsTab') : SETTINGS_TABS[0];
let settingsFlashTimer = null;

/** Persistent footer text (e.g. the 3D-mouse connection state). kind: '' | 'ok' | 'err' */
function setSettingsStatus(text, kind = '') {
  if (settingsFlashTimer) { clearTimeout(settingsFlashTimer); settingsFlashTimer = null; }
  settingsStatus.textContent = text;
  settingsStatus.className = 'sm-status' + (kind ? ` ${kind}` : '');
}
/** Briefly confirm an applied change, then fall back to the pane's resting status. */
function flashSettingsStatus(text) {
  setSettingsStatus(`applied · ${text}`, 'ok');
  settingsFlashTimer = setTimeout(() => { settingsFlashTimer = null; showSettingsTab(settingsTab, true); }, 1800);
}

function showSettingsTab(tab, statusOnly = false) {
  settingsTab = tab;
  localStorage.setItem('cadgang:settingsTab', tab);
  if (!statusOnly) {
    for (const b of settingsModal.querySelectorAll('.settings-tab')) b.classList.toggle('active', b.dataset.tab === tab);
    for (const p of settingsModal.querySelectorAll('.settings-pane')) p.classList.toggle('hidden', p.dataset.pane !== tab);
  }
  if (tab === 'mouse') {
    syncSmForm(); // also sets the footer to the connection state
    // Opening this pane is the only "trying to use a 3D mouse" signal a browser without
    // WebHID can give us: Safari and Firefox never enumerate the puck (their Gamepad API
    // matches joysticks and gamepads, not multi-axis controllers), so there is nothing to
    // detect at the device level. Warn once per session, dismissably.
    if (!statusOnly && !sm.supported.hid) {
      showToast('No 3D mouse support in this browser: Safari and Firefox can\'t see 3Dconnexion devices. Open cadgang in Chrome, Edge or another Chromium browser to use a SpaceMouse.', { once: 'spacemouse-nohid' });
    }
  } else if (tab === 'display') {
    if (!statusOnly) syncDisplayForm();
    setSettingsStatus('changes apply immediately');
  }
}
for (const b of settingsModal.querySelectorAll('.settings-tab')) b.onclick = () => showSettingsTab(b.dataset.tab);

function openSettings(tab = settingsTab) {
  closeModals();
  $('#modalBackdrop').classList.remove('hidden');
  settingsModal.classList.remove('hidden');
  showSettingsTab(tab);
}
$('#settingsBtn').onclick = () => openSettings();
$('#settingsClose').onclick = () => closeModals();

// Display pane: mirrors the header quick-toggles through the same setters.
function syncDisplayForm() {
  $('#setTheme').value = theme;
  $('#setColor').value = colorMode ? '1' : '0';
  $('#setSplit').value = splitLayout;
  $('#setRes').value = $('#resolution').value;
  $('#setResValue').textContent = $('#resolution').value;
}
$('#setTheme').onchange = (e) => { setTheme(e.target.value); flashSettingsStatus(`theme ${theme}`); };
$('#setColor').onchange = (e) => { setColorMode(e.target.value === '1'); flashSettingsStatus(colorMode ? 'per-part colour' : 'stainless'); };
$('#setSplit').onchange = (e) => { setSplit(e.target.value); flashSettingsStatus(splitLayout === 'stacked' ? 'stacked layout' : 'side-by-side layout'); };
$('#setRes').oninput = (e) => { $('#resolution').value = e.target.value; $('#resolutionValue').textContent = e.target.value; $('#setResValue').textContent = e.target.value; };
$('#setRes').onchange = (e) => { refreshMesh(); flashSettingsStatus(`resolution ${e.target.value}`); };

let lastFrame = performance.now();
(function animate(now) {
  requestAnimationFrame(animate);
  const dt = clamp((now - lastFrame) / 1000, 0, 0.05); // cap so a background tab can't lurch on return
  lastFrame = now;
  driveSpaceMouse(dt, now);
  if (mousePaneVisible()) renderSmAxes(now);
  renderer.render(scene, camera);
})(lastFrame);

// ------------------------------------------------------------ meshing

let framedOnce = false;
let meshInFlight = false, meshAgain = false;
let lastMesh = null; // { owners, partIds } from the most recent colored mesh, for retinting
let meshSignature = null; // geometry signature the current mesh reflects; refreshDocument skips re-meshing when unchanged

// Stable, key-sorted stringify so the signature is order-independent.
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
// Signature of everything the mesh depends on — EXCLUDES pos and name (moves/renames don't re-mesh).
function geometrySignature() {
  const nodes = Object.keys(doc.nodes).sort().map((id) => {
    const n = doc.nodes[id];
    return { id, type: n.type, params: n.params ?? {}, inputs: n.inputs ?? {} };
  });
  return stableStringify({ nodes, output: doc.output ?? null, vars: doc.vars ?? {} });
}

// Paint per-vertex colors onto a geometry from owners[]/partIds[]; returns true if applied.
function applyMeshColors(geo, m) {
  if (!colorMode || !Array.isArray(m.owners) || !Array.isArray(m.partIds) || !m.owners.length) return false;
  const partColors = m.partIds.map(nodeColorThree);
  const colors = new Float32Array(m.owners.length * 3);
  for (let i = 0; i < m.owners.length; i++) {
    const c = partColors[m.owners[i]] || new THREE.Color(STAINLESS);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return true;
}

// Retint the existing mesh (e.g. after a theme flip) without re-fetching.
function recolorMesh() {
  if (!meshObj) return;
  if (colorMode && lastMesh && applyMeshColors(meshObj.geometry, lastMesh)) {
    material.vertexColors = true; material.color.set(0xffffff);
  } else {
    material.vertexColors = false; material.color.set(STAINLESS);
  }
  material.needsUpdate = true;
}

// ---- meshing progress bar (fed by /ws {type:"mesh_progress", pct} while a fetch is in flight)
const progressBar = $('#meshProgress');
const progressFill = $('#meshProgressFill');
let progressActive = false;   // only accept mesh_progress + show the bar while true
let stlProgress = false;      // Export STL is a navigation download with no promise to await
let stlSafety = null;

function startProgress() {
  if (progressActive) return;
  progressActive = true;
  progressBar.classList.add('on');
  progressFill.style.transition = 'none';  // snap to the 2% sliver, don't animate from a prior value
  progressFill.style.width = '2%';
  void progressFill.offsetWidth;            // reflow so the width transition applies to later updates
  progressFill.style.transition = '';
}
function setProgress(pct) {
  if (!progressActive) return;
  progressFill.style.width = Math.max(2, Math.min(100, pct * 100)) + '%';
}
function endProgress() {
  if (!progressActive) return;
  progressActive = false;
  progressFill.style.width = '100%';         // brief beat at full, then hide
  setTimeout(() => {
    if (progressActive) return;              // a new mesh began during the beat — keep the bar
    progressBar.classList.remove('on');
    progressFill.style.transition = 'none';
    progressFill.style.width = '0%';
    void progressFill.offsetWidth;
    progressFill.style.transition = '';
  }, 180);
}

async function refreshMesh() {
  if (meshInFlight) { meshAgain = true; return; }
  meshInFlight = true;
  const status = $('#status');
  try {
    if (!doc.output || Object.keys(doc.nodes).length === 0) {
      if (meshObj) { scene.remove(meshObj); meshObj.geometry.dispose(); meshObj = null; }
      setEdgeOverlay(null);
      $('#stats').textContent = 'NO OUTPUT · DOUBLE-CLICK THE CANVAS TO ADD A BLOCK';
      status.textContent = '';
      meshSignature = geometrySignature();   // "empty" mesh reflects this state → don't loop on it
      stopSpinner();
      return;
    }
    startSpinner();
    startProgress();
    status.className = 'status';
    const resolution = $('#resolution').value;
    // always request colors=1 so per-vertex owners exist for viewport part-picking/drag;
    // vertex tinting itself still only applies in colorMode (applyMeshColors guards on it)
    const m = await api(`/mesh?resolution=${resolution}&colors=1`);

    // Exact blocks ship their real B-rep edge curves; a sketch ships only those.
    // Drawing them over the shaded mesh is what makes exact geometry read as
    // exact — crisp silhouettes instead of a faceted approximation of them.
    setEdgeOverlay(m.edges);

    if (m.kind === 'sketch') {
      if (meshObj) { scene.remove(meshObj); meshObj.geometry.dispose(); meshObj = null; }
      lastMesh = null;
      meshSignature = geometrySignature();
      $('#stats').textContent = 'SKETCH · 2D PROFILE · CONNECT TO AN EXTRUDE OR REVOLVE';
      stopSpinner();
      status.textContent = `REV ${m.revision}`;
      return;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3));
    geo.setIndex(m.indices);

    // per-part coloring (falls back to stainless if the server didn't send owners yet)
    lastMesh = (Array.isArray(m.owners) && Array.isArray(m.partIds)) ? { owners: m.owners, partIds: m.partIds } : null;
    if (applyMeshColors(geo, m)) {
      material.vertexColors = true; material.color.set(0xffffff);
    } else {
      material.vertexColors = false; material.color.set(STAINLESS);
    }
    material.needsUpdate = true;

    if (meshObj) { scene.remove(meshObj); meshObj.geometry.dispose(); }
    meshObj = new THREE.Mesh(geo, material);
    scene.add(meshObj);
    meshSignature = geometrySignature();   // record only on success so a failure re-attempts

    const s = m.stats;
    // Exact solids have no sampling grid to report; what matters instead is the
    // B-rep face count, so the readout says which representation you are seeing.
    const tail = m.exact
      ? `EXACT B-REP · ${(m.faces?.length ?? 0).toLocaleString()} FACES`
      : `GRID ${s.gridDims.join('×')}`;
    $('#stats').textContent =
      `${s.triangleCount.toLocaleString()} TRIS · ${s.vertexCount.toLocaleString()} VERTS · ` +
      `${fmt(s.volume)} MM³ · ${fmt(s.surfaceArea)} MM² · ${tail}`;
    stopSpinner();
    status.textContent = `REV ${m.revision}`;

    if (!framedOnce && s.triangleCount > 0) {
      framedOnce = true;
      const b = s.bounds;
      orbit.target.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
      orbit.dist = Math.max(20, 2.2 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 * 2);
      applyCamera();
    }
  } catch (e) {
    stopSpinner();
    status.textContent = e.message;
    status.className = 'status err';
  } finally {
    meshInFlight = false;
    if (meshAgain) { meshAgain = false; refreshMesh(); }  // keep the bar up across coalesced re-meshes
    else endProgress();
  }
}

const fmt = (v) => (v >= 1000 ? Math.round(v).toLocaleString() : v.toPrecision(4));

// mono-char spinner for the "MESHING" status flag
let spinTimer = null;
const SPIN = ['/', '-', '\\', '|'];
function startSpinner() {
  const status = $('#status');
  stopSpinner();
  status.className = 'status';
  let i = 0;
  status.textContent = `MESHING ${SPIN[0]}`;
  spinTimer = setInterval(() => { i = (i + 1) % SPIN.length; status.textContent = `MESHING ${SPIN[i]}`; }, 120);
}
function stopSpinner() { if (spinTimer) { clearInterval(spinTimer); spinTimer = null; } }

function showErr(e) {
  const status = $('#status');
  status.textContent = e.message;
  status.className = 'status err';
}
function showOk(msg) {
  const status = $('#status');
  status.textContent = msg;
  status.className = 'status ok';
}

// Dismissable toast for notices that must outlive the one-line header status. One at a
// time; `once` names a sessionStorage key so a dismissed notice stays gone for the session.
const toast = $('#toast');
function showToast(msg, { once } = {}) {
  const key = once && `cadgang:toast:${once}`;
  try { if (key && sessionStorage.getItem(key)) return false; } catch { /* storage blocked */ }
  $('#toastText').textContent = msg;
  toast.dataset.once = key || '';
  toast.classList.remove('hidden');
  return true;
}
function dismissToast() {
  toast.classList.add('hidden');
  const key = toast.dataset.once;
  if (key) { try { sessionStorage.setItem(key, '1'); } catch { /* storage blocked */ } }
}
$('#toastClose').onclick = dismissToast;

// ------------------------------------------------------------ graph state

const graph = $('#graph');
const world = $('#world');
const wiresSvg = $('#wires');

const view = { x: 40, y: 40, scale: 1 };          // pan (px) + zoom
const portEls = {};                               // id -> { output: el, inputs: {slot: el} }
const layoutPos = {};                             // id -> [x, y] actually rendered (for drag start)
let nodeDrag = null;                              // active header drag (one or many selected)
let wireDrag = null;                             // active connect drag
let pendingRender = false;                       // deferred re-render while dragging
let sliderDragging = false;                      // a param slider is mid-drag (defer re-renders)
let lastSliderPatch = 0;                         // throttle live PATCHes during a slider drag
const selectedNodes = new Set();                 // marquee multi-selection (node ids)
let marquee = null;                              // active rubber-band rectangle
let spaceDown = false;                           // hold Space to pan the graph with the left button
let clipboard = [];                              // copied blocks (deep copies, keyed by original id)
let pasteOffset = 0;                             // cascading +[40,40] per successive paste of a clipboard

function clearSelection() {
  for (const el of world.querySelectorAll('.gnode.selected')) el.classList.remove('selected');
  selectedNodes.clear();
}
const rectsIntersect = (a, b) => !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);

function applyTransform() {
  closeAC(); // popover is anchored in page space; a pan/zoom would leave it stranded
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  graph.style.backgroundSize = `${24 * view.scale}px ${24 * view.scale}px`;
  graph.style.backgroundPosition = `${view.x}px ${view.y}px`;
}

function worldFromClient(clientX, clientY) {
  const g = graph.getBoundingClientRect();
  return { x: (clientX - g.left - view.x) / view.scale, y: (clientY - g.top - view.y) / view.scale };
}

function portWorldPos(el) {
  const r = el.getBoundingClientRect();
  const g = graph.getBoundingClientRect();
  const cx = r.left + r.width / 2 - g.left;
  const cy = r.top + r.height / 2 - g.top;
  return { x: (cx - view.x) / view.scale, y: (cy - view.y) / view.scale };
}

function inputIds(node, slot) {
  const v = node.inputs?.[slot];
  return Array.isArray(v) ? v.slice() : v ? [v] : [];
}

// A param value is an "expression" when it's a non-numeric string (e.g. "w/2").
function isExpr(v) { return typeof v === 'string' && !Number.isFinite(Number(String(v).trim())); }
// Keep raw expression strings; coerce clean numeric text to a number.
function coerceParamValue(raw) {
  const t = String(raw).trim();
  if (t === '') return 0;
  const num = Number(t);
  return Number.isFinite(num) ? num : t;
}
// Kill floating-point junk (0.1+0.2 → 0.3) and strip trailing zeros.
function tidyNumber(n) { return parseFloat(n.toFixed(6)); }
// CAD step size for arrow-key scrubbing: Shift = ±10, Alt/Option = ±0.1, plain = ±1.
function arrowStep(e) { return e.shiftKey ? 10 : e.altKey ? 0.1 : 1; }
// Arrow-key value stepping on a numeric text field. Returns the new number, or null
// (leave default caret behavior) when the whole value isn't a plain number or a dropdown owns the key.
function steppedValue(input, e, min) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return null;
  if (acState && acState.input === input) return null; // autocomplete owns ↑/↓ while open
  const raw = input.value.trim();
  const cur = Number(raw);
  if (raw === '' || !Number.isFinite(cur)) return null; // expression → don't step
  let next = cur + (e.key === 'ArrowUp' ? arrowStep(e) : -arrowStep(e));
  if (typeof min === 'number') next = Math.max(min, next);
  return tidyNumber(next);
}

// reserved identifiers that can't be created as variables (expression fns/constants)
const RESERVED = new Set(['sin', 'cos', 'tan', 'sqrt', 'abs', 'min', 'max', 'floor', 'ceil', 'round', 'pi']);
// pattern for "name = value" inline variable creation from a param field
const VAR_ASSIGN = /^\s*([a-zA-Z_]\w*)\s*=\s*(.+)$/;

// ------------------------------------------------------------ variable autocomplete
// Singleton popover, anchored in page space so it doesn't scale with the graph zoom.

let acEl = null;     // dropdown element (appended to <body>)
let acState = null;  // { input, start, end, matches, index }

function closeAC() {
  if (acEl) { acEl.remove(); acEl = null; }
  acState = null;
}

// The identifier token immediately left of the caret (params hold expressions like "w/2+ey").
function tokenAtCaret(input) {
  const v = input.value;
  const caret = input.selectionStart ?? v.length;
  let start = caret;
  while (start > 0 && /[A-Za-z0-9_]/.test(v[start - 1])) start--;
  return { token: v.slice(start, caret), start, end: caret };
}

function updateAC(input, opts) {
  const { token, start, end } = tokenAtCaret(input);
  if (opts.valueOnly) {                       // vars strip add-field: only complete the RHS
    const eq = input.value.indexOf('=');
    if (eq < 0 || start <= eq) { closeAC(); return; }
  }
  if (!/^[a-zA-Z_]\w*$/.test(token)) { closeAC(); return; }
  const names = Object.keys(doc.vars || {});
  const matches = names.filter((n) => n.toLowerCase().startsWith(token.toLowerCase()));
  if (!matches.length || (matches.length === 1 && matches[0] === token)) { closeAC(); return; }
  if (!acEl) { acEl = document.createElement('div'); acEl.className = 'ac-pop'; document.body.appendChild(acEl); }
  acState = { input, start, end, matches, index: 0 };
  renderAC();
  positionAC(input);
}

function renderAC() {
  acEl.innerHTML = '';
  acState.matches.forEach((name, i) => {
    const row = document.createElement('div');
    row.className = 'ac-row' + (i === acState.index ? ' active' : '');
    const nm = document.createElement('span'); nm.className = 'ac-name'; nm.textContent = name;
    const vv = document.createElement('span'); vv.className = 'ac-val'; vv.textContent = `= ${doc.vars[name]}`;
    row.append(nm, vv);
    // mousedown (not click) so we accept before the input's blur fires
    row.addEventListener('mousedown', (e) => { e.preventDefault(); acState.index = i; acceptAC(); });
    acEl.appendChild(row);
  });
}

function positionAC(input) {
  const r = input.getBoundingClientRect();
  acEl.style.left = r.left + 'px';
  acEl.style.top = (r.bottom + 2) + 'px';
  acEl.style.minWidth = Math.max(r.width, 120) + 'px';
}

function moveAC(d) {
  if (!acState) return;
  acState.index = (acState.index + d + acState.matches.length) % acState.matches.length;
  renderAC();
}

// Replace just the token under the caret with the chosen name; keep the rest, caret after it.
function acceptAC() {
  if (!acState) return;
  const { input, start, end, matches, index } = acState;
  const name = matches[index];
  const v = input.value;
  input.value = v.slice(0, start) + name + v.slice(end);
  const caret = start + name.length;
  // one-shot: suppress a change-commit that this accepting Enter might synchronously fire,
  // then clear on the next tick so a later blur-commit still works.
  input._acAccepted = true;
  setTimeout(() => { input._acAccepted = false; }, 0);
  closeAC();
  input.focus();
  input.setSelectionRange(caret, caret);
}

// Attach live autocomplete to a text input. The keydown listener must be registered BEFORE
// the input's own onkeydown so stopImmediatePropagation can pre-empt it while the popup is open.
function attachAutocomplete(input, opts = {}) {
  input.addEventListener('input', () => updateAC(input, opts));
  input.addEventListener('keydown', (e) => {
    if (!acState || acState.input !== input) return;   // closed → let normal handlers run
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); moveAC(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); moveAC(-1); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); acceptAC(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeAC(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (acState?.input === input) closeAC(); }, 120));
}
document.addEventListener('scroll', closeAC, true);
window.addEventListener('resize', closeAC);

// ------------------------------------------------------------ auto-layout

function computeDepths() {
  const depth = {};
  const visiting = new Set();
  function d(id) {
    if (depth[id] != null) return depth[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const n = doc.nodes[id];
    let mx = -1;
    for (const slot of Object.keys(n.inputs || {})) {
      for (const cid of inputIds(n, slot)) if (doc.nodes[cid]) mx = Math.max(mx, d(cid));
    }
    visiting.delete(id);
    return (depth[id] = mx + 1);
  }
  for (const id of Object.keys(doc.nodes)) d(id);
  return depth;
}

const COL_X = 224;   // horizontal spacing between dependency columns (auto-layout fallback)
const COL_GAP = 24;  // vertical gap between stacked nodes in a column
const WIRE_GAP = 100; // extra gap after a column's widest node so cross-column wires are visible (Arrange)

// ------------------------------------------------------------ node rendering

function makeParamInput(pname, val, index) {
  const inp = document.createElement('input');
  inp.type = 'text';                 // text (not number) so expressions like "w/2" can be typed
  inp.value = val;
  inp.dataset.param = pname;
  if (index != null) inp.dataset.index = String(index);
  inp.autocomplete = 'off'; inp.spellcheck = false;
  if (isExpr(val)) inp.classList.add('expr');
  attachAutocomplete(inp);
  return inp;
}

// A drag slider for a scalar param that has BOTH min and max (e.g. polyhedron p/q/r 0..1).
// Lives alongside the text field so expressions still work; disabled when the value is an
// expression. Dragging PATCHes live (throttled) so the mesh morphs in the viewport.
function makeSlider(pname, pdef, val, numInput, nodeId) {
  const range = pdef.max - pdef.min;
  const step = range <= 2 ? 0.01 : range <= 20 ? 0.1 : 1;
  const s = document.createElement('input');
  s.type = 'range'; s.className = 'param-slider';
  s.min = pdef.min; s.max = pdef.max; s.step = step;
  if (isExpr(val)) { s.disabled = true; s.value = pdef.min; }
  else s.value = clamp(Number(val), pdef.min, pdef.max);
  const sendPatch = (v) => patch(`/nodes/${nodeId}`, { params: { [pname]: v } }).catch(showErr);
  s.addEventListener('input', () => {
    sliderDragging = true;
    const v = tidyNumber(Number(s.value));
    numInput.value = v; numInput.classList.remove('expr');
    const now = performance.now();
    if (now - lastSliderPatch >= 90) { lastSliderPatch = now; sendPatch(v); } // throttle the storm
  });
  s.addEventListener('change', () => {              // drag released: authoritative final value
    sliderDragging = false;
    const v = tidyNumber(Number(s.value));
    numInput.value = v; sendPatch(v);
    flushPending();
  });
  return s;
}

function renderGraph() {
  closeAC(); // inputs are about to be replaced
  // capture focus so a re-render doesn't interrupt typing in a param field
  const active = document.activeElement;
  let restore = null;
  if (active && active.matches?.('.gnode input[data-param]')) {
    const nodeEl = active.closest('.gnode');
    restore = {
      id: nodeEl?.dataset.id, param: active.dataset.param, index: active.dataset.index,
      selStart: active.selectionStart, selEnd: active.selectionEnd, value: active.value,
    };
  }

  // clear nodes (keep the svg element)
  for (const el of [...world.querySelectorAll('.gnode')]) el.remove();
  for (const k of Object.keys(portEls)) delete portEls[k];

  const depth = computeDepths();
  for (const k of Object.keys(layoutPos)) delete layoutPos[k];

  for (const node of Object.values(doc.nodes)) {
    const spec = catalog[node.type] || { params: {}, inputs: {}, category: '' };
    const el = document.createElement('div');
    el.className = 'gnode cat-' + (spec.category || 'primitive') + (doc.output === node.id ? ' output' : '');
    if (selectedNodes.has(node.id)) el.classList.add('selected');
    el.dataset.id = node.id;
    if (colorMode) el.style.setProperty('--stripe', nodeColorCss(node.id) || '');
    if (node.pos) {
      el.style.left = node.pos[0] + 'px';
      el.style.top = node.pos[1] + 'px';
      layoutPos[node.id] = [node.pos[0], node.pos[1]];
    } else {
      // x by dependency depth; y assigned in the measured second pass below
      el.style.left = (depth[node.id] * COL_X + 40) + 'px';
      el.dataset.auto = '1';
    }

    // header
    const head = document.createElement('div');
    head.className = 'gnode-head';
    head.innerHTML =
      `<span class="badge">${node.type}</span>` +
      `<span class="gname" title="${node.id}">${node.name}</span>` +
      `<button class="oradio ${doc.output === node.id ? 'on' : ''}" title="Make this the model output">OUT</button>` +
      `<button class="odel" title="Delete block">×</button>`;
    el.appendChild(head);

    const body = document.createElement('div');
    body.className = 'gnode-body';

    portEls[node.id] = { output: null, inputs: {} };

    // input ports (one row each)
    for (const [slot, sdef] of Object.entries(spec.inputs)) {
      const row = document.createElement('div');
      row.className = 'port-row';
      const port = document.createElement('span');
      port.className = 'gport in' + (inputIds(node, slot).length ? ' connected' : '');
      port.dataset.node = node.id; port.dataset.slot = slot; port.dataset.kind = 'in';
      port.title = sdef.description || slot;
      const label = document.createElement('span');
      label.className = 'plabel';
      label.textContent = slot + (sdef.many ? ' *' : '');
      row.appendChild(port); row.appendChild(label);
      body.appendChild(row);
      portEls[node.id].inputs[slot] = port;
      attachPortDrag(port);
    }

    // params
    for (const [pname, pdef] of Object.entries(spec.params)) {
      const val = node.params?.[pname] ?? pdef.default;
      const row = document.createElement('div');
      row.className = 'param-row' + (pdef.type === 'vec3' ? ' vec3' : '');
      const name = document.createElement('span');
      name.className = 'pname'; name.title = pdef.description || ''; name.textContent = pname;
      if (pdef.type === 'asset') {
        const meta = doc.assets?.[val];
        if (val) {
          // asset set → read-only name (id fallback if metadata is missing)
          const pv = document.createElement('span');
          pv.className = 'pval';
          pv.textContent = meta ? meta.name : val;
          pv.title = val;
          row.append(name, pv);
        } else {
          // no asset → clickable affordance to load a file into THIS node
          const load = document.createElement('button');
          load.type = 'button'; load.className = 'pload'; load.textContent = 'load file…';
          load.title = 'Import a STEP / IGES / BREP file into this block';
          load.onclick = (e) => { e.stopPropagation(); openImportPicker(node.id); };
          row.append(name, load);
        }
      } else if (pdef.type === 'text') {
        // free-text param (e.g. export filename): plain string input, no expr/number handling
        const inp = document.createElement('input');
        inp.type = 'text'; inp.className = 'ptext'; inp.value = val ?? '';
        inp.autocomplete = 'off'; inp.spellcheck = false;
        inp.onchange = () => patch(`/nodes/${node.id}`, { params: { [pname]: inp.value } }).catch(showErr);
        row.append(name, inp);
      } else if (pdef.type === 'vec3' || pdef.type === 'vec2') {
        const n = pdef.type === 'vec3' ? 3 : 2;
        row.appendChild(name);
        const triple = document.createElement('div');
        triple.className = 'triple';
        const arr = Array.isArray(val) ? val : new Array(n).fill(val);
        for (let i = 0; i < n; i++) triple.appendChild(makeParamInput(pname, arr[i], i));
        row.appendChild(triple);
      } else if (pdef.type === 'select') {
        // fixed vocabulary (sketch plane, boolean op, edge selection)
        const sel = document.createElement('select');
        sel.className = 'pselect';
        for (const opt of pdef.options || []) {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          if (String(val) === opt) o.selected = true;
          sel.appendChild(o);
        }
        sel.onchange = () => patch(`/nodes/${node.id}`, { params: { [pname]: sel.value } }).catch(showErr);
        sel.onmousedown = (e) => e.stopPropagation();   // don't start a node drag
        row.append(name, sel);
      } else if (pdef.type === 'bool') {
        const box = document.createElement('input');
        box.type = 'checkbox'; box.className = 'pcheck';
        box.checked = val === true || val === 'true' || val === 1;
        box.onchange = () => patch(`/nodes/${node.id}`, { params: { [pname]: box.checked } }).catch(showErr);
        box.onmousedown = (e) => e.stopPropagation();
        row.append(name, box);
      } else if (pdef.type === 'points') {
        // Sketch profile: one "x, y[, cornerRadius]" per line. Editing as text
        // keeps the whole profile visible and diffable; a canvas sketcher would
        // be the next step, and would write into this same param.
        row.classList.add('points');
        const ta = document.createElement('textarea');
        ta.className = 'ppoints'; ta.spellcheck = false; ta.rows = Math.min(10, (val?.length || 1) + 1);
        ta.value = (Array.isArray(val) ? val : []).map((p) => p.join(', ')).join('\n');
        ta.onmousedown = (e) => e.stopPropagation();
        ta.onchange = () => {
          const pts = ta.value.split('\n').map((l) => l.trim()).filter(Boolean)
            .map((l) => l.split(/[,\s]+/).map((s) => (/^-?\d*\.?\d+$/.test(s) ? Number(s) : s)));
          patch(`/nodes/${node.id}`, { params: { [pname]: pts } }).catch(showErr);
        };
        row.append(name, ta);
      } else {
        const numInput = makeParamInput(pname, val, null);
        if (Number.isFinite(pdef.min) && Number.isFinite(pdef.max)) {
          // bounded scalar: label + number on top, a full-width drag slider below
          row.classList.add('has-slider');
          const top = document.createElement('div');
          top.className = 'pslider-top';
          top.append(name, numInput);
          row.append(top, makeSlider(pname, pdef, val, numInput, node.id));
        } else {
          row.append(name, numInput);
        }
      }
      body.appendChild(row);
    }

    // export sinks get a download button (disabled until a shape is connected)
    if (node.type === 'export_stl' || node.type === 'export_step') {
      const step = node.type === 'export_step';
      const row = document.createElement('div');
      row.className = 'export-row';
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'export-dl'; btn.textContent = step ? '⤓ STEP' : '⤓ STL';
      if (!inputIds(node, 'shape').length) { btn.disabled = true; btn.title = 'connect a shape to export'; }
      else btn.title = step ? 'Download exact B-rep STEP' : 'Download binary STL';
      btn.onclick = (e) => { e.stopPropagation(); downloadExport(node, step ? 'step' : 'stl'); };
      row.appendChild(btn);
      body.appendChild(row);
    }

    el.appendChild(body);

    // output port
    const out = document.createElement('span');
    out.className = 'gport out';
    out.dataset.node = node.id; out.dataset.kind = 'out';
    out.title = 'output';
    el.appendChild(out);
    portEls[node.id].output = out;
    attachPortDrag(out);

    // interactions
    head.querySelector('.oradio').onclick = (e) => { e.stopPropagation(); post('/document/output', { node: node.id }).catch(showErr); };
    head.querySelector('.odel').onclick = (e) => { e.stopPropagation(); del(`/nodes/${node.id}`).catch(showErr); };
    head.querySelector('.gname').ondblclick = (e) => { e.stopPropagation(); startRename(head.querySelector('.gname'), node); };

    body.querySelectorAll('input[data-param]').forEach((input) => {
      const pname = input.dataset.param;
      const pdef = spec.params[pname];
      const commitParam = (overrideThisField) => {
        if (overrideThisField != null) input.value = overrideThisField;
        const value = pdef.type === 'vec3'
          ? [...body.querySelectorAll(`input[data-param="${pname}"]`)].map((el2) => coerceParamValue(el2.value))
          : coerceParamValue(input.value);
        patch(`/nodes/${node.id}`, { params: { [pname]: value } }).catch(showErr);
      };
      // ↑/↓ live-scrub numeric fields (min-clamped per catalog); one PATCH per press
      input.addEventListener('keydown', (e) => {
        const next = steppedValue(input, e, pdef?.min);
        if (next == null) return;
        e.preventDefault();
        input.value = next;
        input.classList.remove('expr');
        commitParam(null);
      });
      input.onchange = () => {
        // an autocomplete accept via Enter changed the value but should not commit the field
        if (input._acAccepted) { input._acAccepted = false; return; }
        // inline variable creation: "name = value" → create the var, then reference it by name
        const m = input.value.match(VAR_ASSIGN);
        if (m && !RESERVED.has(m[1].toLowerCase())) {
          const name = m[1], rhs = m[2].trim();
          (async () => {
            try {
              await post('/vars', { name, value: coerceParamValue(rhs) });
            } catch (e) {
              showErr(e);          // bad expression: leave the field in edit state, don't patch
              input.focus();
              return;
            }
            showOk(`VAR ${name.toUpperCase()} = ${rhs}`);
            commitParam(name);     // var exists now → point this param at it
          })();
          return;
        }
        commitParam(null);
      };
    });

    attachNodeDrag(el, head, node);
    world.appendChild(el);
  }

  // second pass: stack auto-laid-out nodes using their REAL measured heights,
  // so tall cards (many param rows) don't overlap the card below in a column.
  const cols = {};
  for (const node of Object.values(doc.nodes)) {
    if (node.pos) continue;
    (cols[depth[node.id]] ??= []).push(node.id);
  }
  for (const ids of Object.values(cols)) {
    ids.sort();
    let y = 40;
    for (const id of ids) {
      const el = world.querySelector(`.gnode[data-id="${id}"]`);
      el.style.top = y + 'px';
      layoutPos[id] = [parseFloat(el.style.left), y];
      y += el.offsetHeight + COL_GAP;
    }
  }

  renderWires();

  if (restore && doc.nodes[restore.id]) {
    const sel = restore.index != null
      ? `.gnode[data-id="${restore.id}"] input[data-param="${restore.param}"][data-index="${restore.index}"]`
      : `.gnode[data-id="${restore.id}"] input[data-param="${restore.param}"]`;
    const el = world.querySelector(sel);
    if (el) {
      // keep the user's in-flight value (mid-scrub / mid-type) rather than the lagging server value
      if (restore.value != null && el.value !== restore.value) el.value = restore.value;
      el.focus();
      try { el.setSelectionRange(restore.selStart, restore.selEnd); } catch {}
    }
  }

  for (const id of [...selectedNodes]) if (!doc.nodes[id]) selectedNodes.delete(id); // drop deleted nodes
  updateToolButtons();
}

// Show the viewport "Pick face" button only when there's an imported mesh to pick on.
function updateToolButtons() {
  const hasImport = Object.values(doc.nodes).some((n) => n.type === 'imported_mesh' && n.params?.asset);
  $('#pickFace').classList.toggle('hidden', !hasImport);
  if (!hasImport && faceMode) exitFaceMode();
}

function startRename(span, node) {
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'gname-edit'; input.value = node.name;
  span.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save && input.value.trim() && input.value.trim() !== node.name) {
      patch(`/nodes/${node.id}`, { name: input.value.trim() }).catch(showErr);
    } else {
      renderGraph();
    }
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  };
  input.onblur = () => commit(true);
  input.onpointerdown = (e) => e.stopPropagation();
}

// ------------------------------------------------------------ wires

function bezier(a, b) {
  const k = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + k} ${a.y}, ${b.x - k} ${b.y}, ${b.x} ${b.y}`;
}

// Drop any stale wire-hover block highlights (the wire paths are rebuilt often, so a
// pointerleave can be missed when the hovered path is destroyed mid-hover).
function clearWireHover() {
  for (const el of world.querySelectorAll('.gnode.wire-hover')) el.classList.remove('wire-hover');
}

function renderWires() {
  clearWireHover();
  wiresSvg.innerHTML = '';
  for (const node of Object.values(doc.nodes)) {
    for (const slot of Object.keys((catalog[node.type] || { inputs: {} }).inputs)) {
      const inPort = portEls[node.id]?.inputs[slot];
      if (!inPort) continue;
      for (const srcId of inputIds(node, slot)) {
        const outPort = portEls[srcId]?.output;
        if (!outPort) continue;
        const a = portWorldPos(outPort), b = portWorldPos(inPort);
        const g = document.createElementNS(SVGNS, 'g');
        g.setAttribute('class', 'wire-group');
        const hit = document.createElementNS(SVGNS, 'path');
        hit.setAttribute('class', 'wire-hit');
        hit.setAttribute('d', bezier(a, b));
        const wire = document.createElementNS(SVGNS, 'path');
        wire.setAttribute('class', 'wire');
        wire.setAttribute('d', bezier(a, b));
        // hovering the wire highlights both endpoint blocks (distinct from the selection ring)
        const toId = node.id;
        const setHover = (on) => {
          g.classList.toggle('hover', on);
          world.querySelector(`.gnode[data-id="${srcId}"]`)?.classList.toggle('wire-hover', on);
          world.querySelector(`.gnode[data-id="${toId}"]`)?.classList.toggle('wire-hover', on);
        };
        hit.addEventListener('pointerenter', () => setHover(true));
        hit.addEventListener('pointerleave', () => setHover(false));
        // double-click to disconnect; stop it bubbling to the canvas create-node dblclick
        hit.addEventListener('dblclick', (e) => { e.stopPropagation(); e.preventDefault(); setHover(false); disconnect(node, slot, srcId); });
        // right-click as the alternate disconnect
        hit.addEventListener('contextmenu', (e) => { e.stopPropagation(); e.preventDefault(); setHover(false); disconnect(node, slot, srcId); });
        g.appendChild(hit); g.appendChild(wire);
        wiresSvg.appendChild(g);
      }
    }
  }
}

function disconnect(node, slot, srcId) {
  const sdef = (catalog[node.type] || { inputs: {} }).inputs[slot] || {};
  if (sdef.many) {
    const ids = inputIds(node, slot).filter((id) => id !== srcId);
    patch(`/nodes/${node.id}`, { inputs: { [slot]: ids } }).catch(showErr);
  } else {
    patch(`/nodes/${node.id}`, { inputs: { [slot]: null } }).catch(showErr);
  }
}

// ------------------------------------------------------------ node drag

function attachNodeDrag(el, head, node) {
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, .gname')) return;
    e.stopPropagation();
    head.setPointerCapture?.(e.pointerId);
    // dragging a member of a multi-selection moves the whole selection together;
    // dragging an unselected node drops the current selection first
    let ids;
    if (selectedNodes.has(node.id) && selectedNodes.size > 1) {
      ids = [...selectedNodes].filter((id) => doc.nodes[id]);
    } else {
      if (!selectedNodes.has(node.id)) clearSelection();
      ids = [node.id];
    }
    const items = ids.map((id) => {
      const nel = world.querySelector(`.gnode[data-id="${id}"]`);
      const start = doc.nodes[id].pos || layoutPos[id] || [40, 40];
      return { id, el: nel, startX: start[0], startY: start[1] };
    });
    nodeDrag = { items, pointer: e.pointerId, mx: e.clientX, my: e.clientY };
  });
}

// ------------------------------------------------------------ port drag / connect

function attachPortDrag(port) {
  port.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    port.setPointerCapture?.(e.pointerId);
    wireDrag = {
      kind: port.dataset.kind, node: port.dataset.node, slot: port.dataset.slot,
      origin: portWorldPos(port), pointer: e.pointerId,
    };
    // temp wire path
    const temp = document.createElementNS(SVGNS, 'path');
    temp.setAttribute('class', 'wire-temp');
    temp.setAttribute('id', 'wireTemp');
    wiresSvg.appendChild(temp);
  });
}

/** Resolve the wire a drop on `target` would make, or null if it makes none. */
function pendingConnection(target) {
  if (!target || !wireDrag) return null;
  if (target.dataset.kind === wireDrag.kind) return null;   // in→in or out→out
  const [outNode, inNode, slot] = wireDrag.kind === 'out'
    ? [wireDrag.node, target.dataset.node, target.dataset.slot]
    : [target.dataset.node, wireDrag.node, wireDrag.slot];
  if (outNode === inNode) return null;                      // self-connection
  const node = doc.nodes[inNode];
  const sdef = (catalog[node.type] || { inputs: {} }).inputs[slot] || {};
  return { outNode, inNode, slot, sdef };
}

/**
 * Whether a block's output is the kind of thing a slot can use.
 *
 * A sketch has no volume, so it belongs only in slots that ask for one; and the
 * bridge runs B-rep -> field only, so a field can never feed a 'brep' slot.
 * Both are refused by the kernel anyway — catching them at the wire means the
 * graph never enters a state whose only symptom is a red status bar.
 */
function slotAccepts(srcType, sdef) {
  const src = (catalog[srcType] || {}).kind || 'field';
  const want = sdef.kind || 'any';
  return want === 'any' ? src !== 'sketch' : src === want;
}

const WANT_LABEL = { sketch: 'a sketch', brep: 'an exact B-rep solid' };

function finishConnect(clientX, clientY) {
  const target = document.elementFromPoint(clientX, clientY)?.closest('.gport');
  document.getElementById('wireTemp')?.remove();
  const link = pendingConnection(target);
  if (!link) return;
  const { outNode, inNode, slot, sdef } = link;

  const node = doc.nodes[inNode];
  if (!slotAccepts(doc.nodes[outNode].type, sdef)) {
    const want = WANT_LABEL[sdef.kind] || 'a solid';
    showErr(new Error(`'${slot}' on ${node.name || inNode} needs ${want}, not ${doc.nodes[outNode].type}`));
    return;
  }
  if (sdef.many) {
    const ids = inputIds(node, slot);
    if (!ids.includes(outNode)) ids.push(outNode);
    patch(`/nodes/${inNode}`, { inputs: { [slot]: ids } }).catch(showErr);
  } else {
    patch(`/nodes/${inNode}`, { inputs: { [slot]: outNode } }).catch(showErr);
  }
}

// ------------------------------------------------------------ canvas pan / zoom

// Right-drag pans, so keep the native context menu off the empty canvas
// (wire right-click disconnect handles itself and stops propagation).
graph.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.gnode')) e.preventDefault();
});

graph.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.gnode')) return;
  // A pan started on a wire would capture the pointer on `graph`, retargeting the
  // derived dblclick away from the wire's disconnect handler.
  if (e.target.closest('.wire-hit')) return;
  // Buttons overlaid on the canvas (Arrange) must keep their normal click
  // behavior — capturing the pointer here would swallow the click.
  if (e.target.closest('button')) return;
  // pan: right or middle button, or Space + left drag
  if (e.button === 2 || e.button === 1 || (e.button === 0 && spaceDown)) {
    graph.classList.add('panning');
    graph.setPointerCapture?.(e.pointerId);
    graph._pan = { mx: e.clientX, my: e.clientY, px: view.x, py: view.y, pointer: e.pointerId };
    return;
  }
  if (e.button !== 0) return;
  // left drag on empty canvas → rubber-band multi-select (Shift = add to selection)
  const gr = graph.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'marquee';
  graph.appendChild(el);
  graph.setPointerCapture?.(e.pointerId);
  marquee = { sx: e.clientX, sy: e.clientY, gr, el, moved: false, additive: e.shiftKey };
});

window.addEventListener('pointermove', (e) => {
  if (marquee) {
    const x = Math.min(marquee.sx, e.clientX), y = Math.min(marquee.sy, e.clientY);
    const w = Math.abs(e.clientX - marquee.sx), h = Math.abs(e.clientY - marquee.sy);
    if (w > DRAG_THRESH || h > DRAG_THRESH) marquee.moved = true;
    marquee.el.style.left = (x - marquee.gr.left) + 'px';
    marquee.el.style.top = (y - marquee.gr.top) + 'px';
    marquee.el.style.width = w + 'px';
    marquee.el.style.height = h + 'px';
    return;
  }
  if (nodeDrag) {
    const dx = (e.clientX - nodeDrag.mx) / view.scale;
    const dy = (e.clientY - nodeDrag.my) / view.scale;
    for (const it of nodeDrag.items) {
      it.el.style.left = (it.startX + dx) + 'px';
      it.el.style.top = (it.startY + dy) + 'px';
    }
    renderWires();
    return;
  }
  if (wireDrag) {
    const temp = document.getElementById('wireTemp');
    if (temp) {
      const cur = worldFromClient(e.clientX, e.clientY);
      const a = wireDrag.origin, b = cur;
      temp.setAttribute('d', wireDrag.kind === 'out' ? bezier(a, b) : bezier(b, a));
    }
    // highlight a compatible input/output port under the cursor as a drop target
    const port = document.elementFromPoint(e.clientX, e.clientY)?.closest('.gport');
    const link = pendingConnection(port);
    const valid = link && slotAccepts(doc.nodes[link.outNode].type, link.sdef);
    if (wireDrag._hl && wireDrag._hl !== port) wireDrag._hl.classList.remove('drop-target');
    if (valid) { port.classList.add('drop-target'); wireDrag._hl = port; }
    else wireDrag._hl = null;
    return;
  }
  if (graph._pan) {
    view.x = graph._pan.px + (e.clientX - graph._pan.mx);
    view.y = graph._pan.py + (e.clientY - graph._pan.my);
    applyTransform();
  }
});

window.addEventListener('pointerup', (e) => {
  if (marquee) {
    if (marquee.moved) {
      if (!marquee.additive) clearSelection();
      const mr = marquee.el.getBoundingClientRect();
      for (const id of Object.keys(doc.nodes)) {
        const el = world.querySelector(`.gnode[data-id="${id}"]`);
        if (el && rectsIntersect(mr, el.getBoundingClientRect())) { selectedNodes.add(id); el.classList.add('selected'); }
      }
    } else {
      clearSelection(); // a bare click on empty canvas clears the selection
    }
    marquee.el.remove();
    marquee = null;
    return;
  }
  if (nodeDrag) {
    for (const it of nodeDrag.items) {
      const x = parseFloat(it.el.style.left), y = parseFloat(it.el.style.top);
      if (doc.nodes[it.id]) doc.nodes[it.id].pos = [x, y];
      patch(`/nodes/${it.id}`, { pos: [x, y] }).catch(showErr);
    }
    nodeDrag = null;
    flushPending();
  }
  if (wireDrag) {
    wireDrag._hl?.classList.remove('drop-target');
    finishConnect(e.clientX, e.clientY);
    wireDrag = null;
  }
  if (graph._pan) { graph._pan = null; graph.classList.remove('panning'); }
});

graph.addEventListener('wheel', (e) => {
  e.preventDefault();
  const g = graph.getBoundingClientRect();
  const cx = e.clientX - g.left, cy = e.clientY - g.top;
  const wx = (cx - view.x) / view.scale, wy = (cy - view.y) / view.scale;
  view.scale = clamp(view.scale * Math.exp(-e.deltaY * 0.0012), 0.35, 2.5);
  view.x = cx - wx * view.scale;
  view.y = cy - wy * view.scale;
  applyTransform();
}, { passive: false });

function flushPending() {
  if (pendingRender && !nodeDrag && !sliderDragging) { pendingRender = false; renderGraph(); }
}

// ------------------------------------------------------------ node creation menu

const createMenu = $('#createMenu');
const createFilter = $('#createFilter');
const createList = $('#createList');
let createPos = null;

graph.addEventListener('dblclick', (e) => {
  if (e.target.closest('.gnode')) return;
  createPos = worldFromClient(e.clientX, e.clientY);
  openCreateMenu(e.clientX, e.clientY);
});

function openCreateMenu(clientX, clientY) {
  createMenu.classList.remove('hidden');
  const mw = 220, mh = 340;
  createMenu.style.left = Math.min(clientX, window.innerWidth - mw - 8) + 'px';
  createMenu.style.top = Math.min(clientY, window.innerHeight - mh - 8) + 'px';
  createFilter.value = '';
  buildCreateList('');
  createFilter.focus();
}

function closeCreateMenu() { createMenu.classList.add('hidden'); }

function buildCreateList(filter) {
  const f = filter.toLowerCase();
  const groups = {};
  for (const [name, spec] of Object.entries(catalog)) {
    if (f && !name.toLowerCase().includes(f)) continue;
    (groups[spec.category] ??= []).push(name);
  }
  createList.innerHTML = '';
  const cats = Object.keys(groups).sort((a, b) => {
    const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b);
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.localeCompare(b);
  });
  for (const cat of cats) {
    const lbl = document.createElement('div');
    lbl.className = 'cat-label'; lbl.textContent = cat;
    createList.appendChild(lbl);
    for (const name of groups[cat]) {
      const item = document.createElement('div');
      item.className = 'create-item';
      item.innerHTML = `<span class="dot" style="background:${CAT_COLOR[cat] || '#7d879e'}"></span>${name}`;
      item.onclick = () => {
        const body = { type: name };
        if (createPos) body.pos = [Math.round(createPos.x), Math.round(createPos.y)];
        closeCreateMenu();
        // imported_mesh: create the empty block where the palette was, then prompt for a file
        if (name === 'imported_mesh') {
          post('/nodes', body).then((node) => openImportPicker(node.id)).catch(showErr);
          return;
        }
        post('/nodes', body).catch(showErr);
      };
      createList.appendChild(item);
    }
  }
  if (!createList.children.length) {
    createList.innerHTML = '<div class="cat-label">no matches</div>';
  }
}

createFilter.addEventListener('input', () => buildCreateList(createFilter.value));
createFilter.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCreateMenu();
  else if (e.key === 'Enter') { createList.querySelector('.create-item')?.click(); }
});
document.addEventListener('pointerdown', (e) => {
  if (!createMenu.classList.contains('hidden') && !createMenu.contains(e.target)) closeCreateMenu();
}, true);

// ------------------------------------------------------------ save / open modals

const backdrop = $('#modalBackdrop');
const saveModal = $('#saveModal');
const openModal = $('#openModal');
const formulaModal = $('#formulaModal');

function closeModals() {
  backdrop.classList.add('hidden');
  saveModal.classList.add('hidden');
  openModal.classList.add('hidden');
  formulaModal.classList.add('hidden');
  settingsModal.classList.add('hidden');
}
backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) closeModals(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

// Current project name — client-side (the server doc carries no filename); synced with save/load.
let projectName = localStorage.getItem('cadgang:lastSaveName') || null;
function setProjectName(name) {
  projectName = name || null;
  if (name) localStorage.setItem('cadgang:lastSaveName', name);
  $('#projectName').textContent = projectName || 'untitled';
}
$('#projectName').onclick = () => $('#saveBtn').click(); // click the title to save-as / rename

$('#saveBtn').onclick = () => {
  backdrop.classList.remove('hidden');
  saveModal.classList.remove('hidden');
  const name = $('#saveName');
  name.value = projectName || localStorage.getItem('cadgang:lastSaveName') || '';
  name.focus(); name.select();
};
$('#saveCancel').onclick = closeModals;
$('#saveConfirm').onclick = doSave;
$('#saveName').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });

async function doSave() {
  const name = $('#saveName').value.trim();
  if (!name) return;
  try {
    await post('/files/save', { name });
    setProjectName(name);
    closeModals();
    showOk(`SAVED · ${name}`);
  } catch (e) { showErr(e); }
}

$('#openBtn').onclick = async () => {
  backdrop.classList.remove('hidden');
  openModal.classList.remove('hidden');
  await loadFileList();
};
$('#openCancel').onclick = closeModals;

async function loadFileList() {
  const list = $('#fileList');
  list.innerHTML = '<div class="empty">loading…</div>';
  let files;
  try {
    const res = await api('/files');
    files = res.files || [];
  } catch {
    list.innerHTML = '<div class="empty">no saves yet — endpoint unavailable</div>';
    return;
  }
  if (!files.length) { list.innerHTML = '<div class="empty">no saves yet</div>'; return; }
  list.innerHTML = '';
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML =
      `<span class="fname">${f.name}</span>` +
      `<span class="fmeta">${f.nodes ?? 0} blocks · ${relTime(f.mtime)}</span>` +
      `<button class="fdel" title="Delete save">×</button>`;
    row.onclick = async () => {
      try { await post('/files/load', { name: f.name }); setProjectName(f.name); closeModals(); showOk(`OPENED · ${f.name}`); }
      catch (e) { showErr(e); }
    };
    row.querySelector('.fdel').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${f.name}"?`)) return;
      try { await del(`/files/${encodeURIComponent(f.name)}`); await loadFileList(); }
      catch (err) { showErr(err); }
    };
    list.appendChild(row);
  }
}

function relTime(mtime) {
  if (!mtime) return '';
  const t = typeof mtime === 'number' ? mtime : Date.parse(mtime);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ------------------------------------------------------------ toolbar

$('#clearDoc').onclick = () => { if (confirm('New file — discard all blocks?')) post('/document/clear', {}).catch(showErr); };

$('#resolution').oninput = () => { $('#resolutionValue').textContent = $('#resolution').value; };
$('#resolution').onchange = () => refreshMesh();

// ---- STEP import via a shared hidden file picker. Import is triggered from the create
// palette (new imported_mesh) or an empty asset param; both route through here. When a
// target node is set, the asset is ATTACHED to it (?node=); otherwise a new node is created.
let importTargetNode = null;
function openImportPicker(nodeId) {
  importTargetNode = nodeId || null;
  $('#importFile').click();
}
$('#importFile').onchange = async (e) => {
  const file = e.target.files[0];
  const target = importTargetNode;
  importTargetNode = null;
  if (!file) return;                       // picker cancelled — leave any empty block as-is
  const status = $('#status');
  status.textContent = 'IMPORTING…'; status.className = 'status';
  try {
    const buf = await file.arrayBuffer();
    const q = `name=${encodeURIComponent(file.name)}${target ? `&node=${encodeURIComponent(target)}` : ''}`;
    const r = await fetch(`${BASE}/api/import/step?${q}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    showOk(`IMPORTED · ${body.asset?.name || file.name}`);
  } catch (err) { showErr(err); }
  finally { e.target.value = ''; }  // allow re-importing the same file
};

// ---- export block download: same-window navigation, mirrors the old Export STL button's
// progress-bar handling. Called from the block's footer button in renderGraph.
// `kind` is 'stl' (meshed) or 'step' (exact B-rep).
function downloadExport(node, kind) {
  if (!inputIds(node, 'shape').length) return;   // nothing connected → no-op
  let url = `${BASE}/api/export/${kind}?node=${encodeURIComponent(node.id)}`;
  const res = Number(node.params?.resolution);
  // STEP has no meshing resolution — it writes the exact surfaces.
  if (kind === 'stl' && Number.isFinite(res)) url += `&resolution=${res}`;  // skip expression-valued resolutions
  const file = String(node.params?.filename ?? '').trim();
  if (file) url += `&file=${encodeURIComponent(file)}`;
  url += `&t=${Date.now()}`;   // a navigation can't set cache:'no-store' — bust it by URL
  stlProgress = true;
  startProgress();
  clearTimeout(stlSafety);
  stlSafety = setTimeout(() => { stlProgress = false; endProgress(); }, 30000);
  window.location.href = url;
}

// ---- Pick face (feature): toggle STEP face-picking mode
$('#pickFace').onclick = () => { faceMode ? exitFaceMode() : enterFaceMode(); };

// ---- Arrange to grid (feature): topological columns by dependency depth
$('#arrangeBtn').onclick = arrangeGrid;

function arrangeGrid() {
  const ids = (selectedNodes.size ? [...selectedNodes] : Object.keys(doc.nodes)).filter((id) => doc.nodes[id]);
  if (!ids.length) return;
  const set = new Set(ids);
  const depth = {}, visiting = new Set();
  const d = (id) => {
    if (depth[id] != null) return depth[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let mx = -1;
    const n = doc.nodes[id];
    for (const slot of Object.keys(n.inputs || {}))
      for (const cid of inputIds(n, slot)) if (set.has(cid)) mx = Math.max(mx, d(cid));
    visiting.delete(id);
    return (depth[id] = mx + 1);
  };
  for (const id of ids) d(id);
  const cols = {};
  for (const id of ids) (cols[depth[id]] ??= []).push(id);
  // walk columns left→right, advancing x by each column's measured max width + WIRE_GAP
  // so the connection lines between columns have room to be seen
  let x = 40;
  for (const col of Object.keys(cols).map(Number).sort((a, b) => a - b)) {
    const cids = cols[col].sort();
    let y = 40, maxW = 0;
    for (const id of cids) {
      const el = world.querySelector(`.gnode[data-id="${id}"]`);
      const h = el ? el.offsetHeight : 120;
      const w = el ? el.offsetWidth : 220;
      if (w > maxW) maxW = w;
      doc.nodes[id].pos = [x, y];
      if (el) { el.style.left = x + 'px'; el.style.top = y + 'px'; }
      patch(`/nodes/${id}`, { pos: [x, y] }).catch(showErr);
      y += h + COL_GAP;
    }
    x += (maxW || 220) + WIRE_GAP;
  }
  renderWires();
}

// ---- key handling for the new interactions (Space = pan modifier, Esc = cancel/clear)
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.target.matches('input, textarea')) spaceDown = true;
  if (e.key === 'Escape') {
    if (faceMode) exitFaceMode();
    if (partDrag) { restorePartDrag(); partDrag = null; }
    if (selectedNodes.size) clearSelection();
  }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });

// ---- copy / paste selected blocks (⌘/Ctrl + C / V)
function copySelection() {
  const ids = [...selectedNodes].filter((id) => doc.nodes[id]);
  if (!ids.length) return false;
  clipboard = ids.map((id) => {
    const n = doc.nodes[id];
    return {
      id,                                                    // original id, for input remapping
      type: n.type,
      name: n.name,
      params: structuredClone(n.params ?? {}),
      inputs: structuredClone(n.inputs ?? {}),
      pos: n.pos ? [n.pos[0], n.pos[1]] : (layoutPos[id] ? [...layoutPos[id]] : [40, 40]),
    };
  });
  pasteOffset = 0;
  return true;
}

async function pasteClipboard() {
  if (!clipboard.length) return;
  pasteOffset += 1;
  const off = 40 * pasteOffset;
  try {
    // phase 1: create bare copies (no inputs) so cross-references can't fail validation on order
    const idMap = {};                                        // original id -> new id
    for (const c of clipboard) {
      const pos = [Math.round(c.pos[0] + off), Math.round(c.pos[1] + off)];
      const node = await post('/nodes', { type: c.type, name: c.name, params: c.params, pos });
      idMap[c.id] = node.id;
    }
    // phase 2: wire inputs. Refs to other copied nodes → their new ids; refs to nodes outside
    // the clipboard stay as-is if they still exist, else are dropped (never fail the paste).
    const newIds = new Set(Object.values(idMap));
    const valid = (r) => newIds.has(r) || !!doc.nodes[r];
    for (const c of clipboard) {
      const inputs = {};
      let hasInputs = false;
      for (const [slot, ref] of Object.entries(c.inputs || {})) {
        if (Array.isArray(ref)) {
          inputs[slot] = ref.map((r) => idMap[r] ?? r).filter(valid);
          hasInputs = true;
        } else if (ref != null) {
          const m = idMap[ref] ?? ref;
          if (valid(m)) { inputs[slot] = m; hasInputs = true; }
        }
      }
      if (hasInputs) await patch(`/nodes/${idMap[c.id]}`, { inputs });
    }
    // select exactly the new copies, then refresh so they render selected
    clearSelection();
    for (const id of newIds) selectedNodes.add(id);
    await refreshDocument();
    showOk(`PASTED ${newIds.size} BLOCK${newIds.size > 1 ? 'S' : ''}`);
  } catch (e) { showErr(e); }
}

window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k !== 'c' && k !== 'v' && k !== 'z') return;
  // let the browser handle copy/paste/undo while editing text or with a live text selection
  const t = e.target;
  if (t && (t.matches?.('input, textarea') || t.isContentEditable)) return;
  if (window.getSelection && String(window.getSelection())) return;
  if (k === 'z') {
    // ⌘Z undo / ⌘⇧Z redo — server-side history, WS refresh re-renders
    e.preventDefault();
    api(e.shiftKey ? '/redo' : '/undo', { method: 'POST' })
      .then(() => showOk(e.shiftKey ? 'REDO' : 'UNDO'))
      .catch(showErr);
    return;
  }
  if (k === 'c') {
    if (copySelection()) { e.preventDefault(); showOk(`COPIED ${clipboard.length} BLOCK${clipboard.length > 1 ? 'S' : ''}`); }
  } else if (clipboard.length) {
    e.preventDefault();
    pasteClipboard();
  }
});

// ------------------------------------------------------------ dragbar (panel resize)

const dragbar = $('#dragbar');
dragbar.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  dragbar.classList.add('active');
  dragbar.setPointerCapture?.(e.pointerId);
  const mainRect = $('main').getBoundingClientRect();
  const onMove = (ev) => {
    const w = splitLayout === 'stacked'
      ? clamp(ev.clientY - mainRect.top, 160, mainRect.height * 0.8)
      : clamp(ev.clientX - mainRect.left, 280, window.innerWidth * 0.7);
    $('#panel').style.flexBasis = w + 'px';
    resize();
  };
  const onUp = () => {
    dragbar.classList.remove('active');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    resize();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
});

// ------------------------------------------------------------ split layout toggle

function applySplit() {
  $('main').classList.toggle('stacked', splitLayout === 'stacked');
  // a px flex-basis from one orientation is meaningless in the other
  $('#panel').style.flexBasis = '';
  $('#splitToggle').textContent = splitLayout === 'stacked' ? 'SIDE' : 'STACK';
  resize();
}
function setSplit(layout) {
  splitLayout = layout === 'stacked' ? 'stacked' : 'side';
  localStorage.setItem('cadgang:split', splitLayout);
  applySplit();
}
$('#splitToggle').onclick = () => setSplit(splitLayout === 'stacked' ? 'side' : 'stacked');

// ------------------------------------------------------------ theme + color toggles

function applyTheme() {
  document.documentElement.setAttribute('data-theme', theme);
  $('#themeToggle').textContent = theme === 'dark' ? 'LIGHT' : 'DARK';
  applyViewportTheme();
}
function setTheme(t) {
  theme = t === 'dark' ? 'dark' : 'light';
  localStorage.setItem('cadgang:theme', theme);
  applyTheme();
  recolorMesh();               // vertex colors + material lightness depend on theme
  if (colorMode) renderGraph(); // node stripes track theme lightness
}
$('#themeToggle').onclick = () => setTheme(theme === 'dark' ? 'light' : 'dark');

function applyColorMode() {
  document.documentElement.classList.toggle('color-mode', colorMode);
  $('#colorToggle').textContent = colorMode ? 'METAL' : 'COLOR';
}
function setColorMode(on) {
  colorMode = !!on;
  localStorage.setItem('cadgang:colorMode', colorMode ? '1' : '0');
  applyColorMode();
  renderGraph();   // stripes flip between metal category and per-node hue
  refreshMesh();   // re-fetch with/without &colors=1
}
$('#colorToggle').onclick = () => setColorMode(!colorMode);

// ------------------------------------------------------------ user variables

function renderVars() {
  if (document.activeElement?.closest('#varsChips')) return; // don't clobber an inline edit
  const chips = $('#varsChips');
  chips.innerHTML = '';
  const vars = doc.vars || {};
  for (const [name, value] of Object.entries(vars)) {
    const chip = document.createElement('span');
    chip.className = 'var-chip';
    const vk = document.createElement('span'); vk.className = 'vk'; vk.textContent = name;
    const eq = document.createElement('span'); eq.className = 'veq'; eq.textContent = '=';
    const vv = document.createElement('span'); vv.className = 'vv'; vv.textContent = value;
    vv.title = 'double-click to edit';
    const vdel = document.createElement('button'); vdel.className = 'vdel'; vdel.textContent = '×';
    vdel.title = 'Delete variable';
    vdel.onclick = () => del(`/vars/${encodeURIComponent(name)}`).catch(showErr);
    vv.ondblclick = () => editVarValue(vv, name);
    chip.append(vk, eq, vv, vdel);
    chips.appendChild(chip);
  }
}

function editVarValue(vvSpan, name) {
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'vv-edit'; input.value = vvSpan.textContent;
  input.autocomplete = 'off'; input.spellcheck = false;
  attachAutocomplete(input);           // registered before onkeydown below, so it pre-empts Enter
  // ↑/↓ live-scrub the variable's value; POST per press so both the number and the mesh update live
  input.addEventListener('keydown', (e) => {
    const next = steppedValue(input, e);
    if (next == null) return;
    e.preventDefault();
    input.value = next;
    post('/vars', { name, value: next }).catch(showErr);
  });
  vvSpan.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save) {
      const raw = input.value.trim();
      const num = Number(raw);
      post('/vars', { name, value: Number.isFinite(num) ? num : raw }).catch(showErr);
    } else renderVars();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  };
  input.onblur = () => commit(true);
}

attachAutocomplete($('#varAdd'), { valueOnly: true }); // complete var names in the RHS only
$('#varAdd').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const raw = e.target.value;
  const eq = raw.indexOf('=');
  if (eq < 0) { showErr(new Error('use: name = value')); return; }
  const name = raw.slice(0, eq).trim();
  const valStr = raw.slice(eq + 1).trim();
  if (!name) { showErr(new Error('missing variable name')); return; }
  const num = Number(valStr);
  post('/vars', { name, value: Number.isFinite(num) ? num : valStr })
    .then(() => { e.target.value = ''; })
    .catch(showErr);
});

// ------------------------------------------------------------ formula readout

function reachableIndeg() {
  const indeg = {};
  const seen = new Set();
  function walk(id) {
    const node = doc.nodes[id];
    if (!node) return;
    for (const slot of Object.keys((catalog[node.type] || { inputs: {} }).inputs)) {
      for (const cid of inputIds(node, slot)) {
        indeg[cid] = (indeg[cid] || 0) + 1;
        if (!seen.has(cid)) { seen.add(cid); walk(cid); }
      }
    }
  }
  if (doc.output && doc.nodes[doc.output]) { seen.add(doc.output); walk(doc.output); }
  return indeg;
}

function paramStr(pname, pdef, val) {
  if (pdef.type === 'vec3') {
    const arr = Array.isArray(val) ? val : [val, val, val];
    return `${pname}: [${arr.join(', ')}]`;
  }
  return `${val}`;
}

function expandInline(id, expanded, shared) {
  const node = doc.nodes[id];
  if (!node) return String(id);
  if (shared.has(id) && expanded.has(id)) return node.name; // shared subgraph: name after first expansion
  expanded.add(id);
  const spec = catalog[node.type] || { params: {}, inputs: {} };
  const args = [];
  for (const slot of Object.keys(spec.inputs))
    for (const cid of inputIds(node, slot)) args.push(expandInline(cid, expanded, shared));
  for (const [pname, pdef] of Object.entries(spec.params))
    args.push(paramStr(pname, pdef, node.params?.[pname] ?? pdef.default));
  return `${node.type}(${args.join(', ')})`;
}

function expandPretty(id, indent, expanded, shared) {
  const pad = '  '.repeat(indent);
  const node = doc.nodes[id];
  if (!node) return pad + String(id);
  if (shared.has(id) && expanded.has(id)) return pad + node.name;
  expanded.add(id);
  const spec = catalog[node.type] || { params: {}, inputs: {} };
  const inner = [];
  for (const slot of Object.keys(spec.inputs))
    for (const cid of inputIds(node, slot)) inner.push(expandPretty(cid, indent + 1, expanded, shared));
  for (const [pname, pdef] of Object.entries(spec.params))
    inner.push('  '.repeat(indent + 1) + paramStr(pname, pdef, node.params?.[pname] ?? pdef.default));
  if (!inner.length) return pad + node.type + '()';
  return pad + node.type + '(\n' + inner.join(',\n') + '\n' + pad + ')';
}

function buildFormula(pretty) {
  if (!doc.output || !doc.nodes[doc.output]) return '';
  const indeg = reachableIndeg();
  const shared = new Set(Object.keys(indeg).filter((id) => indeg[id] >= 2));
  return pretty
    ? expandPretty(doc.output, 0, new Set(), shared)
    : expandInline(doc.output, new Set(), shared);
}

function updateFormula() {
  $('#formula').textContent = buildFormula(false);
}

$('#formula').onclick = () => {
  if (!buildFormula(false)) return;
  let text = buildFormula(true);
  const vars = doc.vars || {};
  const names = Object.keys(vars);
  if (names.length) text += '\n\nWHERE\n' + names.map((n) => `  ${n} = ${vars[n]}`).join('\n');
  $('#formulaPre').textContent = text;
  backdrop.classList.remove('hidden');
  formulaModal.classList.remove('hidden');
};
$('#formulaClose').onclick = closeModals;
$('#formulaCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('#formulaPre').textContent); showOk('COPIED'); }
  catch { showErr(new Error('copy failed')); }
};

// ------------------------------------------------------------ sync

async function refreshDocument() {
  doc = await api('/document');
  // defer the graph rebuild while a node/wire/slider drag is live so the dragged element survives
  if (nodeDrag || wireDrag || sliderDragging) { pendingRender = true; }
  else renderGraph();
  renderVars();
  updateFormula();
  // only re-mesh when something the geometry depends on changed — a pos move, rename, or
  // selection churn leaves the signature identical and is skipped (resolution/color changes
  // call refreshMesh directly and update the signature themselves)
  if (geometrySignature() !== meshSignature) refreshMesh();
}

// ---- change notification. The socket is the fast path; behind a reverse proxy that does not
// tunnel Upgrade requests (Apache mod_proxy_http, e.g. the experiments.cwandt.com mount) it
// never opens, and revision polling stands in for it. Polling loses only mesh_progress — the
// bar still appears and clears around each request, it just doesn't fill smoothly.
let pollTimer = null;
let lastRevision = -1;

async function pollRevision() {
  const { revision } = await api('/health');
  if (revision === lastRevision) return;
  lastRevision = revision;
  await refreshDocument();
}
function pollSoon() {
  if (pollTimer) setTimeout(() => pollRevision().catch(() => {}), 0);
}
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => pollRevision().catch(() => {}), 1500);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function connectWS() {
  let opened = false;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}/ws`);
  ws.onopen = () => { opened = true; stopPolling(); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'document_changed') refreshDocument().catch(showErr);
    else if (msg.type === 'mesh_progress') {
      // latest-wins; ignored entirely unless our own mesh/STL request is in flight
      if (progressActive) setProgress(msg.pct);
      if (stlProgress && msg.pct >= 1) { stlProgress = false; clearTimeout(stlSafety); endProgress(); }
    }
  };
  ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };
  ws.onclose = () => {
    startPolling();
    // a socket that opened once is worth retrying briskly; one that never opened is behind a
    // proxy that won't tunnel it, so back off hard and let polling carry the session
    setTimeout(connectWS, opened ? 1500 : 60000);
  };
}

// Drive the header version readout from the server's package version (/api/health).
function setVersion(v) {
  if (!v) return;
  const parts = String(v).split('.');
  const code = (parts[1] || '0').padStart(2, '0') + (parts[2] || '0').padStart(2, '0');
  const codeEl = document.querySelector('.version .idcode');
  const verEl = document.querySelector('.version .idver');
  if (codeEl) codeEl.textContent = `CWT_SW_CADGANG_${code}`;
  if (verEl) verEl.textContent = `v${v}`;
}

(async function init() {
  applyTheme();
  applyColorMode();
  applySplit();
  setProjectName(projectName);
  catalog = await api('/node-types');
  applyTransform();
  resize();
  applyCamera();
  try {
    const health = await api('/health');
    setVersion(health.version);
    lastRevision = health.revision;   // baseline so the poll fallback's first tick is a no-op
  } catch { /* keep the static fallback */ }
  await refreshDocument();
  connectWS();
})().catch(showErr);
