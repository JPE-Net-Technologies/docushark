# Multi-Page Documents

Diagrammer documents can contain multiple pages, letting you organize complex projects into logical sections.

## Creating Pages

Click the **+** button in the page tab bar (in the toolbar area) to create a new page. Each page has its own:

- **Canvas** with independent shapes and layout
- **Rich text content** in the Document Editor
- **Layer order** for shape stacking

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
| **.diagrammer** | Full document archive with all pages and blobs |

## Tips

- **Use pages to tell a story** — order them from overview to detail
- **Color-code your tabs** — it makes navigation faster at a glance
- **One concern per page** — avoid cramming too many diagram types onto one page
