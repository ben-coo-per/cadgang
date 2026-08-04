# cadgang v2 — prompt-first, AI-native

A rethink of the authoring model. The geometry kernel survives intact; the layer
above it is replaced.

## The change in one paragraph

Today a document is a DAG of typed blocks with numeric params, and the block
vocabulary is the ceiling — no `brep_loft` type means no loft. In v2 a document
is an ordered stack of **cells**. A cell holds a natural-language prompt, the
geometry program that prompt compiled to, the parameters that program exposes,
and any viewport selections or sketches it depends on. The prompt is the source;
the compiled program is a **lockfile**. Geometry never regenerates from the
prompt on its own — only when the prompt is edited or a recompile is explicitly
requested. That is what keeps a prompt-authored model from silently becoming a
different part between two openings of the same file.

## Cell

```jsonc
{
  "id": "body",
  "prompt": "60×40×24 enclosure, 3mm fillet on the vertical edges, 2mm wall open at top",
  "refs": [],                    // other cells this one consumes; default = previous
  "selections": {},              // user picks, stored as queries + anchors
  "sketch": null,                // constrained 2D profile, if this is a sketch cell
  "params": { "w": 60, "d": 40, "h": 24, "r": 3, "wall": 2 },
  "code": "…",                   // the committed program
  "compiledBy": "claude-opus-5", // provenance
  "compiledAt": "2026-08-03T…",
  "status": "ok"                 // ok | stale | diverged | awaiting_pick
}
```

`status` records where the cell stands relative to its own prompt: `stale` means
the prompt was edited past the code, `diverged` means the code was hand-edited
past the prompt. Evaluation failure is deliberately *not* a status — a cell that
throws is reported by the evaluator, not written back into the document, because
persisting it would turn every viewport render of a broken model into a document
write and fill undo with states the user never authored.

Cells are ordered, not a free DAG. Natural language leans on a running current
solid ("subtract that from the body"), so each cell's default input is the
previous cell's result, with explicit `@name` references available when the flow
branches. The dependency DAG still exists and is still drawn — it's derived from
`refs` rather than authored.

## Compiled programs

Cells compile to sandboxed JavaScript against a curated kernel API, with
parameters hoisted to the top so direct manipulation survives:

```js
export const params = { w: 60, d: 40, h: 24, r: 3, wall: 2 };

export default ({ p, brep, q }) => {
  let s = brep.box(p.w, p.d, p.h, { center: 'xy' });
  s = brep.fillet(s, q.edges(s).linear().along('z'), p.r);
  return brep.shell(s, q.faces(s).top(), p.wall);
};
```

`params` is the ergonomic core: the model writes structure once, the human drives
numbers forever. Changing `w` re-runs the program; it does not re-prompt.

Programs run in a fresh `vm` realm with no filesystem, network, or timer access
and a wall-clock budget. It is a guardrail against mistakes — an infinite loop, a
stray file write — not a security boundary: the kernel functions passed in come
from the host realm, and code written to escape through them will. That is the
right trade while the OCCT instance lives in the main process, since shapes are
not transferable and a worker would need a kernel of its own. If cell code ever
comes from somewhere other than the user's own Claude Code session, this has to
become a worker. The code is stored in the document in plain
text, shown in the UI, and hand-editable — a hand edit simply marks the cell as
diverged from its prompt.

## The query layer — the load-bearing subsystem

An LLM cannot see the model, so it can never say "edge 7." It says "the linear
edges running along Z," and that expression has to resolve against the actual
B-rep.

`q` filters faces and edges by intrinsic properties: surface/curve kind (plane,
cylinder, line, circle), orientation, area, length, centroid, bounding box,
adjacency, and lineage — which operation created the entity. Queries are
composable and chainable, and they re-resolve on every evaluation.

Two properties fall out of this:

- **Parameter changes don't break references.** `q.edges(s).linear().along('z')`
  still means the same four edges after `w` goes from 60 to 80. Index-based
  selection does not. This is the standard persistent-naming problem and a query
  layer is the standard answer.
- **The model can verify its own selection.** A query returns a count and a
  summary before it's used, so Claude confirms it caught 4 edges and not 12
  rather than filleting blind.

Queries that resolve to an unexpected count fail the cell loudly instead of
producing quietly wrong geometry.

## Topology introspection

Because the compiler is Claude Code over MCP and has no vision, introspection
replaces seeing. A new MCP call returns the full topology of any cell's result:

- **faces** — id, surface kind, area, centroid, normal, bbox, adjacent edge ids,
  creating operation
