---
title: "Tutorial: A design doc with a diagram"
description: Write a short design doc and draw its architecture beside it in one DocuShark document, with connectors, auto-layout and a PDF at the end.
---

# Tutorial: A design doc with a diagram

This tutorial shows what makes DocuShark different: **the writing and the diagram in one document, side by side.** In about fifteen minutes you'll write a short design doc and draw the architecture that goes with it, with no switching between apps and no pasted screenshots.

**You'll build** a one-page "URL Shortener" design doc: a written spec beside a live architecture diagram.

**You'll learn** Write and Split, drawing shapes and connectors, auto-layout, and exporting the result.

## 1. Create the document

In **Documents**, click **New**. The document opens ready for writing. Type `#`, a space, and `URL Shortener`: DocuShark names the document after that first heading.

## 2. Write the spec

Write a short spec under the title. Type `##` and a space for each section heading, and `-` and a space for a list:

```
## Goal
Turn long URLs into short, shareable links, and redirect visitors quickly.

## Requirements
- Create a short code for any URL
- Redirect a short code to its original URL
- Count how often each link is used
```

Flag an open question in a callout: choose **Insert → Insert callout** (or type `/callout`) and write *Open question: how long should codes be?* See [Write](/guide/write).

## 3. Bring in the canvas

Click **Split** at the top. Your writing stays on the left, and a canvas opens on the right: two views of the same document.

## 4. Draw the architecture

You'll draw four boxes: **Browser**, **API** and **Database** in a row, with a **Cache** beside the API.

1. Choose **Rectangle** in the tool row above the canvas and drag out a box. Double-click it, type `Browser` and press **Enter**.
2. Draw three more the same way: `API`, `Database` and `Cache`. Once you've clicked the canvas, `R` picks the rectangle too.
3. Choose **Select** (`V`) and drag the boxes into a rough row, with `Cache` below `API`.

Don't fuss over alignment; step 6 tidies it.

## 5. Connect the boxes

1. Choose **Connector** (`C`).
2. Drag from **Browser** to **API**. The connector finds its own path, and stays attached when you move either box.
3. Connect **API** to **Database**, and **API** to **Cache**, the same way.
4. Choose **Select** (`V`) and double-click a connector to label it: type `HTTPS` on Browser → API and `read` on API → Cache, pressing **Enter** after each.

See [Connectors](/guide/draw#connectors) for routing styles and arrowheads.

## 6. Tidy it with auto-layout

Select **Browser**, press `Ctrl+Shift+A` to select everything connected to it, then `Ctrl+Shift+L`. DocuShark arranges the boxes in an even flow from top to bottom and re-routes the connectors. (**Auto-layout selection (left to right)**, in the command palette under `Ctrl+K`, lays it out in a row instead.)

## 7. Read it as one document

Scroll your writing with the diagram beside it: the spec and its architecture are one thing now. Edit the text and the diagram stays put; move a box and the text doesn't budge. There's nothing to keep in sync by hand.

## 8. Share it or export it

DocuShark saves as you go. To hand the doc on:

- **Work on it together:** move it into your workspace and share it. See [Share and collaborate](/guide/share).
- **A PDF:** choose **Share → Export to PDF…**. It holds the spec and the diagram, page by page.
- **A picture of the diagram:** click the canvas, press `Ctrl+A`, right-click a box and choose **Export Selection…** for a PNG or SVG.

See [Export and import](/guide/export-import).

## What you learned

You built a document that holds both a written spec and its live diagram, the core of working in DocuShark: Write and Split, shapes and connectors, auto-layout, and export.

## Next steps

- Go further with [shape libraries and cloud icons](/guide/draw#shape-libraries), or [UML and ERD](/guide/draw#uml-and-erd).
- Keep names and versions consistent with [fields](/guide/write#fields).
- Already have diagrams in Mermaid, draw.io or Excalidraw? [Import them](/guide/export-import#import).
