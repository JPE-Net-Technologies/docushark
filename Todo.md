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

Phases 1–18.3 are complete. See [roadmap.md](docs-site/developer/roadmap.md) for full version history.

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

- [x] **Document archive service**
  - `DocumentArchiveService.exportDocument(docId)` — bundles one document + referenced blobs into a `.diagrammer` archive.
  - `DocumentArchiveService.importDocument(file)` — imports a `.diagrammer` file, creating a new local document with all blobs.
  - Reuses `ArchiveUtils` (ZIP, checksums, blob collection) — no new archive infrastructure needed.
  - Manifest `type: 'diagrammer-document-archive'` distinguishes from full backups.

- [x] **UI integration**
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

#### Phase 17.1: Core Infrastructure ✅

- [x] **FileShape type definition** (`src/shapes/Shape.ts`)
  - Extends BaseShape with: `blobRef`, `fileName`, `mimeType`, `fileSize`, `fileCategory`
  - Preview metadata: `thumbnail` (base64), `pageCount`, `dimensions`
  - Supported categories: `pdf`, `spreadsheet`, `image`, `text`, `generic`

- [x] **File shape handler** (`src/shapes/FileShape.ts`)
  - Unified handler: thumbnail card rendering, bounds, hitTest, handles, anchors
  - Registered in ShapeRegistry with PropertyPanel metadata

- [x] **File utility functions** (`src/utils/fileUtils.ts`)
  - MIME type detection, file category mapping, size formatting, icon lookup

- [x] **Thumbnail generation service** (`src/services/ThumbnailGenerator.ts`)
  - Async main-thread generation (images via canvas, PDFs via pdf.js, text preview)
  - Store thumbnail in shape's `preview.thumbnail` field

- [x] **Blob reference tracking**
  - Extended `persistenceStore`, `AssetBundler`, `ArchiveUtils`, `StorageManager`, `StorageSettings`
  - FileShape `blobRef` fields scanned for GC protection

#### Phase 17.2: Content Viewer Modal ✅

- [x] **FileViewerModal component** (`src/ui/FileViewerModal.tsx`)
  - Full-screen modal with close button, download action
  - File type detection and lazy viewer dispatch via `React.lazy()`
  - Double-click on FileShape opens modal (via ToolContext + SelectTool)

- [x] **PDF viewer** (`src/ui/viewers/PdfViewer.tsx`)
  - pdf.js integration for rendering (lazy-loaded)
  - Page navigation (prev/next, page number input)
  - Zoom controls (fit-width, fit-page, manual ±25%)

- [x] **Spreadsheet viewer** (`src/ui/viewers/SpreadsheetViewer.tsx`)
  - SheetJS (xlsx) for parsing XLSX/CSV (lazy-loaded)
  - Table rendering with virtual scrolling for large datasets
  - Sheet tabs for multi-sheet workbooks

- [x] **Image viewer** (`src/ui/viewers/ImageViewer.tsx`)
  - Full-resolution display with zoom (fit/100%/manual) and pan

- [x] **Text viewer** (`src/ui/viewers/TextViewer.tsx`)
  - Monospace rendering with line numbers and word wrap toggle

- [x] **Generic file viewer** (`src/ui/viewers/GenericFileViewer.tsx`)
  - File icon, name, size, type display, "No preview available" message

#### Phase 17.3: File Import Flow

- [x] **File validation & constants** (`src/utils/fileUtils.ts`)
  - `validateFileForEmbed(file)` — size limit (50MB), zero-byte check, filename sanitization
  - `sanitizeFileName(name)` — trim, remove path separators, limit length

- [x] **File import service** (`src/services/FileImportService.ts`)
  - `importFiles(files, worldPosition, deps)` pipeline: validate → quota check → blob save → thumbnail → create FileShape → add to document
  - Multi-file grid layout (3 columns), single undo entry, error aggregation, notifications

- [x] **Canvas drag-and-drop** (`src/ui/CanvasContainer.tsx`)
  - Extend `handleDragOver`/`handleDrop` to accept native file drops (`Files` type)
  - Convert screen→world position, call FileImportService
  - Drop zone visual feedback (dashed border overlay)

