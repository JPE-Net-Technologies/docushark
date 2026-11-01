---
title: Rich Text & Notes
description: DocuShark's rich text editor — write documentation, headings, lists, code, and tables alongside your diagrams.
---

# Rich Text & Notes

DocuShark includes a powerful rich text editor for adding documentation alongside your diagrams.

## Document Editor Panel

The Document Editor appears on the left side of the canvas and provides a full-featured writing environment.

### Opening the Editor

- Click the **Document** tab in the left panel

### Editor Features

The editor is built on [Tiptap](https://tiptap.dev/) (ProseMirror) and supports rich formatting, tables, math equations, citations, fields, and embedded diagrams.

### Slash Commands

Type `/` at the start of a line to open a quick menu of blocks and actions —
headings, lists, tables, code, math, and more — so you can insert content without
reaching for the toolbar.

## Text Formatting

### Basic Formatting

| Format | Shortcut | Toolbar |
|--------|----------|---------|
| **Bold** | `Ctrl+B` | B button |
| *Italic* | `Ctrl+I` | I button |
| Underline | `Ctrl+U` | U button |
| ~~Strikethrough~~ | — | S̶ button |
| `Inline code` | `Ctrl+E` | `</>` button |
| Subscript | — | Toolbar button |
| Superscript | — | Toolbar button |

### Text Color & Highlighting

Text color, highlight, and table cell background all open the same color
picker you get on the canvas, so a color you use in a diagram is one click
away in your prose.

- **Text color** — the full palette, plus **Default** at the top to drop the
  color and go back to the document's body text (unlike Clear Formatting,
  this leaves bold, italic, and links alone)
- **Highlight** — tints chosen to stay readable behind body text
- **Any color you like** — type a hex value into the field at the bottom of
  the picker. It accepts `#ff6600`, `ff6600`, `#f60`, `rgb(255, 102, 0)`, or
  a name like `crimson`, and stores whichever you type as standard hex
- **Recent colors** — carried across the whole editor, prose and canvas alike

The picker also shows a contrast reading for text and cell backgrounds, so you
can see at a glance whether a pairing will still be readable in an export.

### Text Alignment

Align text using toolbar buttons: left, center, right, or justify. Applies to headings and paragraphs.

### Headings

Create headings with keyboard shortcuts or the level dropdown:

| Level | Shortcut |
|-------|----------|
| Heading 1 | `Ctrl+Alt+1` |
| Heading 2 | `Ctrl+Alt+2` |
| Heading 3 | `Ctrl+Alt+3` |
| Heading 4–6 | Available via dropdown |
| Paragraph | `Ctrl+Alt+0` |

### Lists

- **Bullet list**: `Ctrl+Shift+8` or type `- ` at line start
- **Numbered list**: `Ctrl+Shift+7` or type `1. ` at line start
- **Task list**: Checkable items via the toolbar button

Indent/outdent with `Tab` and `Shift+Tab`.

### Blockquotes

Create quotes with the toolbar button or type `> ` at line start.

> This is a blockquote.
> It can span multiple lines.

## Math Equations (LaTeX)

The editor supports LaTeX math rendering via KaTeX.

### Inline Math

Type `$equation$` to insert an inline equation, or use the **∑** toolbar button.

Example: `$E = mc^2$` renders as an inline equation.

### Block Math

Type `$$equation$$` for a display-mode equation, or use the **∫** toolbar button which opens a multiline editor (press `Ctrl+Enter` to insert).

### Shape Text Math

Prefix any shape label with `=` to render it as LaTeX. For example, a rectangle with label `=\sum_{i=1}^{n} x_i` renders the equation visually.

## Images

Embed images in your documentation:

1. Click the image button in toolbar
2. Upload a file
3. Image is embedded in the document

You can also paste an image: a screenshot or a copied picture is saved into the document where your cursor is.

::: tip
Images are stored as blob references in IndexedDB. They're included when exporting or sharing documents.
:::