- **edges** — id, curve kind, length, midpoint, direction, adjacent face ids,
  creating operation

The authoring loop becomes: build → introspect → write a query → check the
count → apply the operation → render → assert. Existing `render_preview`,
`eval_sdf`, and `mesh_stats` stop being inspection conveniences and become steps
in that loop.

## Selections and the pick loop

Some references genuinely require a human: "fillet *that* edge." A cell declares
what it needs, and the flow is:

1. Cell declares `selections: { lip: 'edge' }` and enters `awaiting_pick`.
2. The web UI highlights the cell and drops into pick mode.
3. The user clicks geometry in the viewport.
4. The pick is stored as **a resolved query plus an anchor** — centroid, normal,
   length/area, adjacency hash — never as a raw index.
5. On every later evaluation the query re-resolves and the anchor is checked. If
   the match drifts past tolerance, the cell goes `stale` and asks for a re-pick
   rather than operating on the wrong entity.

Claude issues the pick request over MCP and long-polls for the result, so a
modeling session can interleave machine authoring with human disambiguation
without either side blocking permanently.

## Sketch cells

A sketch cell holds a plane, a set of 2D entities, and a set of constraints.
Claude authors entities and constraints from a prompt ("60×40 rectangle, 20mm
hole centered 15mm from the left edge"); the user drags points in a canvas and
the solver holds the constraints. Dimension values may reference cell `params`,
so sketches are parametric like everything else.

The solver is ours: Levenberg–Marquardt over constraint residuals, covering
coincident, horizontal, vertical, distance, radius, tangent, equal, parallel,
perpendicular, and point-on-entity. AI-authored sketches are small and
well-conditioned, and owning the solver means over-constrained and
under-constrained cases produce error messages we can hand straight back to the
model. Degrees of freedom are reported so the UI can show what's still floating.

Output is a closed profile consumable by extrude, revolve, and sweep.

## Assertion cells

A model authored by a machine needs machine-checkable intent, or the user is
trusting generated code on faith. Assertion cells are first class:

- minimum wall thickness across the whole body
- clearance between two named faces
- volume, mass, or bounding-box limits
- watertightness and self-intersection

They evaluate on every recompile and on every parameter change, and they fail
the document, not just a cell. During authoring they close the loop: Claude
compiles, renders, checks assertions, and iterates until they pass.

## What survives

The entire kernel. `brep.js`, `sdf.js`, `mesher.js`, `step.js`, `stl.js`,
`render.js`, `mesh.js`, `expr.js`, the two-lineage rule and its one-way bridge,
undo, autosave, and the save/load format all stay. What is removed is
`NODE_TYPES` as the ceiling on expressiveness and the node-graph editor as the
primary authoring surface — the graph remains as a derived, read-only view of
cell dependencies.

New modules:

```
src/core/query.js     topological queries over B-rep + persistent anchors
src/core/sketch.js    2D constraint solver
src/core/cellapi.js   the curated API handed to cell programs (brep, field, q, sk)
src/core/sandbox.js   worker execution with resource limits
src/core/cells.js     cell document model, dirty tracking, evaluation order
```

## Phases

1. **Cell model + sandbox + API façade.** Cells compile, run, and produce shapes.
   *Built* — `cells.js`, `sandbox.js`, `cellapi.js`.
2. **Query layer + topology introspection.** The MCP surface that replaces vision.
   *Built* — `query.js`, `ops.js`, `src/server/cells.js` (REST at `/api/cells`),
   `src/mcp/cells.js` (ten `cadgang_cells_*` tools). The cell document is a
   second, independent document served alongside the v1 node graph.
3. **Selections + pick loop.** UI pick mode, anchors, stale detection.
4. **Sketch cells + solver + canvas.**
5. **Assertions + the verification loop.**
6. **UI.** Cell stack replaces the node editor; graph becomes a derived view.
   *Transcript built* — `web/cells.html` at `/cells`: prompts in order, status
   badges, scrubbable params, per-cell errors and logs, and the exact solid with
   its real edges. It is a second page rather than a mode inside the v1 editor.
   Still missing: pick mode, and the derived dependency graph view.

Phases 1 and 2 are the ones that prove the thesis. If queries hold up under
parameter change, the rest is construction.

## Consequence of the MCP-driven choice

There is no LLM inside cadgang. Authoring happens in Claude Code; the web UI is
a cell transcript where you read prompts, drag sliders, make picks, and watch
assertions. An in-app prompt box can be added later without disturbing any of
the above — it would simply be another client of the same MCP-shaped API.
