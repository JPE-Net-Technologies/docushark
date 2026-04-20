# Roadmap

This document tracks Diagrammer's development progress and planned features. For detailed task-level tracking, see `Todo.md` in the repository root.

## Current Status

<!-- DO NOT TOUCH THIS VERSION LINE; IT'S MANAGED BY RELEASE ACTIONS -->

**Version 1.1.0-beta.3** (Icon System & AI Recommendations)

<!-- END OF MANAGED SECTION -->

Diagrammer is feature-rich and nearly stable with the following key features completed:

- ✅ High-performance canvas rendering (10k+ shapes @ 60fps)
- ✅ Real-time collaboration via Protected Local mode (Yjs CRDT over WebSocket)
- ✅ Rich shape libraries (Basic, Flowchart, UML Class, UML Use-Case, ERD Crow's Foot, UML Sequence, UML Activity)
- ✅ User-expandable custom shape libraries
- ✅ Multi-page documents with rich text editor (Tiptap)
- ✅ Desktop app (Tauri v2) and web version
- ✅ Export to PDF, PNG, SVG, JSON, `.diagrammer` archives
- ✅ Offline-first with sync queue and team document caching
- ✅ Command palette, shape search, keyboard shortcut reference
- ✅ Large tech icon libraries (AWS, Azure, GCP, Kubernetes, Docker, databases)
- ✅ Embedded file support (PDF, spreadsheet, image, text) with content viewers
- ✅ Full application backup & restore with selective export
- ✅ Whiteboard overlay for idea tracking (sticky notes)
- ✅ Documentation site (VitePress) with GitHub Pages deployment

## Version History

### Phase 1: Core Foundation
*Project setup and math/rendering primitives*

- Project setup with Bun, TypeScript, React, Zustand
- Math utilities (Vec2, Mat3, Box, geometry) — 204 tests
- Camera system with coordinate transforms — 58 tests
- Input handler with normalized events — 41 tests
- Renderer with DPI scaling and grid — 33 tests
- React integration (CanvasContainer, App)

### Phase 2: Shape System
*Data-driven shapes with registry pattern*

- Shape types and ShapeRegistry pattern
- Rectangle, Ellipse, Line, Text shape handlers
- Shape utilities (bounds, transforms) — 55 tests
- DocumentStore with Immer — 37 tests
- SessionStore for UI state — 37 tests
- SpatialIndex (RBush) and HitTester — 48 tests

### Phase 3: Tools
*State-machine tool architecture*

- Tool architecture with BaseTool and ToolContext
- ToolManager for tool registration and switching
- PanTool, SelectTool, RectangleTool, EllipseTool, LineTool, TextTool
- Selection with resize/rotation handles
- Marquee selection

### Phase 4: Basic UI
*Toolbar and property editing*

- Toolbar with tool buttons and shortcuts
- PropertyPanel for shape properties
- Color palette for quick color selection
- Resizable PropertyPanel

### Phase 5: Extended Features
*History, copy/paste, connectors, dark mode*

- History system (undo/redo) — 14 tests
- Keyboard shortcuts (Ctrl+Z, Ctrl+C/V, Delete, etc.)
- Copy/paste with cascading offset
- Connectors (shapes that attach to other shapes)
- Inline text labels for Rectangle and Ellipse with text wrapping
- Dark mode with system detection
- Immersive controls (WASD/Arrow pan, Q/E zoom)

### Phase 6: Core Improvements
*Text editing, alignment, layers, styles, grouping, export*

- Text inline editing (double-click) with dark mode support
- Smart snapping to grid with visual guides
- Smart alignment guides (center, edge snapping)
- Alignment tools (align left/center/right/top/middle/bottom, distribute)
- Layer panel with z-order management (drag reorder, lock, show/hide)
- Style profiles for reusable shape styles (5 built-in defaults, custom profiles)
- Group/ungroup shapes (Ctrl+G / Ctrl+Shift+G)
- Export to PNG (multi-DPI, transparent background) and SVG
- Context menu with shape-specific actions and keyboard shortcut display

### Phase 7: Multi-Page & Persistence
*Offline-first document management*

- Multi-page documents
- Offline-first with localStorage persistence
- Auto-save functionality
- Export/import document JSON

### Phase 8: Rich Documentation
*Tiptap-powered document editor*

- RTF document editor (headings, bold, italic, lists, code blocks, tables)
- Embedded images and diagrams
- Markdown import/export
- Document outline/table of contents

### Phase 9: UI Improvements
*Color palette, property panel, toolbar, status bar*

- Enhanced color palette (recent colors, custom hex input, native picker)
- Property panel redesign (collapsible sections, compact styling)
- Unified toolbar (Notion/Linear style, ~44px, inline page tabs)
- Status bar (coordinates, zoom controls, shape count, current tool)

### Phase 9.5: IndexedDB Storage
*Content-addressed blob storage*

- BlobStorage with SHA-256 hashing and automatic deduplication
- Reference counting for safe garbage collection
- BlobGarbageCollector for orphaned blob cleanup
- Tiptap image extension with blob:// URLs
- ImageUploadButton with automatic validation and resizing
- Storage Manager UI
- Pluggable BlobStorageBackend interface

### Phase 10: Advanced Diagramming
*Connectors, icons, routing*

- Connector labels (text, font, color, position along path)
- Smart connectors with orthogonal routing (L/Z-shaped Manhattan paths, waypoints)
- Custom icon library with IndexedDB storage (30+ built-in SVG icons)
- Shape icons for Rectangle and Ellipse (cached HTMLImageElement rendering)

### Phase 10.5: Shape Libraries
*Metadata-driven extensible shape system*

- Metadata-driven shape system for PropertyPanel extensibility
- Flowchart shapes (Diamond, Terminator, Data, Document, Predefined Process, Manual Input, Preparation, Connector, Off-Page Connector)
- ShapePicker UI component for shape library selection

### Phase 10.6: UML Use-Case Diagrams
- Actor (stick figure), Use Case, System Boundary shapes
- Include/Extend relationship indicators
- Dark mode rendering for ShapePicker canvas previews

### Phase 10.7: User-Expandable Shape Libraries
*Settings modal and custom shape management*

- Tab-based Settings modal infrastructure
- Save and re-use shapes into runtime shape libraries
- Create, rename, export/import libraries as JSON
- SaveToLibraryDialog via context menu
- CustomShapeTool for click-to-place behavior
- Draggable layer reordering through groups and nested groups
- Group layer-order visibility fixes

### Phase 11: Advanced Shape Toolsets
*Property panel, context menus, layers, settings, group styles*

- **11.1 — Property Panel Overhaul**: Icon picker z-order fix (React Portal), modern styling, plugin extensibility (PanelExtensions registry), label customizations (background, offset)
- **11.2 — Context Menu Upgrades**: Submenu on hover, connector routing entry, lock submenu (position/size/all)
- **11.3 — Layer Panel Upgrades**: Group/layer colors with inheritance, rename layers, layer views (regex filtering, manual additions), compact label preview
- **11.4 — Common Settings**: Default connector type, default style profile, show/hide static properties, hide default profiles, theme preference, Storage Manager in settings, Documents tab in settings, "Rebuild" button for connector routes, GC icon protection, style profile icon/label saving
- **11.5 — Advanced Group Styles**: Background color and patterns (solid, stripes, hazard, gradients), labels with 9-grid position picker and offset, border styling (color, width, radius, dash patterns), shadows and glow effects, two-pass group rendering

### Phase 12: Advanced Export
*PDF export with full rich text rendering*

- Customizable PDF export (DPI, page size, margins, page numbers, cover page with logo)
- Multi-page PDF (all rich text + all canvas diagram pages)
- Full rich text rendering (colors, highlights, inline code, sub/superscript, alignment, task lists, tables with colspan/rowspan, LaTeX math via KaTeX → PNG)
- PDFNodeRendererRegistry — extensible registry pattern for Tiptap extensions
- CSS color parsing for rgb(), rgba(), named colors

### Phase 12.2: Embeddable Diagram Groups
- Custom Tiptap node extension for embedding canvas groups in documents
- React component for group preview rendering
- Context menu integration and PDF export support

### Phase 13: Diagram Patterns
*ERD and UML class diagrams*

- ERD Shape Library (Crow's Foot): Entity, Weak Entity, Relationship, Attribute, Key Attribute, cardinality indicators (10 shapes)
- UML Class Diagram Library: Class (3-compartment), Interface, Abstract Class, Enum, Package, Note, relationship indicators (12 shapes)
- Add/Remove shapes from groups via context menu (with cycle detection)

### Phase 14: Collaboration
*Real-time multi-user editing with Tauri desktop*

- **14.Pre — Tauri Migration**: Tauri v2 project setup, Rust backend scaffolding (Axum + Tokio WebSocket), IPC bridge, file system access, pluggable StorageBackend interface
- **14.0 — Collaboration Infrastructure**: Yjs CRDT integration, SyncProvider with auto-reconnect, presence indicators, collaborative cursors
- **14.1.1 — Unified Connection Layer**: connectionStore, UnifiedSyncProvider (single WebSocket for CRDT + document ops + auth), protocol message routing helpers
- **14.1.2 — Document Registry**: Unified document state (local/remote/cached) with discriminated union types, filter capabilities, persistence middleware
- **14.1.3 — Offline-First Sync Queue**: OfflineQueue with last-write-wins deduplication, SyncQueueStorage (IndexedDB persistence), SyncStateManager coordinating queue + storage + connection
- **14.1.4 — Presence System Overhaul**: Dedicated presenceStore, stale cursor detection, SelectionHighlight component for remote user selections
- **14.1.5 — Access Control**: permissions.rs, permission middleware, permission error codes
- **14.1.6 — UI Consolidation**: DocumentBrowser, DocumentCard, SyncStatusBadge components
- **14.2 — UX Improvements** (5 chunks): Canvas focus styling, minimap, settings overhaul, document management, cached team document UI, smart alignment for resize, layer snap-to button, saving animation, style profile search, arrow key translate, layer view regex tester, authentication onboarding page
- **14.2.5 — Protocol & Backend Testing**: 47 protocol tests, 42 UnifiedSyncProvider tests
- **14.3 — Rich Text Editor Upgrades**: Tiptap tables (insert, resize columns), LaTeX equations (inline `$...$`, block `$$...$$`, shape text `=` prefix), image resize handles, H1-H6 headings, interactive task lists, table style controls, text formatting (underline, strikethrough, subscript, superscript), text/highlight color pickers, search & replace (regex support), block quotes, text alignment, cell background colors, enhanced context menu (format/heading/list/table submenus), multi-page rich text tabs with drag reorder
- **14.3.3 — Fixes**: Tab color persistence, ERD entity attribute padding, style profiles for all shape types, icon/image transfer over host connection (AssetBundler)

### Phase 14.9: AI Insights Improvements
*Stability and resilience recommendations*

Completed items:
- Centralized error notification system (toast/notification for user-facing errors)
- Exponential backoff for WebSocket reconnection (1s → 2s → 4s → 8s → max 30s with jitter)
- Storage quota monitoring and prevention (proactive warnings)
- Collaboration layer test coverage (24 SyncStateManager + 35 OfflineQueue + 29 collaborationStore + 59 protocol tests)
- Atomic file system operations (write-to-temp-then-rename via AtomicFileWriter)
- Document transfer atomicity (two-phase commit with crash recovery — 24 tests)
- Document import validation (schema validation for imported documents)
- Soft delete and document recovery (trash/recycle bin with configurable retention)
- Anchor validation and error recovery (warning indicators for disconnected connectors)
- Group nesting cycle detection
- Typed anchor positions (enum/const type for valid positions)
- Unknown shape type fallback rendering (placeholder box with type label)
- Canvas resource cleanup on export errors
- Document version tracking (serverVersion, VersionConflict utilities — 23 tests)
- Offline team document access (TeamDocumentCache with LRU eviction — 17 tests)
- Cache invalidation strategy (DocumentCacheManager with TTL — 37 tests)
- Request deduplication and debouncing
- Token expiration handling (proactive refresh, operation queueing)
- Message size validation (bounds checking, configurable thresholds)
- WebSocket subscription cleanup (audit all event listeners on disconnect)

### Phase 15: Version 1.0
*Documentation, deployment, and CI/CD*

- **15.1 — Documentation Site**: VitePress site in `/docs-site/`, custom dark theme, content structure, GitHub Pages deployment via GitHub Actions, local help integration (F1 shortcut, Tauri bundled docs)
- **15.2 — Release Build**: `.github/workflows/release.yml` with manual dispatch, semver validation, test gates, auto version bumping, cross-platform Tauri builds (Linux `.deb`/`.AppImage`, Windows `.exe`/`.msi`), git tags and GitHub Releases
- **15.3 — Release Pipeline**: Finalized UI polish, documentation, and release notes for v1.0.0-beta.1

### Phase 16: Engine Improvements [v1.0.1-beta.1]
*Post-release performance and reliability*

Completed items:
- Blob garbage collector performance (incremental GC with reference counting, progress indicator)
- Document version tracking UI (conflict resolution: merge/overwrite/reload, "document changed externally" notification)
- Group-aware selection export (partial group selections, flatten groups option)
- Release artifact checksums (SHA-256 for all release binaries)
- Tool state machine tests (ToolManager lifecycle, rapid switches, edge cases)
- Export functionality tests (PNG/SVG with various shapes, missing handler degradation)

### Phase 16.5: AI Recommendations [v1.1.0-beta.1]
*Claude Opus improvement recommendations*

Completed items:
- Lazy loading for shape libraries (dynamic imports with loading states)
- Spatial index incremental updates (per-shape insert/remove/update instead of full rebuild)
- Quick action palette (Cmd/Ctrl+K) with fuzzy search
- Keyboard shortcut reference panel (accessible via `?` key)
- Shape search in canvas (Ctrl+F, highlight matches, next/previous navigation)
- Zoom to fit selection and zoom to fit all (animated transitions)
- Smooth pan/zoom animations (easing, requestAnimationFrame interpolation)
- Multi-select property editing ("Mixed" values, apply to all selected)
- Drag-and-drop shape creation (ghost preview during drag)
- Touch/tablet gesture refinements (pinch zoom, three-finger pan)
- React error boundaries for crash recovery (PropertyPanel, LayerPanel, DocumentEditor)
- Graceful WebSocket reconnection feedback (UI indicators, queue display, manual retry)
- Debug overlay improvements (spatial index bounds, hit test regions, shape inspector — Ctrl+Shift+D)
- Shape handler development template (CLI scaffolding with TypeScript stubs, auto-register)
- Plugin development documentation
- Full-screen rich-text editor (stretches over canvas/property panel, comfortable margins)
- Duplicate page functionality
- Shape locking visual indicator (lock icon overlay, position-locked vs fully-locked)
- Undo/redo improvements (action descriptions in tooltip, Ctrl+Y redo shortcut)

### Phase 16.6: Icon System Improvements [v1.1.0-beta.2]
*Icon styles, placement modes, and large tech icon libraries*

- Icon style saving to style profiles fix (⚠️ known regression: applying profiles may clear icons — see [#5](https://github.com/QR-Madness/diagrammer/issues/5))
- Icon placement modes (badge overlay, centered, icon-only, configurable background shape/color/padding)
- Icon badge backgrounds (solid color, border/outline, opacity control)
- Large tech icon library with lazy loading (AWS, Azure, GCP, Kubernetes, Docker, programming languages, databases)
- Icon library loading optimization (on-demand categories, cross-category search, LRU cache, loading skeletons)

### Phase 16.7: Application Backup & Recovery [v1.1.0-beta.2]
*Full application backup and restore*

- Full application backup export (documents, blobs, settings, libraries as ZIP archive)
- Backup import/restore (merge or replace, conflict resolution)
- Selective backup options (per-document with dependencies)
- Backup UI in Settings (timestamp, size estimation, restore preview)
- Shared `ArchiveUtils` infrastructure (ZIP, checksums, blob collection)

### Phase 16.8: Document Archive Export [v1.1.0-beta.2]
*Per-document archive export*

- Document archive service (`DocumentArchiveService.exportDocument` / `importDocument`)
- `.diagrammer` archive format (single document + referenced blobs as ZIP)
- UI integration: "Export as .diagrammer" in document browser and context menu
- Reuses `ArchiveUtils` infrastructure from Phase 16.7

### Phase 17: Embedded Files [v1.2.0-beta.1]
*File embedding for PDFs, spreadsheets, and assets*

- FileShape type with reference-based blob storage and lazy loading tiers
- File shape handlers (PDF, Spreadsheet, Generic) with thumbnail generation via Web Worker
- FileViewerModal with PDF viewer (pdf.js) and spreadsheet viewer (SheetJS)
- File import flow (drag-and-drop, file picker, validation)
- Files tab in Storage Manager (reference tracking, orphan detection)
- Collaboration support (HTTP blob endpoints for large files, blob sync protocol)
- File replacement, error handling, and memory management (LRU cache)

### Phase 18: Advanced Diagram Patterns [v1.3.0-beta.1]
*Sequence diagrams, activity diagrams, and whiteboard*

- **18.1 — Sequence Diagrams**: Lifeline (6 head types: object, actor, component, interface, database, queue), Activation (nesting, recursion), Fragment (loop, alt, opt, par, break, critical, strict, seq with operand dividers), Actor (person, system, external), Destruction marker, State Invariant, Time Constraint, Coregion, Continuation shapes, UML Sequence connector markers (sync, async, reply, create, destroy, lost, found) — 57 tests
- **18.2 — Activity Diagrams + Swimlanes**: Action (call behavior/operation, pre/post conditions), Initial/Final/Flow-Final nodes, Fork/Join Bar (join spec), Send/Receive Signal, Decision/Merge nodes, Accept Event, Accept Time Event, Object Node (FIFO/LIFO/ordered/unordered), Data Store, Central Buffer, Input/Output Pin, Expansion Region (parallel/iterative/stream), Interruptible Region, Activity Parameter Node, Swimlane (horizontal/vertical, custom lane widths/colors, partition types) — 71 tests
- **18.2.1 — Connector Enhancements**: Guard condition labels with configurable position, object flow (dashed) vs control flow (solid), message numbering for sequence diagrams, self-message routing (loop to right of lifeline) — 36 tests
- **18.3 — Whiteboard (Sticky Notes)**: Document-global whiteboard overlay (Ctrl+I), draggable/resizable sticky notes with customizable colors (12 presets + recent), contentEditable formatting (bold, italic), whiteboard persistence in document, export handling (excluded by default), toolbar button — 19 tests

## Planned Features

These features are under consideration for future versions:

### Phase 16.9: Deferred Improvements

#### Connector & Shape Improvements
- [ ] Lazy connector route rebuilding (incremental updates for affected connectors only)

#### Error Handling & Resilience
- [ ] Sync operation rollback mechanism (SelectTool multi-step operation revert)

#### Testing Coverage
- [ ] Store layer test coverage (documentStore, teamDocumentStore, persistenceStore)
- [ ] Edge case test scenarios (connection loss during sync, queue overflow, concurrent edits)

#### Developer Tooling
- [ ] Integration test harness (multi-client collaborative workflow tests, CI job)

#### Performance
- [ ] Dirty region tracking for canvas rendering
- [ ] Shape render caching with OffscreenCanvas
- [ ] Virtual scrolling for LayerPanel

#### Stability
- [ ] Performance regression benchmarks
- [ ] Accessibility audit and improvements

#### Quality of Life
- [ ] Template gallery (Flowchart, Org Chart, ERD, Network Diagram, Wireframe starters)

## Future Considerations

These features are under consideration for future versions:

- **Auto-Update**: Scan GitHub for new versions, automatic updates
- **Publisher Module**: Export presets, batch export, cloud export support
- **Cloud Storage**: Sync documents across devices via cloud providers
- **Advanced Themes**: Custom theme creation, theme marketplace
- **Git Integration**: Version control for diagrams, link shapes to code, VS Code integration
- **AI Features**: AI-powered diagram analysis, suggested edits/layouts, text-to-diagram generation

## Known Issues

- **Icon style profile regression**: Applying a style profile may clear/remove icons from shapes. See [GitHub Issue #5](https://github.com/QR-Madness/diagrammer/issues/5).
- **PDF Export encoding artifacts**: `þÿ` (UTF-16 BOM) appears in exports with Unicode characters outside WinAnsiEncoding. Fix requires embedding a Unicode-capable TrueType font. See [GitHub Issue #4](https://github.com/QR-Madness/diagrammer/issues/4).
- **Minimap**: Experimental feature with known navigation and rendering bugs. Marked as experimental in settings.
- **Sync operation rollback**: SelectTool has unimplemented rollback for failed multi-step operations.

## Contributing

We welcome contributions! See the [GitHub repository](https://github.com/QR-Madness/diagrammer) for:

- Issue tracker
- Contributing guidelines
- Development setup

::: tip
Found a bug or have a feature request? Open an issue on GitHub!
:::
