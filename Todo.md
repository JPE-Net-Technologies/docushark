# Development Todo List

<!--
!! IMPORTANT !!
  This document is tightly coupled with `roadmap.md` in the documentation site. Be sure to also update that tracker as you complete phases.
  Completed phases are recorded in docs-site/developer/roadmap.md — only active/future work lives here.
-->

---

## ⚠️ CRITICAL: Backwards Compatibility & Document Safety

**Since v1.0.0-beta.1 is released, all changes MUST be backwards-compatible.**

### Document Safety Requirements
- **Document format changes**: Must include migration code that automatically upgrades older documents
- **Never break existing documents**: Users rely on this tool for critical documentation
- **Test with real documents**: Before merging changes that touch persistence, document loading, or shape data
- **Serialization changes**: Add new fields as optional with sensible defaults; never remove or rename existing fields without migration

### Backwards Compatibility Rules
- **Store changes**: New fields must be optional or have defaults; never break existing localStorage/IndexedDB data
- **Protocol changes**: Maintain compatibility with existing clients; version the protocol if breaking changes are necessary
- **Shape registry**: New shape types are fine; changes to existing shape handlers must preserve rendering of old documents
- **Export formats**: JSON export must remain readable by older versions where possible

### When Breaking Changes Are Unavoidable
1. Implement automatic migration in the loading code
2. Add version field to track document format version
3. Test migration with documents from previous releases
4. Document the migration in release notes

---

## Completed Phases

Phases 1–16.6 are complete. See [roadmap.md](docs-site/developer/roadmap.md) for full version history.

---

## Implementation Phase Tracker
### Phase 16.7: Application Backup & Recovery [v1.1.0‑beta.2] ✅

Comprehensive backup system for transferring and recovering all application data.

#### Backup System

- [x] **Full application backup export**
  - Export all local documents as a single archive (.diagrammer-backup or .zip).
  - Include all blob storage (images, icons, embedded files).
  - Include style profiles, color palettes, and custom shape libraries.
  - Include application settings and preferences.
  - Progress indicator for large backups.

- [x] **Backup import/restore**
  - Import backup archive and restore all data.
  - Option to merge with existing data or replace entirely.
  - Conflict resolution UI for duplicate documents/profiles.
  - Validation of backup integrity before restore.

- [x] **Selective backup options**
  - Choose which data to include: documents, blobs, settings, libraries.
  - Per-document export with dependencies (all referenced blobs included).
  - Export selected documents only.

- [x] **Backup UI in Settings**
  - Backup/Restore tab in Settings modal.
  - Last backup timestamp display.
  - Backup size estimation before export.
  - Restore preview showing what will be imported.

### Phase 16.8: Document Archive Export [v1.1.0‑beta.2]

Per-document archive export (`.diagrammer` files) for sharing individual diagrams with all dependencies. Builds on the shared `ArchiveUtils` infrastructure from Phase 16.7.

- [ ] **Document archive service**
  - `DocumentArchiveService.exportDocument(docId)` — bundles one document + referenced blobs into a `.diagrammer` archive.
  - `DocumentArchiveService.importDocument(file)` — imports a `.diagrammer` file, creating a new local document with all blobs.
  - Reuses `ArchiveUtils` (ZIP, checksums, blob collection) — no new archive infrastructure needed.
  - Manifest `type: 'diagrammer-document-archive'` distinguishes from full backups.

- [ ] **UI integration**
  - "Export as .diagrammer" option in document browser and context menu.
  - "Import .diagrammer" alongside existing JSON import.
  - Replaces/augments current JSON-only export (which loses blob data).

### Phase 17: Embedded Files [RELEASE v1.2.0‑beta.1]

File embedding system for PDFs, spreadsheets, and other assets. Uses reference-based architecture with lazy loading to maintain canvas performance.

#### Architecture Decisions

- **Modal viewer pattern**: Content viewed in modal, not in-place rendered on canvas (preserves 60fps target)
- **Thumbnail on canvas**: Cached preview thumbnail + file icon/name displayed as shape
- **Reference-based storage**: Shapes hold `blobRef` (SHA-256 hash), actual files in BlobStorage
- **Lazy loading tiers**: Off-screen (nothing) → On-screen (thumbnail) → Modal open (full content)
- **Separate blob sync**: HTTP endpoints for large files, WebSocket for shape metadata only

