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

## Phase 19: ???

---

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