Images can be resized using 8 drag handles while maintaining aspect ratio.

## Tables

Create tables for structured data:

### Insert Table

Click **Table** in the toolbar to insert a 3×3 table with header row.

### Table Editing

- **Add row/column**: Right-click → Insert row/column
- **Delete row/column**: Right-click → Delete
- **Merge cells**: Select cells → Right-click → Merge
- **Split cells**: Right-click → Split
- **Toggle headers**: Right-click → Toggle header row/column
- **Cell background**: Put the cursor in a cell, then use the paint bucket on
  the **Table** tab of the toolbar. The picker leads with neutral greys and
  pale tints — the shades you actually want for a header row or zebra
  striping — with the full palette and hex entry below them.

### Table Navigation

- `Tab` — Next cell
- `Shift+Tab` — Previous cell
- Arrow keys — Navigate cells

## Embedded Diagram Groups

Embed snapshots of diagram groups directly in your rich text document:

1. Right-click in the document editor
2. Select **Insert Embedded Group**
3. Choose a group from your diagram
4. The group renders as an image preview in the document

Use the refresh button to update the preview after making changes on the canvas. Embedded groups are also included in PDF exports.

## Callouts, Figures & Galleries

Beyond plain paragraphs, the editor includes richer blocks for documentation:

- **Callouts** — highlighted note/tip/warning boxes to draw attention
- **Figures** — images with captions, so visuals carry their own labels
- **Galleries** — group several images into a compact set
- **Footnotes** — reference notes that collect at the end of the content
- **Code blocks** — syntax-highlighted code in many languages

Insert any of these from the [slash menu](#slash-commands) or the toolbar.

## Citations

Cite sources inline with `@`, paste a DOI to add a reference instantly, and insert
a formatted bibliography that lists only what you've cited. See
**[Citations & References](./citations)** for the full guide.

## Document Fields

Define reusable values and reference them inline as <code v-pre>{{name}}</code> — change a value
once and every reference updates. See **[Document Fields](./document-fields)** for
details.

## Multi-Page Documents

The document editor supports multiple pages:

- **Create pages** via the tab bar
- **Rename pages** by double-clicking the tab
- **Reorder pages** by dragging tabs
- **Color tabs** for visual organization via right-click
- Each page has independent content

## Copy and Paste

### Pasting from Word, Google Docs and the web

Pasted content keeps its structure: headings, bold and italics, links, nested lists and tables. Styling that wouldn't suit your document is left out, such as the source's default black text, so pasted text stays readable in the dark theme. Colours that were chosen on purpose are kept.

Pasted images are saved into your document, so they stay after the original is gone and everyone in a workspace sees them. Two kinds can't be saved, and DocuShark tells you when it happens:

- **Images in a selection copied from desktop Word** can be unreadable to the browser. Add them with **Upload image**.
- **An image from a website that doesn't allow copying** stays linked to that website. Upload it if you want to keep a copy.

### Paste without formatting

Press `Ctrl+Shift+V` (`Cmd+Shift+V` on a Mac), or right-click and choose **Paste without formatting**, to insert the text exactly as it was copied.

### Copy formats

Right-click a selection for **Cut**, **Copy** and **Copy as**:

| Choice | What you get |
|--------|--------------|
| **Copy** | Formatted text, as with `Ctrl+C`. Images come along, so they appear when you paste into Word or an email. |
| **Copy as › Plain text** | The words, with list markers and table rows kept. |
| **Copy as › Markdown** | GitHub-flavoured Markdown: headings, emphasis, lists, tables, code and math. |

::: tip
Some browsers don't let a menu read the clipboard. If **Paste** in the menu doesn't work, paste with the keyboard instead.
:::

## Export Options

Document content is included in exports:

- **JSON**: Full document content preserved
- **PDF**: Rich text with formatting, tables, math, and embedded diagrams
- **PNG/SVG**: Canvas shapes only (document not included)