- [x] **Toolbar file import button** (`src/ui/FileImportButton.tsx`)
  - Hidden `<input type="file" multiple>`, paperclip icon, loading state
  - Add to UnifiedToolbar left section

- [x] **Context menu "Embed file..."** (`src/ui/ContextMenu.tsx`)
  - Available on empty canvas right-click, opens file picker

- [x] **Keyboard shortcut** — `Ctrl+Shift+F` for embed files

#### Phase 17.4: Storage Manager Integration

- [x] **Files tab in Storage Manager** (`src/ui/StorageManager.tsx`)
  - List all embedded files with: name, type, size, reference count
  - Preview thumbnails where available
  - Show which documents reference each file
  - Orphan detection (files with no shape references)
  - Delete/replace individual files

- [x] **Files tab in Storage Settings** (`src/ui/settings/StorageSettings.tsx`)
  - Mirror of StorageManager Files tab

- [x] **Storage references checker extension** *(completed in 17.1.5)*
  - `BlobGarbageCollector` already scans FileShape `blobRef` fields
  - `extractShapeBlobIds()` in persistenceStore, StorageManager, StorageSettings

#### Phase 17.5: Collaboration Support ✅

- [x] **HTTP blob endpoints** (Rust backend)
  - `POST /api/blobs/:hash` — Upload blob with hash verification
  - `GET /api/blobs/:hash` — Download blob by hash
  - `HEAD /api/blobs/:hash` — Check blob existence
  - Standard HTTP streaming (retry logic handles failed uploads)
  - Authentication via JWT token header

- [x] **Blob sync protocol**
  - On shape sync, client checks if blob exists locally
  - If missing, fetch via HTTP endpoint
  - Progress indicator in status bar during file sync
  - Retry logic with exponential backoff

- [x] **AssetBundler extension**
  - Added `mode` option: 'embed' (base64) or 'reference' (keep hash refs)
  - Reference mode for collaboration (blobs synced via HTTP separately)

#### Phase 17.6: Polish & Edge Cases ✅

- [x] **File replacement flow**
  - Replace file contents while keeping shape position/size
  - Regenerate thumbnail
  - Update all references atomically
  - Replace button in FileViewerModal, PropertyPanel, and ContextMenu

- [x] **Error handling**
  - Corrupt file detection on import (FileIntegrityValidator)
  - Missing blob recovery UI (re-upload in FileViewerModal)
  - Visual indicator on FileShape when blob is missing
  - Unsupported file type graceful fallback with placeholder thumbnails

- [x] **Memory management**
  - Unload full PDF/spreadsheet content when modal closes
  - LRU cache for recently viewed file content (FileContentCache)
  - Cache manages object URL lifecycle with size-based eviction

### Phase 18: Advanced Diagram Patterns [RELEASE v1.3.0‑beta.1]

Professional diagram patterns including UML Sequence Diagrams, Activity Diagrams with Swimlanes, and a Whiteboard for idea tracking.

#### Phase 18.1: Sequence Diagram Patterns ✅

- [x] **UML Sequence connector type** (`src/shapes/Shape.ts`, `src/shapes/Connector.ts`)
  - Added `UMLSequenceMarker` type with markers: `sync`, `async`, `reply`, `create`, `destroy`, `lost`, `found`
  - Added `startSequenceMarker` and `endSequenceMarker` properties to `ConnectorShape`
  - Implemented `drawUMLSequenceMarker()` function in `Connector.ts`
  - Auto-detects `uml-sequence` connector type when sequence markers are set

- [x] **Sequence Lifeline shape** (`src/shapes/library/sequenceDiagramShapes.ts`)
  - Actor/object header rectangle at top
  - Dashed vertical line extending downward (`lifelineLength` property)
  - Dynamic anchors along the lifeline for message attachment
  - Custom render function for header + dashed line
  - **Enhanced**: 6 head type variants (`headType`: object, actor, component, interface, database, queue)
  - **Enhanced**: Stereotype support (`stereotype`, `showStereotype` properties)

- [x] **Sequence Activation shape**
  - Thin filled rectangle representing method execution
  - Positions on lifeline based on Y coordinate
  - Left/right edge anchors for messages
  - **Enhanced**: Nesting support (`nestLevel`, `isRecursive` properties)

