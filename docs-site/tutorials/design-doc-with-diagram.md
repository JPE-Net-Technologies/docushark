---
title: "Tutorial: A Design Doc with a Diagram Beside It"
description: A guided, end-to-end walkthrough — write a short design doc and build its architecture diagram in the same DocuShark document.
---

# Tutorial: A Design Doc with a Diagram Beside It

This is the walkthrough that shows off what makes DocuShark different: **prose and
a diagram in one document, side by side.** In about 15 minutes you'll write a
short design doc and build the architecture diagram that goes with it — no
app-switching, no pasted screenshots.

**What you'll build:** a one-page "URL Shortener" design doc — a written spec on
the left, a live architecture diagram on the right.

**You'll learn:** prose pages, the Write · Split · Diagram focus, drawing shapes
and smart connectors, auto-layout, and exporting the result.

**Before you start:** just [open DocuShark](https://app.docushark.app) — no setup
needed. New here? Skim [How DocuShark Is Organized](/guide/concepts) first.

## 1. Create and name the document

From the **Documents** home, click **New**. The document opens on an empty
canvas. Click **Untitled Document** in the toolbar and rename it to
`URL Shortener — Design`.

## 2. Write the spec

You'll start in writing mode. If you're not already in it, click **Write** in the
**Write · Split · Diagram** control in the toolbar.

In the document editor, write a short spec. Type naturally, and use the toolbar
(or Markdown shortcuts) for structure:

```
# URL Shortener

## Goal
Turn long URLs into short, shareable links and redirect visitors quickly.

## Requirements
- Create a short code for any URL
- Redirect a short code to its original URL
- Count how many times each link is used
```

Add a callout to flag an open question — from the toolbar's block menu, insert a
**block quote** (or type `>`), and note: *"Open question: how long should codes
be?"*

<!-- SCREENSHOT: the prose editor in Write focus showing the URL Shortener spec with headings, a bullet list, and a blockquote -->

::: tip
The document editor is a full rich-text surface — headings, tables, code, LaTeX
math, and callouts all work. See [Rich Text & Notes](/guide/rich-text-editor).
:::

## 3. Bring in the canvas

Now put the diagram next to the writing. Click **Split** in the
**Write · Split · Diagram** control. The document editor stays on the left and an
infinite **canvas** opens on the right — the same document, two views.

<!-- SCREENSHOT: Split focus — the spec on the left, an empty canvas on the right -->

## 4. Draw the architecture

You'll sketch four boxes: **Browser → API → Database**, with a **Cache** beside
the API.

1. Press `R` (Rectangle) and drag out a box near the top-left of the canvas.
   Double-click it and type `Browser`.
2. Repeat for three more boxes: `API`, `Database`, and `Cache`. Press `R` again
   before each (or grab it from the toolbar).
3. Press `V` to return to the Select tool, and drag the boxes into a rough
   left-to-right row, with `Cache` sitting below `API`.

Don't fuss over alignment — step 6 tidies it automatically.

<!-- SCREENSHOT: four labelled rectangles (Browser, API, Database, Cache) roughly placed on the canvas -->

## 5. Connect the boxes

1. Press `C` (Connector).
2. Hover over the **Browser** box until its **connection points** appear as small
   circles on the edges. Click one, then click a connection point on **API**. The
   connector routes itself between them.
3. Connect **API → Database**, and **API → Cache** the same way.
4. Add labels: click a connector's label area and type — for example `HTTP` on
   Browser → API, and `cache read` on API → Cache.

Move any box (press `V` first) and watch the connectors follow — they stay
attached. See [Connectors](/guide/connectors) for routing styles.

<!-- SCREENSHOT: the four boxes connected with labelled smart connectors -->

## 6. Tidy it with auto-layout

Let DocuShark arrange the diagram for you. Select the connected shapes
(`Ctrl/Cmd+A` selects everything on the page), then open the **command palette**
with `Ctrl/Cmd+K` and search **"layout"** — run the auto-layout command. The
boxes snap into a clean, evenly-spaced flow with tidy connector routing.

<!-- SCREENSHOT: the same diagram after auto-layout — evenly spaced, clean routing -->

## 7. Read it as one document

Switch focus back to **Split** (or **Write**) and scroll: your spec and its
diagram are one thing now. Edit the prose and the diagram is still right there;
move a box and the writing doesn't budge. Nothing to keep in sync by hand.

## 8. Save, share, or export

DocuShark **auto-saves** as you go. To share or hand it off:

- **Share live:** connect the document to a workspace and invite others to edit
  in real time — see [Collaboration](/guide/collaboration).
- **Export:** use **Export** for a **PDF** (prose *and* diagram, in order), or
  **PNG/SVG** of the current canvas. See [Export & Import](/guide/export-import).

## What you learned

You built a document that holds **both** a written spec and its live diagram —
the core DocuShark workflow. You used prose pages, the Write · Split · Diagram
focus, rectangles and smart connectors, auto-layout, and export.

## Next steps

- **[Tutorial: Diagram an AWS Architecture](/tutorials/aws-architecture-diagram)**
  — go deeper on shape libraries and cloud icons.
- **[Citations & References](/guide/citations)** — cite sources in your spec and
  generate a bibliography.
- **[Document Fields](/guide/document-fields)** — reuse values like a service name
  across the whole document at once.
