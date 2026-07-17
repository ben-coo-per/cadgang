# cadgang

A web-based implicit modeling CAD tool in the spirit of [nTopology](https://www.ntop.com/), with a built-in **MCP server** so Claude Code can drive it end-to-end: build models, inspect geometry, render previews, and export STLs.

![cadgang UI](docs/screenshot-ui.png)

Models are **graphs of blocks** evaluated as signed distance fields (SDFs) — the same representation nTopology uses. Because geometry is a function, not a mesh, booleans never fail, shells are exact, and lattices are free.

| Raymarched preview | Gyroid lattice infill |
|---|---|
| ![part](docs/preview-part.png) | ![gyroid](docs/preview-gyroid.png) |

## Quickstart

```bash
npm install
npm start          # → http://localhost:4477
npm run demo       # builds a gyroid-filled demo part via the API
npm test           # kernel unit tests
```

Open http://localhost:4477 — the viewport live-updates (WebSocket) whenever the model changes, whether from the UI, the REST API, or Claude via MCP.

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
| `cadgang_eval_sdf` | Sample signed distances at points (thickness/clearance checks) |
| `cadgang_mesh_stats` | Triangle count, volume, surface area, bounds |
| `cadgang_export_stl` | Write a binary STL to `exports/` |
| `cadgang_render_preview` | Server-side raymarched PNG — Claude can *see* the model |

Ask Claude Code things like: *"Build a 60×40×24 mm rounded enclosure with a 2 mm wall, fill it with a 9 mm gyroid lattice, show me a preview, and export it for printing."*

## Block types

- **Primitives** — `sphere`, `box` (with rounding), `cylinder`, `torus`, `capsule`, `plane`, `gyroid`, `schwarz_p` (TPMS lattices)
- **Booleans** — `union`, `intersect`, `subtract`, `smooth_union`, `smooth_intersect`, `smooth_subtract` (blended fillets)
- **Modifiers** — `shell` (hollow to wall thickness), `offset`, `transform` (translate / rotate / scale)

Units are millimeters, world is Z-up. `plane`/`gyroid`/`schwarz_p` are unbounded fields — intersect them with a solid body (that is how lattice infills are made).

## REST API

| Endpoint | Description |
|---|---|
| `GET /api/node-types` | Block type catalog |
| `GET /api/document` | Model graph + revision |
| `POST /api/nodes` · `PATCH /api/nodes/:id` · `DELETE /api/nodes/:id` | Graph editing |
| `POST /api/document/output` | Set output block |
| `POST /api/eval` | Evaluate SDF at points |
| `GET /api/mesh?resolution=90` | Surface-nets mesh (JSON) |
| `GET /api/mesh/stats` | Stats only |
| `GET /api/export/stl?resolution=128&file=name` | Binary STL |
| `GET /api/preview.png?yaw=-35&pitch=25` | Raymarched preview |

`ws://…/ws` broadcasts `{type: "document_changed", revision}` on every edit.

## Architecture

```
src/core/     geometry kernel — pure JS, no server dependency
  sdf.js        block registry, graph → SDF closure compiler, bbox propagation
  mesher.js     naive surface-nets mesher (watertight, SDF-gradient normals)
  stl.js        binary STL writer
  render.js     CPU sphere-tracer + dependency-free PNG encoder
  document.js   persistent model document (autosaved to data/document.json)
src/server/   Express REST API + WebSocket + static hosting
src/mcp/      cadgang-mcp-server (stdio, @modelcontextprotocol/sdk)
web/          Three.js viewport + block/param editor (no build step)
```

The model document is autosaved to `data/document.json`, so the UI and MCP always share one model and state survives restarts.

## Pushing this repo to GitHub

The repo is local. To publish it as a private GitHub repo:

```bash
gh repo create cadgang --private --source . --push
# or manually:
git remote add origin git@github.com:<you>/cadgang.git
git push -u origin main
```