- [x] **Sequence Fragment shape**
  - Interaction frame for grouping (loop, alt, opt, par, break, critical, strict, seq)
  - Corner label with frame type and optional guard condition
  - Custom render with label in top-left corner
  - **Enhanced**: Multiple operands with dividers (`operands[]`, `showDividers` properties)

- [x] **Sequence Actor shape**
  - UML stick figure representation
  - Standard 5-point anchors
  - Label below figure
  - **Enhanced**: Actor type variants (`actorType`: person, system, external)

- [x] **Sequence Destruction shape**
  - X marker for object destruction
  - Top/center/bottom anchors only

- [x] **NEW: State Invariant shape** (`seq-state-invariant`)
  - Constraint text in curly braces notation
  - Properties: `constraint` (string)

- [x] **NEW: Time Constraint shape** (`seq-time-constraint`)
  - Duration annotation shape
  - Properties: `duration`, `minTime`, `maxTime`, `unit` (ms/s/min/h)

- [x] **NEW: Coregion shape** (`seq-coregion`)
  - Bracketed region indicating unordered messages
  - Properties: `patternType` (stripes/dots/bracket)

- [x] **NEW: Continuation shape** (`seq-continuation`)
  - Rounded frame for cross-diagram continuation
  - Properties: `continuationLabel`

- [x] **Library registration** (`src/store/shapeLibraryStore.ts`)
  - Added `'uml-sequence'` category loader
  - Exported shapes from `src/shapes/library/index.ts`

- [x] **Tests** for sequence shapes (57 tests in `sequenceDiagramShapes.test.ts`)

#### Phase 18.2: Activity Diagram Patterns + Swimlanes ✅

- [x] **Activity Action shape** (`src/shapes/library/activityDiagramShapes.ts`)
  - Rounded rectangle for activity nodes
  - Label support with custom rendering
  - Standard 5-point anchors
  - **Enhanced**: Call behavior/operation support (`actionType`, `behaviorName`, `operationName`, `showRake`)
  - **Enhanced**: Pre/post conditions (`precondition`, `postcondition`)

- [x] **Activity Initial/Final nodes**
  - `activity-initial`: Filled black circle (start)
  - `activity-final`: Double circle with filled inner (end)
  - `activity-flow-final`: Circle with X (flow termination)

- [x] **Fork/Join Bar shape**
  - Thick solid black bar
  - Auto-detects orientation based on width/height
  - Dynamic anchors along bar length (top/bottom or left/right)
  - **Enhanced**: Join specification support (`joinSpec` property)

- [x] **Send/Receive Signal shapes**
  - `activity-send-signal`: Pentagon pointing right
  - `activity-receive-signal`: Concave pentagon (notched)
  - Label support with custom rendering

- [x] **Swimlane shape** (`src/shapes/library/activityDiagramShapes.ts`)
  - Implemented as library shape with custom properties
  - Properties: `orientation` (horizontal/vertical), `laneHeaders[]`, `headerSize`, `headerBackground`
  - Renders lane dividers and header cells
  - Dynamic anchors at lane centers
  - **Enhanced**: Custom lane widths (`laneWidths[]`) and colors (`laneColors[]`)
  - **Enhanced**: Partition type support (`partitionType`: dimension/external)

- [x] **NEW: Decision Node shape** (`uml-activity-decision`)
  - Diamond shape (40x40, aspect locked)
  - Properties: `decisionInput` (optional text)
  - 4-point anchors at diamond corners

- [x] **NEW: Merge Node shape** (`uml-activity-merge`)
  - Diamond geometry (semantically different from decision)

- [x] **NEW: Accept Event shape** (`uml-activity-accept-event`)
  - Concave pentagon for event reception

- [x] **NEW: Accept Time Event shape** (`uml-activity-time-event`)
  - Hourglass symbol
  - Properties: `timeExpression` (e.g., "after(5s)")

- [x] **NEW: Object Node shape** (`uml-activity-object`)
  - Rectangle with name:Type[state]
  - Properties: `objectName`, `objectType`, `state`, `ordering` (FIFO/LIFO/ordered/unordered)

