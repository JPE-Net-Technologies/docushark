---
title: Export and import
description: Export a document as a PDF, a picture or a .docushark file, back up everything, and import diagrams from Mermaid, draw.io and Excalidraw.
---

# Export and import

| To get | Do this |
|---|---|
| A PDF of the whole document | **Tools → Export to PDF…** |
| A picture (PNG or SVG) of a diagram | Select the shapes, right-click, and choose **Export Selection…** |
| The editable document as one file | Select it in **Documents** and click **Export** |
| A copy of everything, for a new computer | **Settings → Backup & Restore** |
| Shapes from Mermaid, draw.io or Excalidraw | **Tools → Import diagram…** |

## PDF {#pdf}

**Tools → Export to PDF…** prints the whole document: every prose and canvas page in order, with the formatting, tables, equations, images, embedded diagrams, code and task lists. Fields show their values, and the [document font](./write#document-font) is embedded, so the PDF looks the same wherever it's opened.

Pages break where they would in a printed book:

- A heading moves to the next page rather than sit alone at the foot of one, unless what follows it is a page tall on its own (a full-page image, say).
- A table that runs onto another page repeats its header row at the top.
- Long code blocks and tall table rows continue on the next page.

The dialog sets:

- **Page size** (A4, Letter, A3 or Tabloid) and **orientation**.
- **Image quality:** Standard (72 DPI), High (150 DPI) or Print (300 DPI).
- **Margins**, **page numbers**, a **table of contents**, and a **PDF outline**, the bookmarks a PDF reader shows beside the pages.
- A **cover page** with a title, version, author, date, description and your logo.
- How diagrams appear, including whether they keep the canvas's dark background in the dark theme.

## Pictures: PNG and SVG {#images}

Select the shapes you want (`Ctrl+A` selects the whole page), right-click one, and choose **Export Selection…**. Then pick:

- **PNG**, a picture for an email, a slide or a document. **Scale** sets the resolution; 2× suits most screens, 3× suits print.
- **SVG**, which keeps shapes sharp at any size and text as real text. Use it for websites, or to edit the diagram further in a tool such as Inkscape or Illustrator.

Both let you choose a background, or none, and how much space to leave around the shapes. Only canvas shapes are exported; for your writing, use the PDF.

## .docushark files {#docushark-files}

A `.docushark` file holds one whole document, with its images and attached files, ready to open in DocuShark.

- **Export:** in **Documents**, point at a document's card and tick the box that appears; tick others to add them. Then click **Export** in the bar. Each document downloads as its own file, and DocuShark asks first when you've picked several.
- **Import:** in **Documents**, click **Import**, beside **New**. (On a phone, it's **Import a document…** in the menu beside **New**.) The file opens as a new document, files and all.

To work on a document with someone, [sharing it in your workspace](./share#share-a-document) is usually better than sending a file.

## Back up everything {#backup}

**Settings → Backup & Restore** saves everything on this device to one `.docushark-backup` file: your local documents, their images and files, your settings, style profiles, recent colours, shape and icon libraries, and panel layouts. Choose what to include, check the size, and click **Export Backup**. Documents in your workspace are kept there, not in the backup.

To restore, import the backup, see what it holds, and choose to **Merge** it with what's already here or **Replace** everything. Make a backup before you move to a new computer.

## Import {#import}

**Diagrams** from other tools arrive as real, editable shapes and connectors, not as a flat picture:

| From | Files |
|---|---|
| Excalidraw | `.excalidraw` |
| draw.io | `.drawio` |
| Mermaid | `.mmd` and `.mermaid` (flowcharts) |

Choose **Tools → Import diagram…**, drop the file onto the canvas, or paste Mermaid text straight onto it. DocuShark lays out the result and joins the connectors to the shapes' edges, so it lands tidy. If the source uses something DocuShark can't convert yet, such as a Mermaid sequence diagram, the import still finishes and a short report lists what was left out.

Everything else has its own way in:

- **Documents:** `.docushark` files, as [above](#docushark-files).
- **Images and other files:** attach them in your writing or drop them onto the canvas ([Write → Files](./write#files)).
- **Notion pages:** mirror them into a workspace document ([Organize → Pages from Notion](./organize#mirrored-pages)).
- **Text from Word, Google Docs or the web:** paste it ([Write → Copy and paste](./write#copy-and-paste)).
