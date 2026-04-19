# Embedded Files

Diagrammer lets you embed files — PDFs, spreadsheets, images, and more — directly onto your canvas. Files appear as shape cards with thumbnail previews, and you can open them in built-in viewers.

## Adding Files

There are three ways to embed files:

### Drag and Drop

The simplest method — just drag files from your file manager onto the canvas. Diagrammer creates file shapes at the drop location.

When dropping multiple files, they automatically arrange in a 3-column grid.

### Toolbar Button

Click the **paperclip icon** in the toolbar to open a file picker. Select one or more files to embed them on the canvas.

### Context Menu

Right-click on an empty area of the canvas and choose **Embed file...** to open the file picker.

### Keyboard Shortcut

Press `Ctrl+Shift+F` to quickly open the file embed dialog.

## Supported File Types

| Category | File Types | Viewer |
|----------|-----------|--------|
| **PDF** | `.pdf` | Page navigation, zoom, fit-to-width/page |
| **Spreadsheet** | `.xlsx`, `.csv` | Table view with sheet tabs, virtual scrolling |
| **Image** | `.png`, `.jpg`, `.gif`, `.svg`, etc. | Full-resolution display with zoom and pan |
| **Text** | `.txt`, `.md`, `.log`, etc. | Monospace view with line numbers |
| **Other** | Any file type | File info display (no preview) |

## Viewing Files

**Double-click** a file shape on the canvas to open it in the built-in viewer.

The viewer opens as a full-screen modal with:
- File-type-specific rendering (PDF pages, spreadsheet tables, images, etc.)
- **Download** button to save the file locally
- **Close** button or press `Escape` to return to the canvas

### PDF Viewer

- Navigate pages with prev/next buttons or type a page number
- Zoom: fit-width, fit-page, or manual zoom (±25%)

### Spreadsheet Viewer

- Switch between sheets using tabs at the bottom
- Virtual scrolling handles large datasets smoothly
- Works with multi-sheet `.xlsx` workbooks

## File Shapes on the Canvas

Embedded files appear as rectangular cards showing:

- A **thumbnail preview** (auto-generated for images and PDFs)
- The **file name** and **file icon**
- **File size** indicator

You can move, resize, and style file shapes just like any other shape.

## Managing Files

### Replacing a File

To replace a file's content while keeping its position and size on the canvas:

- Right-click the file shape → **Replace File**, or
- Use the **Replace** button in the Property Panel or File Viewer

### Storage Manager

View all embedded files in **Settings → Storage**:

- See file names, types, sizes, and reference counts
- Preview thumbnails
- Check which documents reference each file
- Detect and clean up orphaned files (files with no shape references)

## Limits

- **Maximum file size**: 50 MB per file
- **Zero-byte files** are rejected
- Files are stored in IndexedDB as content-addressed blobs (deduplicated by SHA-256 hash)

## Collaboration

When collaborating, embedded files sync between users:

- File shape metadata syncs via WebSocket (instant)
- File content syncs via HTTP blob endpoints (background transfer)
- A progress indicator appears in the status bar during file sync
- Missing files are fetched automatically when you join a session

## Tips

- **Use thumbnails for context** — even without opening the file, the thumbnail gives visual context in your diagram
- **Link documents to diagrams** — embed the spec PDF next to its architecture diagram
- **Spreadsheets for data** — embed data tables directly instead of recreating them as shapes
