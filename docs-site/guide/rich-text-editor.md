# Rich Text & Notes

DocuShark includes a powerful rich text editor for adding documentation alongside your diagrams.

## Document Editor Panel

The Document Editor appears on the left side of the canvas and provides a full-featured writing environment.

### Opening the Editor

- Click the **Document** tab in the left panel

### Editor Features

The editor is built on [Tiptap](https://tiptap.dev/) (ProseMirror) and supports rich formatting, tables, math equations, and embedded diagrams.

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

- **Text color** — Choose from a 20+ color palette via the toolbar
- **Highlight** — 12 highlight colors for emphasis

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
- **Cell background**: Right-click → Set background color

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

## Multi-Page Documents

The document editor supports multiple pages:

- **Create pages** via the tab bar
- **Rename pages** by double-clicking the tab
- **Reorder pages** by dragging tabs
- **Color tabs** for visual organization via right-click
- Each page has independent content

## Export Options

Document content is included in exports:

- **JSON**: Full document content preserved
- **PDF**: Rich text with formatting, tables, math, and embedded diagrams
- **PNG/SVG**: Canvas shapes only (document not included)
