---
name: docushark-document-codebase-module
description: Use when the user wants to document a code module, service, or package in DocuShark — a prose walkthrough of its responsibilities and APIs plus a component diagram showing how the pieces relate. Requires the DocuShark MCP server to be connected.
---

# Document a codebase module in DocuShark

Turn your understanding of a module (from reading its code) into a DocuShark
document: a prose reference plus a component diagram. Work in one **team** document.

## Steps

1. **Gather the facts first.** From the code, identify: the module's purpose, its
   main components (files/classes/functions), each component's responsibility, the
   public API/entry points, and the dependencies *between* components (who calls
   whom). You'll turn the "who calls whom" into diagram edges.

2. **Create the document.** `create_document` with `name` like
   `"<module> — module reference"`. Keep the `id` (`docId`).

3. **Get the page ids.** `get_document(docId)` → take the first `prosePages[].id`
   (prose) and the first `pages[].id` (canvas).

4. **Write the reference.** `set_prose(docId, prosePageId, content)` in Markdown:

   ```markdown
   # {{Module}} — Module Reference

   ## Overview
   One paragraph: what it does and where it sits.

   ## Components
   | Component | Responsibility | Key API |
   |---|---|---|
   | … | … | … |

   ## Data / Control Flow
   How a request moves through the components (mirrors the diagram).

   ## Gotchas
   - …
   ```

   Use a GFM table for the component list (tables are supported). Set
   `{{Module}}` with `set_fields`.

5. **Draw the component diagram.** `generate_diagram(docId, canvasPageId, nodes, edges)`:
   - One `node` per component: `{ id, label }` (use the component name as `label`).
   - One `edge` per dependency: `{ from, to, label }` where `label` is the relationship
     ("calls", "reads", "emits"). Edge direction = caller → callee.
   - Leave `layout: "layered"` / `routing: "orthogonal"` (defaults) so the relay
     lays it out by dependency direction.

   It returns `{ nodes: { id: shapeId }, edges: [connectorId], … }`.

6. **Cross-link.** In "Data / Control Flow", reference the same component names so
   the prose and the diagram describe the same thing.

7. **Verify.** `get_document(docId)` — the canvas page `shapeCount` should equal
   components + dependencies. Return the document id/name.

## Tips

- If the module has distinct layers (e.g. API / core / storage), color them inline
  per shape (`style.fill`) via `update_shape` after `generate_diagram`, using the
  returned `nodes` map to find each shape id. There's no saved style-profile over
  MCP, so set colors inline.
- Keep one diagram per cohesive view. For a big module, make a high-level component
  diagram on page 1 and a detailed sub-flow on another canvas page.
- For an external dependency (a third-party service), use `kind: "ellipse"` to
  visually distinguish it from in-module components.
