/**
 * The sketch canvas — the human half of a sketch cell.
 *
 * A cell's program says what the profile MEANS; this says where it currently
 * sits. Dragging a point sends the whole sketch to the server, which pins that
 * point, re-solves, and sends the sketch back — so what you see while dragging
 * is the constraint system's answer, not a preview of it. Only the release
 * writes to the document, because a gesture is one edit, not sixty.
 *
 * The solver deliberately does not run in here. It is the same module the cell
 * evaluates against, and a second copy in the browser would be a second thing
 * to keep true.
 */

const HIT = 7;        // px within which a click grabs a point
const PAD = 18;       // px of margin around the fitted sketch

const COLOURS = {
  light: { line: '#2f5d8a', point: '#1c1c1a', fixed: '#a33', hint: '#c9c8c4', text: '#6b6a66' },
  dark: { line: '#7fb3e0', point: '#e8e7e3', fixed: '#e08a8a', hint: '#3a3936', text: '#8d8c88' },
};

/**
 * Mount a canvas for one cell's sketch.
 *
 * `solve` and `save` are passed in rather than reached for, so this module
 * knows about geometry and pointers and nothing about the API.
 */
export function sketchCanvas({ sketch, canvas, note, solve, save }) {
  const ctx = canvas.getContext('2d');
  let current = sketch;
  let view = { scale: 1, ox: 0, oy: 0 };
  let dragging = null;
  let inFlight = false;
  let queued = null;

  function fit() {
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 200;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const box = bounds(current);
    const scale = Math.min(
      (w - PAD * 2) / Math.max(box.w, 1e-6),
      (h - PAD * 2) / Math.max(box.h, 1e-6)
    );
    // A sketch of a single point has no extent to fit to; cap the zoom so it
    // does not arrive at 10000× and look like a blank canvas.
    view.scale = Math.min(scale, 40);
    view.ox = w / 2 - (box.x + box.w / 2) * view.scale;
    view.oy = h / 2 + (box.y + box.h / 2) * view.scale;
  }

  const toScreen = ([x, y]) => [x * view.scale + view.ox, -y * view.scale + view.oy];
  const toSketch = (px, py) => [(px - view.ox) / view.scale, (view.oy - py) / view.scale];

  function draw() {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const c = COLOURS[theme];
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // Origin cross: a sketch is placed on a plane, and where the origin sits
    // relative to the profile is what decides where the solid lands.
    const [ox, oy] = toScreen([0, 0]);
    ctx.strokeStyle = c.hint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox - 10, oy); ctx.lineTo(ox + 10, oy);
    ctx.moveTo(ox, oy - 10); ctx.lineTo(ox, oy + 10);
    ctx.stroke();

    ctx.strokeStyle = c.line;
    ctx.lineWidth = 1.6;
    for (const e of current.entities || []) {
      ctx.beginPath();
      if (e.type === 'line') {
        ctx.moveTo(...toScreen(xy(current, e.a)));
        ctx.lineTo(...toScreen(xy(current, e.b)));
      } else if (e.type === 'circle') {
        const [cx, cy] = toScreen(xy(current, e.c));
        ctx.arc(cx, cy, Math.abs(e.r) * view.scale, 0, Math.PI * 2);
      } else if (e.type === 'arc') {
        const centre = xy(current, e.c);
        const [cx, cy] = toScreen(centre);
        const r = Math.hypot(xy(current, e.a)[0] - centre[0], xy(current, e.a)[1] - centre[1]);
        // Canvas y grows downward, so a counter-clockwise sketch arc is drawn
        // clockwise here — hence the flipped angles and the `true`.
        const a0 = -Math.atan2(xy(current, e.a)[1] - centre[1], xy(current, e.a)[0] - centre[0]);
        const a1 = -Math.atan2(xy(current, e.b)[1] - centre[1], xy(current, e.b)[0] - centre[0]);
        ctx.arc(cx, cy, r * view.scale, a0, a1, true);
      }
      ctx.stroke();
    }

    (current.points || []).forEach((p, i) => {
      const [px, py] = toScreen([p.x, p.y]);
      ctx.fillStyle = p.fixed ? c.fixed : c.point;
      if (p.fixed) {
        ctx.fillRect(px - 3, py - 3, 6, 6); // pinned points read as squares
      } else {
        ctx.beginPath();
        ctx.arc(px, py, dragging?.point === i ? 5 : 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  /**
   * Ask the server to re-solve with the point where the pointer is.
   *
   * Coalesced the same way parameter scrubbing is: only the newest position is
   * ever in flight, and one queued behind it. Anything more and a fast drag
   * would render poses the pointer left behind seconds ago.
   */
  async function requestSolve(move) {
    if (inFlight) { queued = move; return; }
    inFlight = true;
    try {
      const result = await solve({ sketch: current, move });
      current = result.sketch;
      report(result);
      draw();
    } catch (e) {
      report({ error: e.message });
    } finally {
      inFlight = false;
      if (queued) { const next = queued; queued = null; requestSolve(next); }
    }
  }

  function report(result) {
    if (!note) return;
    if (result.error) { note.textContent = result.error; note.className = 'sketch-note err'; return; }
    const r = result.report || {};
    const bits = [`${r.dof ?? '?'} dof`];
    if (r.redundant) bits.push(`${r.redundant} redundant`);
    if (result.pinned === false && dragging) bits.push('held by constraints');
    note.textContent = bits.join(' · ');
    note.className = 'sketch-note';
  }

  function nearestPoint(px, py) {
    let best = -1;
    let bestD = HIT;
    (current.points || []).forEach((p, i) => {
      const [sx, sy] = toScreen([p.x, p.y]);
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const i = nearestPoint(e.clientX - rect.left, e.clientY - rect.top);
    if (i < 0) return;
    dragging = { point: i };
    canvas.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const [x, y] = toSketch(e.clientX - rect.left, e.clientY - rect.top);
    requestSolve({ point: dragging.point, x, y });
  });

  const release = async () => {
    if (!dragging) return;
    dragging = null;
    draw();
    try {
      await save(current);
    } catch (e) {
      report({ error: e.message });
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  fit();
  draw();
  requestSolve(null);

  return {
    /** Re-solve and redraw after something outside changed — a parameter, say. */
    async refresh(next) {
      if (dragging) return; // never yank the geometry out from under a hand
      if (next) current = next;
      fit();
      await requestSolve(null);
      fit();
      draw();
    },
    redraw() { fit(); draw(); },
  };
}

function xy(sketch, i) {
  const p = sketch.points?.[i];
  return p ? [p.x, p.y] : [0, 0];
}

/** Extent of the sketch including circle and arc radii, never zero-sized. */
function bounds(sketch) {
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  let any = false;
  const see = (x, y) => {
    if (!any) { minX = maxX = x; minY = maxY = y; any = true; return; }
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const p of sketch.points || []) see(p.x, p.y);
  for (const e of sketch.entities || []) {
    if (e.type !== 'circle') continue;
    const [cx, cy] = xy(sketch, e.c);
    see(cx - e.r, cy - e.r);
    see(cx + e.r, cy + e.r);
  }
  return { x: minX, y: minY, w: Math.max(maxX - minX, 1), h: Math.max(maxY - minY, 1) };
}
