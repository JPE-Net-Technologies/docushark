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

## Phase 19: PDF Export Enhancements, Additional Document Formatting Features ([Pre-]Release 1.4.0-beta.1)

### 19.1 - Formatted Text Space/Margins Fixs

- [X] Headings produce too much bottom padding, pushing content beneath a bit too far too far, also the headings need slightly more top-padding.
- [X] Blockquotes' text sits above the container slightly; it should be well-centered vertically.
- [X] Blockquotes intersect with headings when directly above them.
- [X] When exported to PDF, a blockquote above bold text (suspected trigger), the quotes left margin line will stretch down the page resulting in a ugly visual bug.

### 19.2 - Additional Features

- [X] Better documents browser UX — flat document **groups** (local-only metadata, single group per doc, tag-style) with collapsible sections + "Ungrouped" bucket; per-group rename / recolor (preset swatches) / delete via `⋯` menu; **grid / list** view toggle (persisted); **sort** options (Recently modified, Least recently modified, Name A–Z / Z–A, Recently created); **multi-select** via Cmd/Ctrl-click and Shift-click range, with bulk *Assign to group* (incl. "New group…" + "Remove from group"), *Export*, *Delete*; group accent chip on cards in flat view; all preferences persisted in `uiPreferencesStore`; groups stored in new `documentGroupStore` (no document-schema change, no protocol change).
- [X] Code-Block is needed (language support is not recommended unless it's lightweight + cross-plat., but it should be highly format-aware (preserving rich formatting where possible), especially with indentation.
- [X] Spellcheck (custom dictionary; "Add to Dictionary" button) — grammar check still pending.
- [X] Contrast Awareness Font Coloring System: 'Automatic' colour sentinel resolves at render time via a topmost-shape spatial walk (per-segment for connectors, group-bg aware), and forces black for PDF export. Available for fill, stroke, label colour, group background, and group border.
- [X] Remember scroll position in tiptap editor.
- [ ] Make the PDF exporter full-screen, and add a preview PDF feature which saves the PDF to temp dir and shows it on the side, users can either save it (copy to downloads with a fallback to exporting to downloads), or close it (deleting the temp file)
- [X] Table of contents for PDF
- [X] Document Outline for PDF Readers
- [X] LINKS! We need web links and internal document links!
- [X] Bidirectional connectors (selective arrow directions and sides) — per-endpoint `ArrowStyle` (none/triangle/open/diamond) on `ConnectorShape`, legacy `startArrow`/`endArrow` booleans kept for back-compat via `resolveArrowStyle`; exposed in PropertyPanel and the MCP DSL adapter.

### 19.3 - PDF Styling Features, Document Features, and General Fixes

- [X] When exported to PDF, table cells won't break-word for word-wrapping leading to large words/numbers being overflow out of the cell. — shared char-break fallback in `renderSegmentedText` (table cells route through the same path).
- [X] Large strings (one giant word or number; a edge case but needs to be fixed) in the PDF don't break; they overflow the page. — same fix; `breakOversizedWord` greedily splits any token wider than the available width.
- [X] Saving PDF defaults saves application-level; it should be document level as other documents data get pulled by others, and it get's messy. — `pdfSettings` snapshot on `DiagramDocument`; dialog reads/writes only the active doc and pushes through to team docs via the host save path. App-level state no longer writable from the dialog.
- [X] When a cover-page has a logo selected, display the name and size in the PDF exporter section.
- [ ] Marking document sections as WIP (add an icon next indicating it's still in construction); we can also add hide properties for PDFs to exclude document WIPs in the future.
- [ ] The document toolbar switches to the table ribbon/tab when editing a table, but doesn't change to Home on text selection or after exiting the table, I suggest removing the toolbar ribbon auto-switch.

### 19.4 - PDF Compression Optimizations

- [ ] The standard DPI's images are terrible quality; apply a better compression profile to the DPI settings.
- [ ] Background export jobs; large documents can take a while to compress + export and the export UI menu get's stuck whilst running, close the menu, and apply a dismissable toast which indicates the PDF is being built.

### 19.5 - Layer Panel Refinements

- [ ] Layer panel is too small when first expanded, consider maybe a side bar (tabbed with the propertly panel); similar to graphics editors
- [ ] Layer panel context menu needs add-to-group functionality
- [ ] When dragging multiple items in the layer panel, only one gets moved; also the panel does not scroll as you drag at the bottom.

### 19.6 - MCP (Model Context Protocol) Integration

- [x] Foundation: embedded MCP HTTP server in Tauri Rust backend (`src-tauri/src/mcp/`)
  - [x] Bearer-token auth (`mcp_token` under app data dir, `0600` on unix, constant-time validate)
  - [x] Streamable HTTP transport: `POST /mcp` (JSON-RPC), `GET /mcp` (SSE keep-alive), `DELETE /mcp`, unauth liveness at `/`
  - [x] Four read/draft tools: `docushark.list_documents`, `get_document`, `get_page`, `add_shape`
  - [x] LLM-optimized DSL with adapter (rectangle / ellipse / text; AUTO colour sentinel honoured)
  - [x] Writes broadcast `DocEvent::Updated` so the running app reloads
  - [x] Auto-start on app launch
- [x] Settings tab "MCP Server" with status, endpoint, token (Show/Copy/Regenerate/Set manually) and a ready-to-copy `claude mcp add` line
- [x] Manual-token paste flow (URL-safe alphabet, 16–128 chars) for syncing tokens across machines
- [x] Local document mirror so MCP clients can read renderer-owned (local-only) documents. Default-on toggle in MCP Settings with "Sync now" button; on-save / on-delete hooks in `persistenceStore`; one-shot bulk sync on app start. Local docs are read-only via MCP for now (writes restricted to team docs to avoid localStorage write races).
- [x] Write tools: `add_shapes` (batch, all-or-nothing), `connect` (validates endpoints), `update_shape` (partial DSL patch). Connector kind added to adapter. All mutating tools refuse local-mirror docs with a "promote to team document" message.
- [ ] Layout tools: `align`, `distribute`, `grid_layout`, `group`
- [ ] Rich-text read + comments (Tiptap comment mark, `commentsStore`, MCP comment tools)
- [ ] Live CRDT writes via `yrs` (avoids last-write-wins when user edits during a draft)
- [ ] Spatial-index-aware layout (reuse `SpatialIndex` to avoid overlap)
- [ ] Blob/image authoring via MCP
- [ ] Plan reference: `~/.claude/plans/so-i-really-want-ancient-kay.md`

### 19.9 - General Fixes

- [ ] Draggable items in property panel don't move at at all (ie. ERD entity attributes; among others).

## Phase 20: 2.0 Beta — Relay Extraction + Polish

This phase ships as **2.0.0-beta.1**. The headline change is extracting
collaboration, MCP, identity, and document storage out of the Tauri host
into a standalone **Relay** binary. Tauri becomes a pure client. The
local store stays origin-blind. "Protected Local" is removed; existing
team docs get downgraded to local docs on first launch. See
`Relay Architecture` below.

**Business framing:** self-hosted Relay stays free and one-command
trivial to deploy. Revenue comes from a managed Relay tier. This means
the self-hosted design priority is *boring, easy to run* — horizontal
scalability is a managed-tier concern, not a phase 20 concern.

### 20.1 - Documentation Enhancements

- [ ] Human will add [YouTube] videos for different concepts; you must add support for a custom component to not embed but emphasize a link to YouTube video.
- [X] Optimize the docs site to use high-quality styling, and easy-to-navigate pages
- [ ] Review shapes in docs and identify implementation discrepancies

### 20.2 - Style Profile Refinements

- The style profiles are an **excellent** foundation but that are just that; some features are needed to bring them to fruition:
  - [ ] StyleProfileShapeAdapters
  - Note: we do have in the backlog, a task for Dynamic Style Profiles, if the complexity isn't massive, consider moving that task to this phase

### 20.3 - Relay Extraction (the headline change)

The Relay is a standalone Rust binary in a new root-level `/relay/`
crate (not a workspace member of `src-tauri/`). It owns collaboration,
MCP, auth, and document storage. The Tauri desktop becomes a pure
client that holds local documents and connects to a Relay for
collaborative ones.

> **Status:** shipped on the `v2` branch (slices A–H all in). The
> operator-level handoff (`Todo.Relay.md`) has been removed now that
> every checklist item is done; this section is the historical record.

**Decisions locked in (from the 2026-05-12 planning session):**

1. Renderer pre-fills `http://localhost:9876`; custom-URL UX deferred.
2. No credential persistence in v2 — login screen each launch.
3. Single TCP port for all docs. Current `/ws?doc=<id>` shape stays —
   no cosmetic rewrite to `/sync/:doc_id`.
4. Defer the bcrypt → argon2 swap.
5. Rename `'to-team'` direction enum → `'to-relay'` in `DocumentTransferService`
   (team functionality is severed in v2).
6. Rename `DocumentMetadata.isTeamDocument` wire field → `isRelayDocument`
   on the same justification. Bumps `PROTOCOL_VERSION` to 2.
7. The relay is never embedded in the Tauri app — users deploy it
   separately (locally, behind Tailscale / Cloudflare Tunnel, or
   later a managed tier). No "be a host" desktop affordance.

**Pre-extraction (foundation, in order):**

- [x] Freeze and version the wire protocol. Add a protocol-version
  negotiation header on connect. Add cross-language fixture tests in
  `/relay/tests/protocol-fixtures/` so `protocol.ts` and the relay's
  `protocol.rs` can't drift silently. _(Slice A — `PROTOCOL_VERSION = 1`
  on both sides, 18 fixtures at `/protocol-fixtures/` for now,
  migrating to `/relay/tests/protocol-fixtures/` in Slice C.)_
- [x] Decide protocol stewardship: codegen from a single source vs.
  strict cross-language fixtures. Recommendation: fixtures (simpler,
  no build-time codegen). _(Slice A — fixtures chosen; round-trip
  tests run on both `bun run test` and `cargo test`.)_
- [x] Naming pass on the renderer. Rename "host" / "team document" /
  "Protected Local" → "relay" / "relay document" / *(no replacement —
  Protected Local is removed)*. Affects `teamStore`,
  `teamDocumentStore`, `TeamDocumentCache`, `persistenceStore`,
  `UnifiedSyncProvider`, `documentRegistry`. _(Slice B — file +
  identifier + UI-string rename pass; storage keys migrate via
  `src/migrations/relayRename.ts` on first v2 launch. Deferred:
  `hostId` field rename, `DocumentTransferService` `to-team` direction
  enum, wire-field `DocumentMetadata.isTeamDocument` (Slice D/E),
  `team_documents/` Tauri filesystem path (Slice F).)_

**Relay crate (`/relay/`):**

- [x] Create `/relay/` directory with its own `Cargo.toml` (fully
  independent crate). Layout: `src/{main,api,sync,mcp,auth,storage,
  protocol}.rs` + `tests/protocol-fixtures/`. _(Slice C.1 — crate
  skeleton + protocol module + fixture move. Layout slightly deviates
  from the original sketch: `server/`/`auth/`/`mcp/` are lifted whole
  per the simpler structure; `sync.rs` + `api.rs` split + `storage.rs`
  trait are Slice D's job.)_
- [x] Lift `src-tauri/src/server/` → `/relay/src/sync/` + `/relay/src/api/`.
  Lift `src-tauri/src/mcp/` → `/relay/src/mcp/`. Behavior unchanged in
  this step — pure move + import-path fixup. _(Slice C.2 — wholesale
  lift of `server/`, `auth/`, `mcp/`. `relay/src/main.rs` now runs a
  working `relay serve` (Slice C.4). The Tauri-side copies stay until
  Slice E.)_
- [x] HTTP API (Axum): `/auth/{register,login,me}`, `/docs` CRUD,
  `/blobs` (content-addressed SHA-256), `/backup`, `/mcp` (JWT-auth'd).
  _(Slice D.2 + D.3 — `/api/auth/{register,login,me}` and
  `/api/docs/*` live next to the existing `/api/blobs/*`. `/mcp` is
  a bearer-auth'd HTTP listener on its own port per the lifted
  Tauri shape. `/backup` not yet implemented — deferred.)_
- [x] WebSocket: SYNC + AWARENESS only (single port for all docs —
  not restructuring to `/sync/:doc_id`; decision #3). _(Slice E.3 —
  CRUD moved to REST in D.3; the dead WS message handlers + 13
  fixtures were stripped from both protocol files and the kept
  surface is SYNC / AWARENESS / AUTH / AUTH_RESPONSE / JOIN_DOC /
  DOC_EVENT / ERROR.)_
- [ ] `Storage` trait with one filesystem implementation. Methods:
  `list_docs`, `get_doc`, `put_doc`, `delete_doc`, `append_update`,
  `put_blob`, `get_blob`. Postgres/S3 are not in scope. _(Deferred:
  premature abstraction without a second backend. Existing
  `DocumentStore` + `BlobStore` already encapsulate the same surface
  area; introduce the trait when a second backend lands.)_
- [-] Auth: local users only. Email + argon2 password hash. JWT
  signed with HS256 using a per-deploy secret in the config file.
  Design the user record so `org_id` can be added later without
  migration pain (single "default" org for now). _(Slice D.1 lands
  the per-deploy HS256 secret; `User.org_id: Option<String>` plumbed
  through the `users.json` serde with a single `"default"` org
  constant. argon2 swap remains deferred per decision #4 — bcrypt
  stays for v2.)_
- [x] Config: single TOML at `./relay.toml` (`--config` flag override).
  _(Slice D.1 — `relay/src/config.rs` with `[server]`, `[storage]`,
  `[auth]`, `[mcp]` sections; `relay init` rolls a fresh 32-byte
  hex JWT secret; `relay serve --port` and `--data-dir` override
  the file. `deny_unknown_fields` everywhere so typos fail loudly.)_

**Tauri changes (becomes a pure client):**

- [x] Delete `src-tauri/src/server/` and `src-tauri/src/mcp/` after
  lift. _(Slice E.4 — also dropped `auth/`; `src-tauri/src/lib.rs`
  slimmed from 897→160 LOC with only `open_docs` and its bundled-docs
  HTTP helpers surviving.)_
- [x] Delete `LocalDocumentMirror` and its callers in `persistenceStore`.
  MCP no longer sees local docs by design. _(E.4 — `mcpMirror*`
  calls + import removed; App.tsx boot-time bulk-mirror block
  deleted.)_
- [x] Renderer config UI: Relay URL + credentials. _(Slice E.5 — new
  Relay tab in Settings, URL pre-filled to `http://localhost:9876`
  per decision #1, login screen each launch per decision #2.
  `useRelayStore`, `AuthGuard`, `LoginPage`, `CollaborationSettings`,
  `ClientConnectionPanel`, `RelayMembersManager` all deleted.)_
- [x] `UnifiedSyncProvider` connects to the relay's single sync port
  (not `/sync/:doc_id`; decision #3); CRUD moves to `RelayClient`
  (Slice E.1). _(Slice E.2 — WS now pure CRDT/awareness/auth;
  `RestDocumentProvider` wraps `RelayClient` for all CRUD; JWT
  persistence + 401 toast wired via `RelayClient.onUnauthorized`.)_
- [x] Remove LAN discovery code. _(Slice E.5 — host/client mode
  toggle, member list, and "be a host" affordance all gone; sidebar
  badge is now a status indicator that opens the Relay tab.)_

**Migration (team docs → local docs):**

- [x] First-launch scan of `<app-data-dir>/team_documents/`. _(Slice F
  — `src/migrations/teamDocumentMigration.ts` uses
  `@tauri-apps/plugin-fs`; strips relay-only fields, writes to local
  persistence, moves source to `_archived_team_documents/`.)_
- [x] One-time toast notification. _(Slice F —
  `useNotificationStore.info` with `category: 'permanent'`, gated by
  the `docushark-team-doc-migration-done` localStorage flag.)_
- [x] Fixture set of beta team documents. _(Slice F — 9 unit tests
  with an in-memory `MigrationFs` adapter covering full migration,
  field stripping, malformed files, idempotency, and the no-op
  flag-set path.)_

**Deploy story (must be boring):**

- [x] Default config = filesystem storage in `./data/`, listen on
  `:9876`. No TLS, no Postgres, no Redis out of the box.
  _(Slice D.1 — `RelayConfig::default()` returns exactly this shape.)_
- [x] Dockerfile in `/relay/` + one-command run line in README
  (`docker run -v ./data:/data -p 9876:9876 docushark/relay`).
  _(Slice G — multi-stage rust:1.83-bookworm builder ->
  debian:bookworm-slim runtime with tini + non-root user.)_
- [x] systemd unit file template for bare-metal installs.
  _(Slice G — `relay/relay.service` with hardening defaults.)_
- [x] Smoke test: `relay init && relay serve` works on a fresh
  machine with only the Rust toolchain installed.
  _(Slice G — `relay/tests/smoke.rs` exercises register / login /
  /auth/me / /docs CRUD end-to-end against an in-process server on
  an OS-assigned port; 3 tests, 1.5s runtime.)_

**Load-bearing invariants (tested, not hoped):**

- [x] `DocumentStore` is origin-blind. _(Slice H —
  `documentStore.imports.test.ts` statically asserts no
  relay/sync/auth/Tauri imports; 14 tests including self-tests for
  the matcher.)_
- [x] Local docs never touch the relay (no mirror, no MCP visibility).
  _(Slice H — `localDocumentIsolation.test.ts` stubs `globalThis.fetch`
  as a recorder, exercises new/save/load/delete/importJSON +
  5-edit session, asserts zero fetches; 7 tests.)_
- [x] Protocol fixtures round-trip in both `bun run test` and
  `cargo test --manifest-path relay/Cargo.toml`. _(Slice A — 18
  fixtures in `relay/tests/protocol-fixtures/`; both TS and Rust
  suites read them and fail loudly on field-rename drift.)_

### 20.4 - Live CRDT writes via `yrs` on the Relay (carry-over from 19.6)

Belongs on the Relay, not in Tauri. Defer until 20.3 is in place.

- [ ] Add `yrs` to `/relay/src/sync/`. Authoritative `Y.Doc` per
  active doc, hydrated from JSON snapshot, applies incoming SYNC,
  broadcasts updates.
- [ ] MCP write tools generate Yjs updates rather than rewriting JSON
  directly. Unblocks closed-doc edits and removes last-write-wins.
- [ ] Persistence: flatten Y.Doc → JSON on snapshot interval and on
  shutdown. JSON stays the durable wire format for backup/restore.

### 20.9 - 2.0 Release

- [ ] 2.0.0-beta.1 release notes (lead with Relay migration; explicit
  about Protected Local removal and MCP-only-sees-relay-docs)
- [ ] Migration guide in docs site
- [ ] Article: "Why we extracted the server"
- [-] 1.5.0 (beta) Released
- [x] Upload article my site
- [ ] Upload dev.to article

### Relay Architecture (reference)

```
Tauri Desktop (pure client)              Relay (/relay/, separate binary)
├ OS shell                                ├ HTTP API: /auth/* /docs /blobs
├ Renderer (Vite/React)                   ├ WebSocket: /sync/:doc_id
│  ├ Canvas, stores (origin-blind)        │  ├ SYNC (Yjs)
│  ├ Local store (IDB/localStorage)       │  └ AWARENESS
│  └ Relay client (URL + JWT)             ├ MCP endpoint: /mcp (Bearer JWT)
└ Local docs: never touch the network     ├ Auth: email + password → JWT
                                          ├ Storage trait
                                          │  └ default: filesystem
                                          │     (per-doc JSON + update log)
                                          └ Single binary, single config file
```

**Non-goals for phase 20:** horizontal scalability, SSO/SAML/SCIM,
encryption at rest, webhooks/audit/hooks dispatcher, Postgres/S3
storage backends. All deferred to enterprise tier or future phases.

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
      /docs/docushark.json)
- [ ] Feat: Spawn a VS Code instance with access to Git repo

### Future: AI Model Integration

#### Architecture: Semantic Abstraction Layer

AI should reason about **relationships and entities**, not coordinates. The app handles spatial layout.

**AI Output Schema** (no X/Y coordinates):

```typescript
interface AIGraphOutput {
  diagram_type: "flowchart" | "erd" | "class-diagram" | "sequence" | "network";
  nodes: Array<{
    id: string;
    type: string; // maps to shape type
    label: string;
    attributes?: string[]; // for ERD entities, class members, etc.
  }>;
  edges: Array<{
    from: string; // node id
    to: string; // node id
    label?: string;
    cardinality?: "one-to-one" | "one-to-many" | "many-to-many";
  }>;
  layout_hint?: "hierarchical" | "force-directed" | "grid" | "radial";
}
```

**Near-Node Placement** (for incremental edits):

```typescript
interface PlacementHint {
  near: string; // existing shape ID or label
  direction: "above" | "below" | "left" | "right" | "auto";
  offset?: "compact" | "normal" | "spacious";
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

### Future: DocuShark Enterprise

Tracked in Linear, not in this file:
https://linear.app/justins-awesome-apps/document/docushark-enterprise-deferred-scope-cf4babf4a3a3

Covers the scalable collaboration server, cloud storage connectors,
enterprise plugins (webhooks/audit/SSO/RBAC/retention), E2E encryption
& compliance, and advanced observability. Not on the OSS engine or
managed-relay roadmap.

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
- [ ] **Export workflows (PNG/SVG/PDF)** — Show export options, scale settings, PDF cover page configuration, and .docushark archive creation. Complements `guide/export-import.md`.
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

| Module                           | Tests    |
| -------------------------------- | -------- |
| Math (Vec2, Mat3, Box, geometry) | 204      |
| Camera                           | 58       |
| InputHandler                     | 41       |
| Renderer                         | 33       |
| SpatialIndex                     | 24       |
| HitTester                        | 24       |
| DocumentStore                    | 37       |
| SessionStore                     | 41       |
| PageStore                        | 32       |
| HistoryStore                     | 19       |
| Rectangle                        | 21       |
| Ellipse                          | 25       |
| Line                             | 23       |
| Connector                        | 36       |
| Shape transforms                 | 31       |
| Shape bounds                     | 24       |
| Collaboration (protocol, sync)   | 200+     |
| Storage (cache, trash, versions) | 80+      |
| connectionStore                  | 26       |
| Sequence Diagram Shapes          | 57       |
| Activity Diagram Shapes          | 71       |
|                                  |          |
| **Total**                        | **1408** |
