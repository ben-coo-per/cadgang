/**
 * MCP tools for the v2 cell document.
 *
 * The tool descriptions here are load-bearing. In v1 the modeling vocabulary was
 * discoverable at runtime — `cadgang_list_node_types` enumerated every block —
 * because the vocabulary WAS the ceiling. A cell writes JavaScript, so there is
 * no list to enumerate; the API reference below is how the vocabulary gets
 * taught, and it is the closest thing v2 has to a block palette.
 */

import { z } from 'zod';

const CELL_API = `A cell program is ES-module source with exactly two exports:

  export const params = { w: 60, d: 40, h: 24, r: 3 };
  export default ({ p, brep, q, assert, input, inputs, topology }) => {
    let s = brep.box(p.w, p.d, p.h);
    s = brep.fillet(s, q.edges(s).linear().along('z').expect(4), p.r);
    return brep.shell(s, q.faces(s).planar().facing('+z').expect(1), 2);
  };

Hoist every number a human might want to turn into 'params'. Changing a param re-runs the program; it never re-prompts. The program MUST return a solid.

ARGUMENTS
  p        the current parameter values (numbers, strings, booleans only)
  input    the previous cell's solid — the running "that" ("subtract that from the body")
  inputs   results keyed by cell id, when the cell declares explicit refs
  brep, q, assert, topology  as below

brep — box(sx,sy,sz,{center:'xy'|'xyz'|''}) sitting on z=0 unless centered; cylinder(r,h,{center}); sphere(r);
  union/subtract/intersect(base, ...tools); fillet(shape, edgeQuery, radius); chamfer(shape, edgeQuery, distance);
  shell(shape, faceQuery|null, thickness) — POSITIVE thickness hollows INWARD, negative grows outward, null query seals a void;
  translate(shape,[x,y,z]); rotate(shape, deg, axis=[0,0,1], origin); scale(shape, factor, origin); mirror(shape,'XY'|'XZ'|'YZ', origin);
  volume(shape); area(shape); bbox(shape) -> {min,max,size}

q — q.faces(shape) / q.edges(shape), then chain filters:
  kinds: planar() cylindrical() conical() spherical() toroidal() | linear() circular() elliptical() | ofKind('PLANE',...)
  direction: along('z'|'+x'|[0,0,1]) for edges; facing('+z') for faces (sign matters: '+z' is the top, 'z' is both)
  measure: ofLength(v,tol) ofArea(v,tol) ofRadius(v,tol) ofDiameter(v,tol) largerThan(v) smallerThan(v)
  place: near([x,y,z], dist) inBox([x,y,z],[x,y,z]) atExtreme('+z')
  combine: either(s => s.linear(), s => s.circular()) exclude(s => s.facing('-z')) where(d => d.area > 10)
  finish: expect(n) — ASSERT the count and carry on; count(); one(); all(); explain()

Always end a query with .expect(n). A query that matches an unexpected number of entities then fails the cell loudly instead of quietly building a different part. A query that matches nothing is always an error.

assert — ok(cond,msg); volumeUnder(shape,v); volumeOver(shape,v); fitsIn(shape,[x,y,z])

The program runs in an isolated realm: no filesystem, network, timers, or process, and a wall-clock budget. Standard JS (Math, Array, loops, functions) is available, so arrays of holes, patterns and derived dimensions are ordinary code.

THE AUTHORING LOOP — you cannot see the model, so introspection replaces looking:
  1. cadgang_cells_add with the prompt and a first draft of the code
  2. cadgang_cells_topology — read the real faces and edges of what you built
  3. cadgang_cells_query — confirm a query catches what you meant BEFORE applying it
  4. cadgang_cells_add / _compile the operation that uses it
  5. cadgang_cells_render — look at it
  6. cadgang_cells_evaluate — confirm every cell is 'ok'`;

const CELL_STATUS = `Cell status: 'ok' (code matches prompt) | 'stale' (prompt edited past the code) | 'diverged' (code hand-edited past the prompt) | 'awaiting_pick' (needs a user selection). Evaluation failure is reported by cadgang_cells_evaluate, not stored on the cell.`;

/**
 * Register the cell tools.
 *
 * `call`, `ok` and `fail` are the same HTTP and result helpers the v1 tools use,
 * passed in rather than duplicated.
 */