#### Phase 17.1: Core Infrastructure

- [ ] **FileShape type definition** (`src/types/FileShape.ts`)
  - Extends BaseShape with: `blobRef`, `fileName`, `mimeType`, `fileSize`
  - Preview metadata: `thumbnail` (base64), `pageCount`, `dimensions`
  - Supported categories: `pdf`, `spreadsheet`, `generic`

- [ ] **File shape handlers** (`src/shapes/files/`)
  - `BaseFileHandler.ts` — Common: bounds, selection, download action
  - `PdfHandler.ts` — PDF icon, page count badge, thumbnail render
  - `SpreadsheetHandler.ts` — Table icon, row/column count badge
  - `GenericFileHandler.ts` — File type icon + filename fallback
  - Register all handlers in ShapeRegistry

- [ ] **Thumbnail generation service** (`src/services/ThumbnailGenerator.ts`)
  - Web Worker for non-blocking generation
  - PDF: Render page 1 at ~400px width via pdf.js → JPEG blob
  - XLSX/CSV: Generate mini-table preview or use generic icon
  - Store thumbnail in shape's `preview.thumbnail` field

#### Phase 17.2: Content Viewer Modal

- [ ] **FileViewerModal component** (`src/ui/FileViewerModal.tsx`)
  - Full-screen modal with close button, download, replace actions
  - File type detection and appropriate viewer dispatch

- [ ] **PDF viewer** (`src/ui/viewers/PdfViewer.tsx`)
  - pdf.js integration for rendering
  - Page navigation (prev/next, page number input)
  - Zoom controls
  - Lazy page loading (render visible pages only)
  - BONUS: Cache the viewer's position in the document upon close

- [ ] **Spreadsheet viewer** (`src/ui/viewers/SpreadsheetViewer.tsx`)
  - SheetJS (xlsx) for parsing XLSX/CSV
  - Table rendering with virtual scrolling for large datasets
  - Sheet tabs for multi-sheet workbooks
  - Basic cell formatting preservation

- [ ] **Generic file viewer** (`src/ui/viewers/GenericFileViewer.tsx`)
  - File icon, name, size, type display
  - Download button
  - "No preview available" message

#### Phase 17.3: File Import Flow

- [ ] **File drop/upload handling**
  - Drag-and-drop files onto canvas
  - File picker via toolbar or context menu
  - Validate file types and size limits

- [ ] **Import pipeline**
  - Store file in BlobStorage (content-addressed)
  - Generate thumbnail (async, Web Worker)
  - Create FileShape at drop position
  - Update spatial index

#### Phase 17.4: Storage Manager Integration

- [ ] **Files tab in Storage Manager**
  - List all embedded files with: name, type, size, reference count
  - Preview thumbnails where available
  - Show which documents reference each file
  - Orphan detection (files with no shape references)
  - Delete/replace individual files

- [ ] **Storage references checker extension**
  - Update `BlobGarbageCollector` to scan FileShape `blobRef` fields
  - Protect files referenced by any document
  - Handle thumbnail blobs if stored separately

#### Phase 17.5: Collaboration Support

- [ ] **HTTP blob endpoints** (Rust backend)
  - `POST /api/blobs/:hash` — Upload blob with hash verification
  - `GET /api/blobs/:hash` — Download blob by hash
  - `HEAD /api/blobs/:hash` — Check blob existence
  - Chunked upload/download for large files (>10MB)
  - Authentication via JWT token header

- [ ] **Blob sync protocol**
  - On shape sync, client checks if blob exists locally
  - If missing, fetch via HTTP endpoint
  - Progress indicator for large file downloads
  - Retry logic with exponential backoff

- [ ] **AssetBundler extension**
  - Update `bundleDocumentWithAssets()` to include file blobs
  - Handle large files (consider compression or external references)

#### Phase 17.6: Polish & Edge Cases

- [ ] **File replacement flow**
  - Replace file contents while keeping shape position/size
  - Regenerate thumbnail
  - Update all references atomically

- [ ] **Error handling**
  - Corrupt file detection on import
  - Missing blob recovery (prompt to re-upload)
  - Unsupported file type graceful fallback