- [x] **NEW: Data Store shape** (`uml-activity-datastore`)
  - Rectangle with <<datastore>> stereotype
  - Properties: `storeName`

- [x] **NEW: Central Buffer shape** (`uml-activity-buffer`)
  - Rectangle with <<centralBuffer>> stereotype
  - Properties: `bufferName`, `ordering`

- [x] **NEW: Input/Output Pin shape** (`uml-activity-pin`)
  - Small square (16x16)
  - Properties: `pinType` (input/output), `pinName`, `dataType`

- [x] **NEW: Expansion Region shape** (`uml-activity-expansion`)
  - Rounded dashed container
  - Properties: `mode` (parallel/iterative/stream)

- [x] **NEW: Interruptible Region shape** (`uml-activity-interruptible`)
  - Dashed rounded rectangle with lightning bolt indicator

- [x] **NEW: Activity Parameter Node shape** (`uml-activity-parameter`)
  - Pin-like shape at activity boundary
  - Properties: `direction` (in/out/inout), `name`, `type`

- [x] **Library registration** (`src/store/shapeLibraryStore.ts`)
  - Renamed category to `'uml-activity'` for consistency
  - Reuses `diamondShape` from flowchart for decisions

- [x] **Tests** for activity shapes and swimlanes (71 tests in `activityDiagramShapes.test.ts`)

#### Phase 18.2.1: Connector Enhancements ✅

- [x] **Guard conditions** (`src/shapes/Shape.ts`, `src/shapes/Connector.ts`)
  - Added `guardCondition` property for activity diagram connectors
  - Added `guardPosition` property (0-1, default 0.2) for label placement
  - Renders as `[condition]` text with white background near connector start

- [x] **Flow type for activity diagrams**
  - Added `FlowType` type: `'control'` (solid) | `'object'` (dashed)
  - Added `flowType` property to `ConnectorShape`
  - Object flow automatically uses dashed line style

- [x] **Message numbering for sequence diagrams**
  - Added `messageNumber` property (e.g., "1", "2.1", "3.1.2")
  - Renders number with colon near connector start

- [x] **Self-message routing**
  - Added `selfMessageWidth` property (default: 30)
  - Auto-detects when `startShapeId === endShapeId`
  - Routes connector as a loop to the right of the lifeline

- [x] **Tests** for connector enhancements (36 tests in `Connector.test.ts`)

#### Phase 18.3: Whiteboard (Sticky Notes) ✅

Document-global whiteboard for sticky notes, accessible via **Ctrl+I**. Intended for idea tracking, not optimized for PDF export.

- [x] **Whiteboard store** (`src/store/whiteboardStore.ts`)
  - Notes collection with CRUD operations
  - Visibility toggle state (`isVisible`)
  - Note z-order management

- [x] **Whiteboard overlay** (`src/ui/Whiteboard.tsx`, `src/ui/Whiteboard.css`)
  - Full-viewport overlay (hidden by default)
  - Semi-transparent backdrop with grid pattern
  - "Add Note" button, close button (Esc or click outside)

- [x] **StickyNote component** (`src/ui/StickyNote.tsx`)
  - Draggable within whiteboard bounds
  - Resizable via corner handles
  - Customizable hex colors via color picker with 12 presets + recent colors from color palette store
  - Uses `getContrastColor()` and `darken()` from `src/utils/color.ts` for dynamic header/text colors
  - contentEditable with basic formatting (Ctrl+B bold, Ctrl+I italic)
  - Delete button

- [x] **Keyboard shortcut**
  - `Ctrl+I` toggles whiteboard visibility (Ideas)
  - Registered in `Engine.ts` global keydown handler

- [x] **Toolbar button** (`src/ui/UnifiedToolbar.tsx`, `src/ui/UnifiedToolbar.css`)
  - Whiteboard icon button in toolbar right section
  - Tooltip with shortcut hint
  - Light + dark mode styling

- [x] **Toolbar button** (`src/ui/UnifiedToolbar.tsx`, `src/ui/UnifiedToolbar.css`)
  - Whiteboard icon button in toolbar right section
  - Tooltip with shortcut hint
  - Light + dark mode styling

