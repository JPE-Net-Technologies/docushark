---
name: docushark-architecture-rfc
description: Use when the user wants to write an architecture RFC, design doc, or system-design proposal in DocuShark — a prose document plus a system diagram of the components. Requires the DocuShark MCP server to be connected.
---

# Author an architecture RFC in DocuShark

Produce a design document with a written RFC and an auto-laid-out system diagram,
using the DocuShark MCP tools. Work in one **team** document (MCP can't write
local documents).

## Steps

1. **Create the document.** Call `create_document` with a clear `name`
   (e.g. `"RFC: <system> architecture"`). Keep the returned `id` — it's `docId`
   for every later call.

2. **Find the pages.** Call `get_document(docId)`. It returns `pages` (canvas pages,
   each `{ id, name, shapeCount }`) and `prosePages` (each `{ id, name, order }`).
   Use the first prose page's id for writing and the first canvas page's id for the
   diagram.

3. **Write the RFC skeleton.** Call `set_prose(docId, prosePageId, content)` with
   Markdown. Use a standard RFC shape and `{{field}}` tokens for values that recur:

   ```markdown
   # Architecture RFC: {{System}}

   **Status:** Draft · **Author:** {{Author}}

   ## Context & Problem
   ## Goals / Non-Goals
   ## Proposed Architecture
   ## Alternatives Considered
   ## Risks & Open Questions
   ```

   Then set the field values once with `set_fields(docId, [{name:"System", value:"…"}, …])`.

4. **Draft each section.** Fill sections from what the user told you. To edit just
   one section later without touching the rest, call `set_prose` with an `anchor`
   set to the exact current text of the block you're replacing (it's a
   compare-and-swap; if it matches none/several you get an `ERR_ANCHOR_*` error —
   read the page with `get_prose` and copy the block text). Use
   `insert_section(docId, prosePageId, level, title, body)` to add a heading+body,
   and `restructure_outline` (`promote`/`demote`/`move` by heading index from
   `get_outline`) to reorganize.

5. **Build the system diagram.** Call `generate_diagram(docId, canvasPageId, nodes, edges)`:
   - `nodes`: `[{ id, label, kind }]` — `id` is your logical id, `label` is the text,
     `kind` is `"rectangle"` (default) or `"ellipse"` (use ellipse for external
     actors/agents).
   - `edges`: `[{ from, to, label }]` referencing node `id`s.
   - Keep `layout: "layered"` and `routing: "orthogonal"` (the defaults) — the relay
     does Sugiyama layering + obstacle-avoiding routing, so don't pass coordinates.

   It returns `{ nodes: { <yourId>: <shapeId> }, edges: [<connectorId>], layout, routing }`.
   Keep the `nodes` map if you later need to tweak a specific shape with
   `update_shape`.

6. **Tie prose to the diagram.** In "Proposed Architecture", describe each node you
   created so the reader can match the prose to the picture.

7. **Confirm.** Call `get_document(docId)` and check the canvas page's `shapeCount`
   grew (nodes + connectors) and the prose page exists. Give the user the document
   `id`/name.

## Tips

- **Styling is inline.** To color a component, set it per shape (in `add_shape`/
  `update_shape` via `style: { fill, stroke, strokeWidth, labelColor }`, or `"AUTO"`
  for contrast-aware). There is no saved style-profile to reference over MCP.
- Prefer `generate_diagram` over hand-placing shapes — you get clean layout +
  routing for free. Use `add_shapes`/`connect` only for shapes the graph model can't
  express.
- Keep diagrams legible: ~5–12 nodes. Split a large system into multiple canvas
  pages rather than one dense graph.