- [ ] **Memory management**
  - Unload full PDF/spreadsheet content when modal closes
  - LRU cache for recently viewed file content
  - Thumbnail-only mode for low-memory situations

### Phase 18: Advanced Diagram Patterns [RELEASE v1.3.0‑beta.1]

- [ ] Sequence diagram patterns
- [ ] Activity diagram patterns + Swimlane customization

#### Phase 18.1: Sticky Notes

- [ ] **StickyNote shape type** (`src/shapes/StickyNote.ts`)
  - Postit-like appearance with folded corner effect
  - Configurable background color (default yellow palette: yellow, pink, blue, green, orange)
  - Rich text content support (bold, italic, bullet lists)
  - Auto-resize based on content or fixed size with overflow handling
  - Drop shadow for "lifted paper" effect

- [ ] **Anchor modes**
  - **Canvas mode** (default): Note exists in world space, moves with pan/zoom like other shapes
  - **Screen mode**: Note anchored to viewport corner (top-left, top-right, bottom-left, bottom-right)
  - Screen-anchored notes persist across pages and zoom levels
  - Toggle anchor mode via context menu or PropertyPanel

- [ ] **StickyNoteTool** (`src/tools/StickyNoteTool.ts`)
  - Click-to-place with default size
  - Drag-to-size for custom dimensions
  - Immediate inline editing on creation

- [ ] **PropertyPanel integration**
  - Color picker with sticky note palette
  - Anchor mode toggle (canvas/screen + corner selector for screen mode)
  - Font size and alignment controls
  - Transparency/opacity slider

- [ ] **Screen-anchored note rendering**
  - Render after main canvas in screen space (not affected by camera transform)
  - Maintain position relative to viewport on resize
  - Z-order always above canvas content
  - Draggable within viewport bounds

- [ ] **Persistence**
  - Canvas notes: stored in document like other shapes
  - Screen notes: stored in document metadata with viewport-relative positions
  - Export: include canvas notes in PNG/SVG; exclude or optionally include screen notes

### Phase 18.9: Performance & Polish

Improvements deferred from earlier phases for incremental completion.

#### Performance & Optimization

- [ ] **Dirty region tracking for canvas rendering**
  - Currently the entire canvas is redrawn on each frame. Implement a dirty region system that tracks which areas need redrawing.
  - Track bounding boxes of modified shapes and only repaint affected regions.
  - Potential 2-5x performance improvement for large canvases with localized edits.

- [ ] **Shape render caching with OffscreenCanvas**
  - Cache complex shapes (groups with many children, shapes with shadows/patterns) to OffscreenCanvas.
  - Invalidate cache only when shape properties change.
  - Particularly beneficial for groups with background patterns and shadow effects.

- [ ] **Virtual scrolling for LayerPanel**
  - LayerPanel renders all shapes in the DOM, which degrades with 100+ shapes.
  - Implement windowed rendering (react-window or custom) to only render visible items.
  - Include smooth scroll position restoration when collapsing/expanding groups.

#### Stability & Quality

- [ ] **Performance regression benchmarks**
  - Automated benchmark: render 1000/5000/10000 shapes, measure FPS.
  - Track metrics over time to catch regressions.
  - Alert if performance drops below threshold.

- [ ] **Accessibility audit and improvements**
  - ARIA labels for all interactive elements.
  - Keyboard navigation through all panels and menus.
  - High contrast mode support.
  - Screen reader announcements for state changes.

#### Quality-of-Life

- [ ] **Template gallery**
  - Starter templates: Flowchart, Org Chart, ERD, Network Diagram, Wireframe.
  - New document dialog with template selection.
  - Allow users to save documents as custom templates.

#### Connector & Shape Improvements

- [ ] **Lazy connector route rebuilding** _(Large)_
  - `rebuildAllConnectorRoutes()` rebuilds ALL connectors on any change.
  - Implement incremental updates for only affected connectors.
  - Cache connector routes and invalidate on shape changes.

#### Error Handling & Resilience

- [ ] **Sync operation rollback mechanism**
  - `SelectTool.ts` has TODO: "Revert any in-progress changes" with no implementation.
  - Implement operation rollback for failed multi-step operations.
  - Ensure partial failures don't leave document in inconsistent state.

#### Testing Coverage

