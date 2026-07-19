---
name: docushark-research-writeup
description: Use when the user wants a researched or scholarly document in DocuShark — a lab/study write-up, literature note, or any prose that should cite real sources. Produces structured prose with inline citations, tables, math, and an optional diagram. Requires the DocuShark MCP server to be connected.
---

# Author a cited research write-up in DocuShark

Produce a scholarly document that **cites real sources** — inline citations backed
by the document's reference library — rather than a hand-typed list. Work in one
**team** document (MCP can't write local documents).

## Steps

1. **Create the document.** Call `create_document` with a clear `name`. Keep the
   returned `id` — it's `docId` for every later call.

2. **Find the pages.** Call `get_document(docId)` for `prosePages` (write here) and
   `pages` (a canvas page, if you want a figure).

3. **Add your sources to the library FIRST.** Call `add_reference(docId, …)` for
   each source — by `doi` (resolved for you via doi.org) or a CSL-JSON `items`
   object with a stable `id` (e.g. `"smith2020"`). Keep each id; you cite by it.

4. **Write the body with inline citations.** Call `set_prose(docId, prosePageId,
   content)`. Where you make a claim from a source, cite it inline (format:"html"):

   ```html
   Faster tempo loads attention during encoding
   <span data-citation data-ref-id="smith2020" data-label="(Smith, 2020)">(Smith, 2020)</span>.
   ```

   The `data-ref-id` must match an id you added in step 3. A typical structure:

   ```markdown
   # {{Title}}

   > **Field:** {{Field}} · **Author:** {{Author}}

   ## Background      (claims -> inline citations)
   ## Method
   ## Results         (a table; stats inline as $F(2,57)=8.1,\ p<.01$)
   ## Discussion
   ## References      (leave this heading empty — the bibliography is generated)
   ```

   Set field values with `set_fields`. If the doc won't be opened in an editor
   before you hand it off, bake fields as
   `<span data-field data-name="Author" data-label="…">…</span>` so they aren't blank.

5. **(Optional) Add a figure.** Use `generate_diagram(docId, canvasPageId, nodes,
   edges)` for a study-design or concept diagram, and refer to it from the prose.

6. **Leave the bibliography to the editor.** You populate the library and place the
   inline citations; the formatted `<div data-bibliography>` reference list is
   generated in the editor. Don't hand-type it.

7. **Confirm.** Call `get_document(docId)` — check the prose page and any canvas
   `shapeCount`. Give the user the document `id`/name.

## Tips

- **Cite by default.** Any factual claim drawn from a source gets an inline
  citation — never a manual "References" paragraph. The library + inline citations
  are the real, editor-native way, and they power the generated bibliography.
- **DOIs are easiest.** `resolve_doi` previews a reference; `add_reference` with a
  `doi` fills clean metadata automatically.
- **Math and tables** live in the same prose: `$…$` / `$$…$$` for equations, and
  Markdown tables for results.
