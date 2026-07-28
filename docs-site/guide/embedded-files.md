---
title: Embedded Files
description: Embed PDFs, spreadsheets, images, and other files onto your DocuShark canvas as shape cards with previews.
---

# Embedded Files

DocuShark lets you embed files — PDFs, spreadsheets, images, and more — directly onto your canvas. Files appear as shape cards with thumbnail previews, and you can open them in built-in viewers.

## Adding Files

There are three ways to embed files:

### Drag and Drop

The simplest method — just drag files from your file manager onto the canvas. DocuShark creates file shapes at the drop location.

When dropping multiple files, they automatically arrange in a 3-column grid.

### Toolbar Button

Click the **paperclip icon** in the toolbar to open a file picker. Select one or more files to embed them on the canvas.

### Context Menu

Right-click on an empty area of the canvas and choose **Embed file...** to open the file picker.

## Supported File Types

| Category | File Types | Viewer |
|----------|-----------|--------|
| **PDF** | `.pdf` | Continuous scrolling reader with text selection, search, outline, bookmarks, and immersive mode |
| **Spreadsheet** | `.xlsx`, `.csv` | Table view with sheet tabs, virtual scrolling |
| **Image** | `.png`, `.jpg`, `.gif`, `.svg`, etc. | Full-resolution display with zoom and pan |
| **Audio** | `.mp3`, `.wav`, `.ogg`, `.flac`, etc. | Built-in player (playable formats depend on your system) |
| **Video** | `.mp4`, `.webm`, `.mov`, etc. | Built-in player (playable formats depend on your system) |
| **Text** | `.txt`, `.md`, `.log`, etc. | Monospace view with line numbers |
| **Other** | Any file type | File info display (no preview) |

## Viewing Files

**Double-click** a file shape on the canvas to open it in the built-in viewer.

The viewer opens as a full-screen modal with:
- File-type-specific rendering (PDF pages, spreadsheet tables, images, media players, etc.)
- **File info** — size, type, page count, and the file's content checksum
- **Download** button to save the file locally
- **Close** button or press `Escape` to return to the canvas

### Floating Viewer

On desktop-sized screens, click the **pop-out** button in the viewer header to
detach it into a floating panel — drag it by its header, resize it from the
right and bottom edges, and keep reading a PDF while you edit the document
beside it. The panel remembers its position and size; the **dock** button (or
opening the viewer on a small screen) returns it to the full-screen modal.

### PDF Viewer

The PDF viewer is a full reading experience:

- **Continuous scrolling** — pages flow vertically; scroll naturally or jump by typing a page number
- **Text selection** — select and copy text straight from the page
- **Find in document** — press `Ctrl+F` (or use the search button) to search, with match counts and highlight-all
- **Outline sidebar** — documents with a built-in table of contents get a clickable outline for jumping between sections
- **Zoom** — fit-width, fit-page, stepped zoom buttons, or `Ctrl` + mouse wheel
- **Immersive reading** — expand to a distraction-free full-screen view; a floating strip keeps page navigation at hand, and `Escape` returns to the normal viewer
- **Dim pages** — in dark mode, soften bright pages for comfortable reading
- **Bookmarks + reading position** — press `b` (or use the bookmark button) to mark pages; the Bookmarks sidebar tab lists, renames, and jumps to them. The viewer reopens on the page you left, with your zoom mode — per person, on this device; nothing is written into the shared document
- **Cite** — add the PDF to the document's [reference library](./citations.md) from its DOI
- **Send page to canvas** — render the current page as a high-resolution image on the canvas, ready to annotate

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
- A progress notification appears while files upload or download, and completes when the sync finishes
- Missing files are fetched automatically when you join a session
- Downloaded file content is checksum-verified before it's stored — a corrupted transfer is rejected with a notification and can be retried

## Tips

- **Use thumbnails for context** — even without opening the file, the thumbnail gives visual context in your diagram
- **Link documents to diagrams** — embed the spec PDF next to its architecture diagram
- **Spreadsheets for data** — embed data tables directly instead of recreating them as shapes