- [ ] **Store layer test coverage**
  - `documentStore.ts` - Complex shape manipulation logic untested.
  - `connectionStore.ts` - Connection state transitions tested (26 tests).
  - `teamDocumentStore.ts` - Permission logic and sync flow untested.
  - `persistenceStore.ts` - Document lifecycle operations need coverage.

- [ ] **Edge case test scenarios**
  - Connection loss during active sync operations.
  - Offline queue overflow (100+ pending operations).
  - Concurrent edits on same shape from multiple clients.
  - Shape deletion while connector references it.
  - Group nesting cycle detection.

#### Developer Tooling

- [ ] **Integration test harness** _(Large)_
  - No end-to-end tests for collaborative workflows.
  - Create test utilities for multi-client scenarios.
  - Add CI job for integration test suite.

### Future: Auto-Update

- [ ] Implement a feature which can scan the GitHub repo for updates and check if a new version exists
- [ ] Implement a feature to update the application **without** user commands or manual download+installation

### Future: Publisher Module

- [ ] Implement a 'Publisher' module to implement the following requirements:
  - [ ] Create publish configurations to manage the publisher's export locations
  - [ ] Run a publish configuration to export various types of media (e.g. PDF, SVG, JSON) to a single, or multiple configured paths on the computer.
  - Keep it extensible to support exporting to cloud locations in the future.

### Future: Document Cloud Providers

- [ ] Implement support

### Future: Comprehensive Local Help System

- [ ] Implement a local help documentation system with integrated search and navigation
- [ ] Create a comprehensive help guide for the application

### Future: Advanced Themes

- [ ] Implement Advanced Themes

### Future: Cross-Platform Memory Profiling

Comprehensive memory analysis across Windows, Linux (WebKitGTK), and macOS to identify platform-specific behaviors and potential leaks.

- [ ] **Baseline memory profiling**
  - Document normal memory usage per platform (WebView2 vs WebKitGTK vs WKWebView)
  - Establish acceptable memory ranges for idle, active editing, and heavy usage
  - Track memory over extended sessions (8+ hours)

- [ ] **Leak detection suite**
  - Create reproducible test scenarios (create/delete pages, add/remove shapes, image upload/delete)
  - Heap snapshot comparison before/after operations
  - Identify retained objects (ProseMirror state, detached DOM, blob URLs)

- [ ] **Platform-specific investigation**
  - WebKitGTK memory characteristics on Linux (PopOS, Ubuntu, etc.)
  - AppArmor/sandboxing impact on memory reporting
  - Garbage collection timing differences

- [ ] **Cleanup improvements** (if leaks found)
  - Revoke blob object URLs when no longer needed
  - Clear ProseMirror transaction history on page switch
  - Ensure proper React component unmount cleanup

### Future: Canvas Code Integration with Git

- [ ] Implement a composable VCS pattern which allows interfacing with Git for version control and file usage, and
      others in the future
- [ ] Implement file(s) linking to a shape which can be viewed in the property panel
- [ ] Integrate with existing Git integration for version control (save changes to Git repo; default directory is
      /docs/diagrammer.json)
- [ ] Feat: Spawn a VS Code instance with access to Git repo

### Future: AI Model Integration

#### Architecture: Semantic Abstraction Layer

AI should reason about **relationships and entities**, not coordinates. The app handles spatial layout.

**AI Output Schema** (no X/Y coordinates):
```typescript
interface AIGraphOutput {
  diagram_type: 'flowchart' | 'erd' | 'class-diagram' | 'sequence' | 'network';
  nodes: Array<{
    id: string;
    type: string;          // maps to shape type
    label: string;
    attributes?: string[]; // for ERD entities, class members, etc.
  }>;
  edges: Array<{
    from: string;          // node id
    to: string;            // node id
    label?: string;
    cardinality?: 'one-to-one' | 'one-to-many' | 'many-to-many';
  }>;
  layout_hint?: 'hierarchical' | 'force-directed' | 'grid' | 'radial';
}
```

**Near-Node Placement** (for incremental edits):
```typescript
interface PlacementHint {
  near: string;                              // existing shape ID or label
  direction: 'above' | 'below' | 'left' | 'right' | 'auto';
  offset?: 'compact' | 'normal' | 'spacious';
}
```

**Layout Engine** converts semantic graph → positioned shapes:
- Hierarchical (dagre): flowcharts, org charts, trees
- Force-directed (d3-force): ERDs, network diagrams
- Near-node resolver: incremental additions with overlap avoidance

