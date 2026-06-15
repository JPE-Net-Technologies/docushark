---
name: docushark-meeting-notes-to-doc
description: Use when the user has raw meeting notes, a transcript, or a brain-dump and wants a clean, structured DocuShark document — summary, decisions, action items, and an organized outline. Requires the DocuShark MCP server to be connected.
---

# Turn meeting notes into a structured document in DocuShark

Convert messy notes into a well-organized prose document with a clear outline. Work
in one **team** document. This recipe is prose-only (no diagram) unless the notes
clearly describe a flow worth drawing.

## Steps

1. **Read and classify the notes.** Separate the raw input into: a one-paragraph
   **summary**, **decisions made**, **action items** (owner + what + when),
   **discussion** by topic, and **open questions**.

2. **Create the document.** `create_document` with a descriptive `name`
   (e.g. `"<topic> — <date> notes"`). Keep the `id`. Get the first prose page id
   from `get_document(docId).prosePages[0].id`.

3. **Write the structured page.** `set_prose(docId, prosePageId, content)` in
   Markdown. Put the high-value parts first:

   ```markdown
   # {{Title}}

   **Date:** {{Date}} · **Attendees:** {{Attendees}}

   ## Summary
   …

   ## Decisions
   - …

   ## Action Items
   - [ ] **@owner** — task — _due …_

   ## Discussion
   ### <Topic 1>
   …

   ## Open Questions
   - …
   ```

   Use task-list checkboxes (`- [ ]`) for action items (supported), and set
   `{{Title}}`/`{{Date}}`/`{{Attendees}}` with `set_fields`.

4. **Organize the discussion.** Add one `### <Topic>` per discussion thread. If you
   write topics out of order, fix the structure with the outline tools rather than
   rewriting the page:
   - `get_outline(docId, prosePageId)` → the flat list of headings with their
     `index` and `level`.
   - `restructure_outline(docId, prosePageId, op, index, toIndex?)` to
     `move` / `promote` / `demote` a section.
   - `insert_section(docId, prosePageId, level, title, body, afterIndex?)` to slot a
     new section in a specific spot.

5. **Refine a single section** without touching the rest by calling `set_prose`
   with `anchor` = the exact current text of the block to replace (read it first
   with `get_prose`; it's a compare-and-swap that errors rather than clobbering if
   ambiguous).

6. **Confirm.** `get_prose(docId, prosePageId)` to review, then return the document
   id/name and a one-line recap (e.g. "3 decisions, 5 action items").

## Tips

- Lead with **Decisions** and **Action Items** — they're what people reopen the doc
  for. Keep "Discussion" as the supporting detail.
- Prose is Markdown (GFM): use tables for attendee/owner grids, headings for the
  outline, and `{{fields}}` for values you'll reuse across related docs.
- Each write replaces the whole page unless you use `anchor`; for incremental
  additions during a long meeting, prefer `insert_section` or anchored `set_prose`
  so you don't overwrite earlier content.
