# Export & Import

DocuShark supports multiple ways to export your diagrams and share your work.

## Export Formats

### PNG (Raster Image)

Best for: Presentations, documents, web pages, quick sharing

**How to export:**

1. Right-click on the canvas or selection → **Export**, or use the export dialog
2. Configure options:
   - **Scale**: 1x, 2x, 3x (higher = better quality)
   - **Background**: Transparent, white, or canvas color
   - **Selection only**: Export just the selected shapes
3. Click **Export** and choose a save location

| Option | Description |
|--------|-------------|
| Scale | Output resolution multiplier |
| Background | Transparency or solid color |
| Padding | Extra space around content |
| Selection | Entire document or selection only |

### SVG (Vector Graphics)

Best for: Scalable graphics, web embedding, editing in other tools

SVG export preserves:
- Vector shapes (infinite scaling without quality loss)
- Text as actual text (searchable, editable)
- Styles and colors
- Group hierarchy

::: tip
SVG is ideal when you need to embed diagrams in websites or edit the output in tools like Inkscape or Illustrator.
:::

### PDF (Documents)

Export your rich text and diagrams together as a polished PDF:

- **Multi-page export** — all rich text pages and canvas diagram pages in order
- Page sizes: A4, Letter, A3, Tabloid (portrait or landscape)
- Configurable margins and page numbers
- Optional **cover page** with logo, title, version, author, date, and description
- Full rich text rendering: headings, formatting, tables, LaTeX math, images, embedded diagram groups, code blocks, task lists, and more

Configure PDF defaults in **Settings → PDF Export**.

### JSON (Native Format)

Best for: Backups, version control, moving between instances

The JSON format contains all shapes, pages, rich text content, and metadata. It's DocuShark's native format.

::: warning
JSON export does **not** include embedded file blobs (PDFs, images, etc.). For a complete export with all files, use the .docushark archive format below.
:::

### .docushark Archive

Best for: Sharing complete documents with all dependencies

The `.docushark` format bundles your document with all referenced blobs (embedded images, PDFs, spreadsheets, icons) into a single file. Nothing is lost.

**Exporting:**
- Right-click in the document browser → **Export as .docushark**
- Or use the export option from the context menu

**Importing:**
- Use the import dialog (same place as JSON import)
- Select the `.docushark` file — a new document is created with all its blobs
- Legacy `.diagrammer` archives (exported by pre-rename builds) are also accepted — the file format is unchanged, only the extension differs.

## Full Application Backup

For transferring your entire DocuShark setup to another machine, or for peace of mind:

### Creating a Backup

Go to **Settings → Backup/Restore**:

1. Choose what to include: documents, blobs, settings, shape libraries, style profiles, color palettes
2. Review the estimated backup size
3. Click **Export Backup**

The backup saves as a `.docushark-backup` archive. Legacy `.diagrammer-backup` files from pre-rename builds are still accepted on restore.

### Restoring from Backup

1. Go to **Settings → Backup/Restore**
2. Click **Import Backup** and select the archive
3. Preview what will be imported
4. Choose to **merge** with existing data or **replace** entirely
5. Resolve any conflicts (duplicate documents or profiles)

::: tip
Create a backup before major changes, OS upgrades, or when moving to a new computer.
:::

## Import

### JSON (DocuShark Documents)

1. Open **Settings → Documents**
2. Click **Import**
3. Select the `.json` file

### .docushark Archives

Same import flow — the file picker accepts both `.json` and `.docushark` files.

### Images

Images can be embedded in the rich text document editor via the image upload button, or dragged onto the canvas as embedded files.

## Quick Reference

| Use Case | Recommended Format |
|----------|-------------------|
| Email attachment | PNG (2x scale) |
| Documentation | SVG or PNG |
| Web embedding | SVG |
| Printing | SVG or PNG (3x) |
| Rich text docs | PDF |
| Sharing with collaborators | .docushark archive |
| Full backup | .docushark-backup |
| Version control (Git) | JSON |