#### Deliverables

- [ ] **Layout Engine** (`src/services/LayoutEngine.ts`)
  - dagre integration for hierarchical layouts
  - d3-force integration for force-directed layouts
  - Near-node placement resolver
  - Overlap avoidance with existing shapes
  - Diagram type → layout strategy mapping

- [ ] **AI Service** (`src/services/AIService.ts`)
  - Provider abstraction (Claude, OpenAI, Ollama)
  - System prompt with diagram domain context
  - Structured output schema validation
  - Tool call execution pipeline

- [ ] **AI Assistant Panel** (`src/ui/AIAssistantPanel.tsx`)
  - Text input for natural language requests
  - "Generate Diagram" from description
  - "Improve Selection" for existing shapes
  - "Explain Diagram" for documentation
  - Provider selection in settings

- [ ] **Schema Validator** (`src/services/AISchemaValidator.ts`)
  - Validate node types against shape libraries
  - Map diagram_type to appropriate shapes
  - Graceful fallback for unknown types

- [ ] Implement AI-powered diagram analysis
- [ ] Generate insights and suggested edits

### Future: Enterprise Edition (Paid)

A commercially licensed tier targeting teams and organizations, built on top of the free open-source core.

#### Scalable Collaboration Server
- [ ] Replace single-host Tauri WebSocket server with a dedicated, horizontally scalable collaboration server
- [ ] Implement a room/session broker that distributes document sessions across server instances
- [ ] Add connection pooling, backpressure, and graceful degradation under load
- [ ] Support configurable persistence backends (PostgreSQL, Redis, S3) for CRDT state
- [ ] Provide Docker / Kubernetes deployment manifests and Helm chart

#### Cloud Storage Connectors
- [ ] Implement a storage provider abstraction layer (local FS, S3, Azure Blob, GCS)
- [ ] Add OAuth-based linking for Google Drive, OneDrive, Dropbox
- [ ] Support read/write of diagrams directly from cloud storage
- [ ] Implement cross-provider sync and conflict resolution

#### Enterprise Plugin System
- [ ] Webhook plugin — outbound event notifications (document created/updated/deleted, user joined/left)
- [ ] Audit log plugin — structured, queryable logs of all document and user events
- [ ] SSO/SAML plugin — integrate with corporate identity providers (Okta, Azure AD, etc.)
- [ ] RBAC plugin — role-based access control for documents, pages, and team workspaces
- [ ] Data retention plugin — configurable retention policies and automated purging

#### Security & Compliance
- [ ] End-to-end encryption for document content in transit and at rest
- [ ] Per-document encryption key management (envelope encryption)
- [ ] Signed export artifacts (PDF, SVG) with tamper-evident checksums
- [ ] SOC 2 / GDPR compliance documentation and data handling controls

#### Advanced Observability
- [ ] Structured server logging with configurable verbosity (JSON, stdout, syslog)
- [ ] Prometheus metrics endpoint (connections, sync latency, document ops/sec)
- [ ] OpenTelemetry tracing for request lifecycle visibility
- [ ] Admin dashboard for server health, active sessions, and storage usage

---

## Testing Notes

- Mark tasks with [x] when completed
- Update this file as new tasks are discovered
- Each task should be small enough to complete in one session
- Test each component before moving to the next phase
- Total tests: 1045 passing (32 test files)

## Test Coverage by Module

| Module                           | Tests   |
| -------------------------------- | ------- |
| Math (Vec2, Mat3, Box, geometry) | 204     |
| Camera                           | 58      |
| InputHandler                     | 41      |
| Renderer                         | 33      |
| SpatialIndex                     | 24      |
| HitTester                        | 24      |
| DocumentStore                    | 37      |
| SessionStore                     | 37      |
| PageStore                        | 32      |
| HistoryStore                     | 19      |
| Rectangle                        | 21      |
| Ellipse                          | 25      |
| Line                             | 23      |
| Shape transforms                 | 31      |
| Shape bounds                     | 24      |
| Collaboration (protocol, sync)   | 200+    |
| Storage (cache, trash, versions) | 80+     |
| connectionStore                  | 26      |
|                                  |         |
| **Total**                        | **1045**|