- [x] **Persistence** (`src/types/Document.ts`, `src/store/persistenceStore.ts`)
  - Add `whiteboard` field to `DiagramDocument`
  - Store notes with position, size, color, content
  - Load/save whiteboard with document

- [x] **Export handling** (`src/utils/exportUtils.ts`)
  - Add "Include whiteboard notes" option
  - Default: excluded (whiteboard is for drafting)

- [x] **Tests** for whiteboard functionality (19 tests)

## Optimizations Backlog: Performance & Polish Tasks

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

### Future: Dynamic Style Profiles

- [ ] Implement optional shape style reference field; referenced style profiles override defaults
- [ ] Style profiles can also be merged to a shape instead of referenced, acting as one-time copy
- [ ] Implementing this would mean applying shape adapters for style to store the large amount of shapes' customization (optimizing this may prove difficult w/o extensive testing)

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

### Future: Video Tutorials

Short screencast videos to accompany documentation pages. Each video should be 2–5 minutes, embedded in the corresponding docs page and uploaded to a hosting platform (YouTube or self-hosted).

<!-- 🎬 VIDEO: These tasks mark where video content would significantly improve the learning experience. -->
<!-- Videos are most valuable for spatial/interactive features that are hard to convey in text alone. -->

- [ ] **Quick Start walkthrough** — Video showing document creation, adding shapes, connecting them, and exporting. Complements `getting-started/quick-start.md`.
- [ ] **Canvas navigation demo** — WASD movement, scroll-zoom, minimap, and smart guides in action. Spatial interaction is hard to convey in text. Complements `guide/canvas-navigation.md`.
- [ ] **Connector routing & connection points** — Show snap behavior, auto-routing, switching between orthogonal/straight/curved, and self-messages. Complements `guide/connectors.md`.
- [ ] **Collaboration setup (Host + Join)** — Full walkthrough of starting a server, configuring auth, joining from another machine, and seeing live cursors. Multi-step networking setup benefits from screencast. Complements `guide/collaboration.md`.
- [ ] **Shape libraries & icon browsing** — Browsing categories, searching icons, using cloud provider icons (AWS/Azure/GCP), and creating custom libraries. Visual discovery. Complements `guide/shape-libraries.md`.
- [ ] **Rich text editor features** — Formatting toolbar, LaTeX math (inline and block), tables, embedded diagram groups, and images. Complements `guide/rich-text-editor.md`.
- [ ] **Export workflows (PNG/SVG/PDF)** — Show export options, scale settings, PDF cover page configuration, and .diagrammer archive creation. Complements `guide/export-import.md`.
- [ ] **Embedded files (drag-and-drop)** — Drag files onto canvas, open PDF/spreadsheet viewers, file replacement, and Storage Manager. Complements `guide/embedded-files.md`.
- [ ] **Whiteboard / sticky notes** — Quick demo of Ctrl+I, adding/coloring/arranging notes, and closing. Complements `guide/whiteboard.md`.
- [ ] **Backup & restore** — Full walkthrough of creating a backup, choosing what to include, restoring on a new machine, and merge vs. replace. Complements `guide/export-import.md`.
- [ ] **Style profiles & themes** — Creating style profiles, applying them to shapes, switching themes, and setting defaults. Visual styling needs visual demonstration. Complements `guide/styling.md`.

---

## Testing Notes

- Mark tasks with [x] when completed
- Update this file as new tasks are discovered
- Each task should be small enough to complete in one session
- Test each component before moving to the next phase
- Total tests: 1408 passing (44 test files)

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
| SessionStore                     | 41      |
| PageStore                        | 32      |
| HistoryStore                     | 19      |
| Rectangle                        | 21      |
| Ellipse                          | 25      |
| Line                             | 23      |
| Connector                        | 36      |
| Shape transforms                 | 31      |
| Shape bounds                     | 24      |
| Collaboration (protocol, sync)   | 200+    |
| Storage (cache, trash, versions) | 80+     |
| connectionStore                  | 26      |
| Sequence Diagram Shapes          | 57      |
| Activity Diagram Shapes          | 71      |
|                                  |         |
| **Total**                        | **1408**|

