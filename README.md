# cadgang

Block-based **implicit modeling CAD** that runs in your browser — with a REST API, live WebSocket updates, and a built-in **MCP server** so Claude Code can drive it end-to-end: build models, inspect geometry, render previews, and export STLs.

![cadgang UI](docs/screenshot-ui.png)

cadgang sits in the lineage of functional-representation CAD: [kokopelli](https://github.com/mkeeter/kokopelli), Matt Keeter's Python-scripted f-rep CAD/CAM tool (and its successors [Antimony](https://github.com/mkeeter/antimony) and [libfive](https://libfive.com)), and the implicit-modeling approach [nTopology](https://www.ntop.com/) built a company on. Where kokopelli describes models as code and nTop as a graph of implicit operations, cadgang does both: models are **graphs of blocks** evaluated as signed distance fields (SDFs), and every graph compiles down to a one-line functional formula (shown live in the footer). Because geometry is a function, not a boundary mesh, booleans never fail, shells and offsets are exact, and TPMS lattices are a single block.

| Raymarched preview | Gyroid lattice infill |
|---|---|
| ![part](docs/preview-part.png) | ![gyroid](docs/preview-gyroid.png) |

## Install

Requires [Node.js](https://nodejs.org) ≥ 18 and a modern browser. No build step — the web app is plain ES modules.

```bash
git clone https://github.com/cheewee2000/cadgang.git
cd cadgang
npm install
npm start          # → http://localhost:4477
```

Then:

```bash
npm run demo       # builds a gyroid-filled demo part via the REST API
npm test           # 80 kernel/API unit tests
```

Open http://localhost:4477 — the viewport live-updates (WebSocket) whenever the model changes, whether from the UI, the REST API, or Claude via MCP. The model autosaves to `data/document.json`, so state survives restarts and the UI and MCP always share one model. `CADGANG_PORT` and `CADGANG_DOC` select an alternate port/document for scratch instances.

## The editor

- **Double-click** the graph to add a block, **drag** between ports to wire, **drag** blocks to move, right-drag to pan, scroll to zoom, marquee-drag to multi-select, **⌘C/⌘V** copy/paste, **⌘Z** undo, **Arrange** for a tidy dependency layout
- **VARS bar** — define named variables (`w = 60`); any numeric param accepts an expression (`w/2 + 3`) that re-evaluates when the variable changes
- **STACK / SIDE** toggles the graph/viewport split between stacked and side-by-side; **DARK** toggles the theme; **COLOR** switches per-part color vs. stainless render
- **Save / Open** stores named models server-side (`saves/`)
- Click the footer formula to see the whole model as a nested functional expression

## Claude Code integration (MCP)

The repo ships a `.mcp.json`, so opening it in Claude Code auto-registers the `cadgang` MCP server. To register manually:

```bash
claude mcp add cadgang -- node /path/to/cadgang/src/mcp/index.js
```

The cadgang web server must be running (`npm start`). Set `CADGANG_URL` if it's not on `http://localhost:4477`.

### MCP tools

| Tool | What it does |
|---|---|
| `cadgang_list_node_types` | Discover every block type, its params and input slots |
| `cadgang_get_document` | Read the full model graph |
| `cadgang_create_node` / `cadgang_update_node` / `cadgang_delete_node` | Edit the graph |
| `cadgang_set_output` | Choose which block is meshed/exported |
| `cadgang_clear_document` | Wipe the model (destructive) |
| `cadgang_undo` | Undo (or redo) the last model edit |
| `cadgang_import_step` | Import a STEP/IGES/BREP file from disk as an `imported_mesh` block |
| `cadgang_eval_sdf` | Sample signed distances at points (thickness/clearance checks) |
| `cadgang_mesh_stats` | Triangle count, volume, surface area, bounds |
| `cadgang_export_stl` | Write a binary STL to `exports/` |
| `cadgang_render_preview` | Server-side raymarched PNG — Claude can *see* the model |

Ask Claude Code things like: *"Build a 60×40×24 mm rounded enclosure with a 2 mm wall, fill it with a 9 mm gyroid lattice, show me a preview, and export it for printing."*

## Block types

- **Primitives** — `sphere`, `box` (with rounding), `cylinder`, `torus`, `capsule`, `plane`, `gyroid`, `schwarz_p` (TPMS lattices), `polyhedron`, `spiky_sphere`, `imported_mesh` (STEP/IGES import), `extrude_face` (extrude a selected surface of an import)
- **Booleans** — `union`, `intersect`, `subtract`, `smooth_union`, `smooth_intersect`, `smooth_subtract` (blended fillets)
- **Modifiers** — `shell` (hollow to wall thickness), `offset`, `transform` (translate / rotate / scale), `drape` (vacuum-form a sheet over shapes, with smoothness control), `linear_array`, `polar_array`
- **Output** — `export_stl` (pass-through sink with a download button; params: filename, resolution)

Units are millimeters, world is Z-up. `plane`/`gyroid`/`schwarz_p` are unbounded fields — intersect them with a bounded body (that is how lattice infills are made).

### STEP import

Upload a `.step`/`.stp` (or IGES/BREP) file — **Import STEP** in the web UI, `POST /api/import/step`, or the `cadgang_import_step` MCP tool. The file is tessellated (WASM OpenCascade via `occt-import-js`), welded, stored as a document **asset**, and exposed as an `imported_mesh` block with an exact BVH signed-distance field. Each B-rep face of the import stays addressable as a triangle range, so surfaces are selectable in the viewport — click one to spawn an `extrude_face` block.

### Drape

`drape` drops a virtual sheet straight down (−Z) over its input shapes, like vacuum forming: it raycasts a top-surface heightfield at compile time, smooths it with a rolling-ball (parabolic) dilation of radius `blend`, and shells the result to `thickness`. `blend` controls how tightly the sheet wraps — 0 hugs every crease, larger values bridge gaps and round shoulders. `floor` sets where the skirt ends, `margin` how far the sheet overhangs.

## REST API

| Endpoint | Description |
|---|---|
| `GET /api/node-types` | Block type catalog |
| `GET /api/document` | Model graph + revision |
| `POST /api/nodes` · `PATCH /api/nodes/:id` · `DELETE /api/nodes/:id` | Graph editing |
| `POST /api/document/output` | Set output block |
| `POST /api/vars` · `DELETE /api/vars/:name` | User variables (usable in param expressions) |
| `POST /api/eval` | Evaluate SDF at points |
| `POST /api/undo` · `POST /api/redo` | Step the edit history (last 100 steps) |
| `GET /api/files` · `POST /api/files/save` · `POST /api/files/load` · `DELETE /api/files/:name` | Named model save/open |
| `POST /api/import/step?name=file.step` | Import STEP/IGES/BREP (raw body) → asset + `imported_mesh` node (`&node=id` attaches to an existing block instead) |
| `GET /api/assets` · `GET /api/assets/:id` · `DELETE /api/assets/:id` | Imported mesh assets (`:id` returns full triangles + per-face ranges) |
| `GET /api/mesh?resolution=90` | Surface-nets mesh (JSON) |
| `GET /api/mesh/stats` | Stats only |
| `GET /api/export/stl?resolution=128&file=name` | Binary STL |
| `GET /api/preview.png?yaw=-35&pitch=25&node=id` | Raymarched preview (any block, not just the output) |

`ws://…/ws` broadcasts `{type: "document_changed", revision}` on every edit.

## Architecture

```
src/core/     geometry kernel — pure JS, no server dependency
  sdf.js        block registry, graph → SDF closure compiler, bbox propagation
  expr.js       safe expression evaluator for variable-driven params
  mesher.js     naive surface-nets mesher (watertight, SDF-gradient normals)
  mesh.js       mesh utilities: welding, BVH signed distance, per-face ranges
  step.js       STEP/IGES/BREP tessellation (WASM OpenCascade)
  stl.js        binary STL writer
  render.js     CPU sphere-tracer + dependency-free PNG encoder
  document.js   persistent model document, undo history, autosave
src/server/   Express REST API + WebSocket + static hosting
src/mcp/      cadgang-mcp-server (stdio, @modelcontextprotocol/sdk)
web/          Three.js viewport + node-graph editor (no build step, no framework)
```

## Prior art & credits

- [kokopelli](https://github.com/mkeeter/kokopelli) → [Antimony](https://github.com/mkeeter/antimony) → [libfive](https://libfive.com) — Matt Keeter's f-rep CAD tools, the reason this way of thinking about geometry exists in open source
- [nTopology](https://www.ntop.com/) — implicit modeling at industrial scale; the gyroid-infill demo is their party trick
- [three.js](https://threejs.org) (MIT, vendored in `web/vendor/`) · [occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade WASM) · [Space Mono](https://fonts.google.com/specimen/Space+Mono) (SIL OFL 1.1, license in `web/fonts/OFL.txt`)

Built by [CW&T](https://cwandt.com) with Claude Code.