export function registerCellTools(server, { call, ok, fail, base }) {
  const paramValue = z.union([z.number(), z.string(), z.boolean()]);

  server.registerTool(
    'cadgang_cells_get',
    {
      title: 'Get the cadgang cell document',
      description: `Return the v2 cell document: the ordered stack of cells with each one's prompt, code, params, refs, selections and status, plus the output cell and revision.

A document is an ordered stack, not a free graph. A cell with no 'refs' consumes the previous cell's result. Explicit refs may only point BACKWARDS, which is what makes cycles impossible.

${CELL_STATUS}`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try { return ok(await call('/cells/document')); } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_add',
    {
      title: 'Add a cell to the cadgang cell stack',
      description: `Append a cell: a natural-language prompt plus the geometry program it compiles to.

The prompt is the source of record and the code is a LOCKFILE. Geometry never regenerates from a prompt on its own — that is what stops the same file becoming a different part between two openings.

Args:
  - id: cell id, used as a reference name (letters, digits, underscore)
  - prompt: what this cell is meant to do, in words
  - code: the program (see below). May be omitted and compiled later.
  - refs: cell ids this one consumes. Omit for the common case — the previous cell.
  - params: overrides for the program's declared defaults
  - selections: picks this cell needs from the user, e.g. {"lip": "edge"}; the cell parks in 'awaiting_pick' until resolved
  - at: insert position (default: end of the stack)

${CELL_API}`,
      inputSchema: {
        id: z.string().optional().describe('Cell id (auto-generated if omitted)'),
        prompt: z.string().optional().describe('What this cell does, in words'),
        code: z.string().optional().describe('The cell program'),
        refs: z.array(z.string()).optional().describe('Cell ids consumed (default: the previous cell)'),
        params: z.record(paramValue).optional(),
        selections: z.record(z.enum(['face', 'edge'])).optional().describe('Picks the user must make'),
        at: z.number().int().optional().describe('Insert position'),
        compiledBy: z.string().optional().describe('Model that authored the code'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try { return ok(await call('/cells', { method: 'POST', body: args })); } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_update',
    {
      title: 'Edit a cell',
      description: `Change a cell's params, prompt, refs, or code.

Use this for PARAMETERS — that is the whole point of hoisting them. Changing a param re-runs the committed program and leaves the cell 'ok'; turning a knob is not a change of intent.

Editing 'prompt' here marks the cell 'stale' and does NOT touch the geometry. Editing 'code' here marks it 'diverged'. To change what the part IS, edit the prompt and then call cadgang_cells_compile with the new code — that is the only route back to 'ok', and it records the provenance.

${CELL_STATUS}`,
      inputSchema: {
        id: z.string().describe('Cell id'),
        params: z.record(paramValue).optional().describe('Parameter values to change'),
        prompt: z.string().optional().describe('New prompt (marks the cell stale)'),
        code: z.string().optional().describe('New code (marks the cell diverged)'),
        refs: z.array(z.string()).optional().describe('Cells consumed; must point backwards'),
        selections: z.record(z.enum(['face', 'edge'])).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, ...body }) => {
      try {
        return ok(await call(`/cells/${encodeURIComponent(id)}`, { method: 'PATCH', body }));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_compile',
    {
      title: 'Commit a recompiled cell',
      description: `Replace a cell's program with code you generated from its prompt, and record that the two now agree.

This is the only path back to status 'ok'. It is deliberately separate from cadgang_cells_update because the difference between "regenerated from the prompt" and "someone edited the code by hand" is exactly the provenance the lockfile exists to record.

Params the new program still declares keep whatever value the user had dialled in; params it dropped are removed.

${CELL_API}`,
      inputSchema: {
        id: z.string().describe('Cell id'),
        code: z.string().describe('The recompiled program'),
        prompt: z.string().optional().describe('Prompt this code was compiled from'),
        params: z.record(paramValue).optional().describe('Values to carry over'),
        compiledBy: z.string().optional().describe("Model that authored it, e.g. 'claude-opus-5'"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, ...body }) => {
      try {
        return ok(await call(`/cells/${encodeURIComponent(id)}/compile`, { method: 'POST', body }));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_delete',
    {
      title: 'Delete a cell',
      description: 'Remove a cell from the stack. Refused while a later cell references it — rewire that cell first.',
      inputSchema: { id: z.string().describe('Cell id') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        return ok(await call(`/cells/${encodeURIComponent(id)}`, { method: 'DELETE' }));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_topology',
    {
      title: 'Read the topology of a cell result',
      description: `Return every face and edge of a cell's solid with the properties a query filters on — this is how you SEE the model.

  faces: id, surface kind, area, centroid, normal, bbox, adjacent edges
  edges: id, curve kind, length, midpoint, direction, adjacent faces
  measures: volume, surface area, bounding box

Read this before writing a query, and again after an operation to confirm it did what you meant. Note the ids are positional and change as the model changes — never reference geometry by id. Turn what you learn here into a QUERY (cadgang_cells_query), which survives a parameter change.

Args:
  - cell: cell id (defaults to the output/last cell)`,
      inputSchema: { cell: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ cell }) => {
      try {
        const qs = cell ? `?cell=${encodeURIComponent(cell)}` : '';
        return ok(await call(`/cells/topology${qs}`));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_query',
    {
      title: 'Test a geometry query against a cell result',
      description: `Resolve a query expression against a cell's solid and report what it catches, WITHOUT changing the document.

Use this before every fillet, chamfer, or shell. Confirming an expression selects the four vertical edges and not twelve is the difference between generated geometry you can trust and generated geometry you are hoping about.

The expression is ordinary cell-language JavaScript with 'q' and 'shape' in scope, so what you test here is exactly what you paste into the cell:

  q.edges(shape).linear().along('z')
  q.faces(shape).planar().facing('+z')
  q.edges(shape).circular().ofRadius(3).near([0, 0, 24], 5)

Returns the resolved expression, the match count, and a descriptor for each match.

Args:
  - expression: the query
  - cell: cell id to resolve against (defaults to the output/last cell)`,
      inputSchema: {
        expression: z.string().describe("e.g. q.edges(shape).linear().along('z')"),
        cell: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try { return ok(await call('/cells/query', { method: 'POST', body: args })); } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_evaluate',
    {
      title: 'Run the cell stack and report',
      description: `Evaluate the stack and report per-cell status, console output and timing, plus the final volume, area and bounding box. No geometry payload — this is the cheap "did my edit work" call.

Only the cells the target actually consumes are run, so an abandoned branch costs nothing.

Args:
  - cell: evaluate up to this cell (defaults to the output/last cell)
  - stopOnError: false walks the whole stack and reports every broken cell in one pass instead of one round trip per failure (default true)`,
      inputSchema: {
        cell: z.string().optional(),
        stopOnError: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ cell, stopOnError }) => {
      try {
        const qs = new URLSearchParams();
        if (cell) qs.set('cell', cell);
        if (stopOnError === false) qs.set('stopOnError', '0');
        return ok(await call(`/cells/evaluate${qs.size ? `?${qs}` : ''}`));
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_render',
    {
      title: 'Render a preview of the cell stack',
      description: `Raymarch the cell stack server-side and return a shaded PNG so you can SEE the geometry. Use after edits to verify visually — topology tells you what is there, this tells you whether it looks right.

Args:
  - cell: cell to render (defaults to the output/last cell)
  - yaw: orbit angle in degrees around Z (default -35)
  - pitch: elevation in degrees (default 25; 90 = top view)
  - width/height: image size in px`,
      inputSchema: {
        cell: z.string().optional(),
        yaw: z.number().min(-360).max(360).default(-35),
        pitch: z.number().min(-89).max(89).default(25),
        width: z.number().int().min(64).max(1280).default(640),
        height: z.number().int().min(64).max(960).default(480),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ cell, yaw, pitch, width, height }) => {
      try {
        const qs = new URLSearchParams({
          yaw: String(yaw), pitch: String(pitch), width: String(width), height: String(height),
        });
        if (cell) qs.set('cell', cell);
        const png = await call(`/cells/preview.png?${qs}`, { raw: true });
        return {
          content: [
            { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: `Rendered ${width}x${height} preview (yaw ${yaw}°, pitch ${pitch}°).` },
          ],
        };
      } catch (e) { return fail(e); }
    }
  );

  server.registerTool(
    'cadgang_cells_export',
    {
      title: 'Export the cell stack',
      description: `Write the cell stack's solid to exports/<filename>.<step|stl> in the cadgang repo (server-side) and return the path.

Cells are exact B-rep the whole way through — there is no field lineage to fall out of — so STEP always works and reopens in Fusion, SolidWorks or OnShape as editable geometry rather than a faceted import. Use STL only for printing.

Args:
  - filename: base name, no extension
  - format: 'step' (default) or 'stl'
  - cell: cell to export (defaults to the output/last cell)`,
      inputSchema: {
        filename: z.string().regex(/^[\w.-]+$/, 'Use letters, digits, dot, dash, underscore only'),
        format: z.enum(['step', 'stl']).default('step'),
        cell: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ filename, format, cell }) => {
      try {
        const qs = new URLSearchParams({ file: filename });
        if (cell) qs.set('cell', cell);
        const res = await fetch(`${base}/api/cells/export/${format}?${qs}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `cadgang API error (HTTP ${res.status})`);
        }
        const bytes = (await res.arrayBuffer()).byteLength;
        return ok({
          savedTo: res.headers.get('x-saved-to'),
          bytes,
          format: format === 'step' ? 'STEP AP214 (exact B-rep)' : 'binary STL',
        });
      } catch (e) { return fail(e); }
    }
  );
}
