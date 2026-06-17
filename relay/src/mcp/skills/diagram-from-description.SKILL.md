---
name: docushark-diagram-from-description
description: Use when the user describes a system, flow, or sequence in words and wants it turned into a clean diagram in DocuShark (architecture, flowchart, dependency graph, or sequence-style flow). Requires the DocuShark MCP server to be connected.
---

# Generate a diagram from a description in DocuShark

Convert a plain-language description into an auto-laid-out diagram. The relay does
all positioning and routing — your job is to model the description as a graph of
**nodes** and **edges**. Work in one **team** document.

## Steps

1. **Model the description as a graph.** Extract:
   - **Nodes** — the things (services, steps, states, participants). Give each a
     short stable `id` and a human `label`.
     Mark anything external/an actor as `kind: "ellipse"`; everything else is a
     `"rectangle"`.
   - **Edges** — the relationships/messages/transitions, each `{ from, to, label }`
     by node `id`. Direction matters: it drives the layout and the arrowhead.
   - For a **sequence/flow**, order the edges as the steps happen (1→2→3…); the
     layered layout reads top-to-bottom along edge direction.

2. **Create or reuse a document.** `create_document` (keep the `id`), or use an
   existing team `docId` the user names. Get a canvas page id from
   `get_document(docId).pages[0].id`.

3. **Generate the diagram.**
   `generate_diagram(docId, canvasPageId, nodes, edges, layout, routing)`:
   - `nodes`: `[{ id, label, kind? }]` (unique ids; min 1; up to 500).
   - `edges`: `[{ from, to, label? }]` (up to 1000; every endpoint must name a node).
   - `layout`: `"layered"` (default with edges — best for flow/architecture/sequence)
     or `"grid"` (for an unconnected set of nodes).
   - `routing`: `"orthogonal"` (default — right-angle paths around shapes, with
     waypoints) or `"straight"` (plain lines).
   - Returns `{ nodes: { id: shapeId }, edges: [connectorId], layout, routing }`.

4. **Refine if asked.** To rename/recolor/resize a specific node, look up its shape
   id in the returned `nodes` map and call `update_shape(docId, canvasPageId, id,
   patch)` with a subset of `{ x, y, w, h, text, style }`. To add a stray connector
   the graph missed, use `connect(docId, canvasPageId, fromId, toId, label)`.

5. **Confirm.** `get_page(docId, canvasPageId)` to see the placed shapes, or
   `get_document` to check `shapeCount`. Report what you drew.

## Tips

- **Don't pass coordinates.** Let `generate_diagram` lay things out; hand-placing
  fights the router. Only `update_shape` x/y for deliberate nudges.
- Parallel edges between the same two nodes are automatically staggered, and
  self-loops get a clean path — model them naturally.
- Styling is inline per shape (`style: { fill, stroke, strokeWidth, labelColor }`,
  or `"AUTO"`). There's no saved style-profile over MCP.
- If the description is really two diagrams (e.g. a high-level map + a detailed
  sequence), make two and put each on its own canvas page for legibility.
