---
title: Multi-Page Documents
description: Organize complex diagrams across multiple pages — add, reorder, and navigate pages in a single document.
---

# Multi-Page Documents

DocuShark documents can contain multiple pages, letting you organize complex projects into logical sections.

## Creating Pages

Click the **+** button in the page tab bar (in the toolbar area) to create a new page. Each page has its own:

- **Canvas** with independent shapes and layout
- **Rich text content** in the Document Editor
- **Layer order** for shape stacking

In a workspace with integrations available, the **+** button on the prose tab
bar opens a small menu instead — **New page** creates a blank page as usual,
and each connected source (for example Notion) offers **New page from …** (see
[Mirrored pages](#mirrored-pages) below).

## Page Tabs

Page tabs appear in the toolbar between the tool buttons and the settings area.

### Switching Pages

Click any tab to switch to that page. The canvas and document editor update to show that page's content.

### Renaming Pages

**Double-click** a page tab to rename it. Give pages descriptive names like "Overview", "Database Schema", "API Flow", etc.

### Reordering Pages

**Drag** page tabs left or right to reorder them. The order is saved with your document.

### Tab Colors

**Right-click** a page tab to set a color. Color-coded tabs help you visually organize sections of your document — for example, blue for architecture, green for database, red for issues.

## Mirrored Pages

A **mirrored page** shows a live copy of a page from a connected source, such
as a Notion page, inside your document. Available on paid workspace plans with
the source connected from your account's Integrations page.

To add one, click **+** on the prose tab bar and choose **New page from
Notion…**, then search for the page you want and pick it. The content —
headings, lists, tables, images — is imported as a read-only page, and the tab
carries the source's icon so you can spot mirrored pages at a glance.

Mirrored pages behave differently from normal pages:

- **Read-only** — the content belongs to the source; edit it there.
- **The name follows the source** — renaming happens on refresh, not locally.
- **Right-click the tab** for the mirror actions: **Open in Notion** jumps to
  the original, **Refresh from source** pulls the latest content, **Ingest
  subpages…** brings the source's subpages in (below), and **Detach** converts
  it into a normal editable page (keeping the content as last synced — this
  can't be undone).

Anything the import can't represent faithfully is reported when the page is
added, so you always know if something was left behind.

### Subpages

When the source page has its own subpages, **Ingest subpages…** (on the tab's
right-click menu) lists them so you can mirror any or all of them — optionally
including nested subpages, a few levels deep. Each one becomes its own mirrored
page, placed directly after its parent so the document reads top-to-bottom in
the same order as the source.

A page with ingested subpages shows a **single tab for the whole group**, with
a count and a chevron. Click the chevron to open the group and jump to any
subpage; the tab shows *Parent › Subpage* while a subpage is active. The
overflow menu (when tabs don't fit) lists grouped pages indented under their
parent, so everything stays reachable.

Subpages are ordinary mirrored pages — refresh, detach, and delete work on
each one individually from the **Navigator** panel (below). Deleting or
detaching a parent never touches its subpages; they simply become top-level
pages.

### The Navigator panel

The **Navigator** is a side panel listing every page in the document — prose
pages (with their subpage structure) and canvas pages — in export order. Turn
it on per layout under **Settings → Appearance → Layout**, or run **Toggle
Navigator panel** from the command palette.

From the Navigator you can:

- **Jump** to any page, including subpages, with one click.
- **Reorder** pages by dragging — a parent drags its whole subpage group.
- **See freshness** — each mirrored page shows how long ago it was synced.
- **Act on any mirrored page** via its row menu: refresh, ingest subpages,
  open the source, detach, or delete.
- **Refresh all** pages from a source with one button.
- **Match structure** — if pages have been moved around, one click reorders
  the document to read depth-first again, subpages under their parents.

## Working with Multiple Pages

### Independent Content

Each page is completely independent. Shapes on one page don't appear on another, and the Document Editor content is per-page. This makes it easy to:

- Separate different diagram types (flowchart on one page, ERD on another)
- Create presentation-style sequences
- Keep overview and detail diagrams in the same document

### Cross-Page Navigation

Use the page tabs for quick switching. If you have many pages, they scroll horizontally in the tab bar.

## Export with Multiple Pages

When exporting:

| Format | Multi-page behavior |
|--------|-------------------|
| **PDF** | All pages exported in order (rich text + canvas diagrams) |
| **PNG / SVG** | Exports the current page only |
| **JSON** | Full document with all pages included |
| **.docushark** | Full document archive with all pages and blobs |

## Tips

- **Use pages to tell a story** — order them from overview to detail
- **Color-code your tabs** — it makes navigation faster at a glance
- **One concern per page** — avoid cramming too many diagram types onto one page
