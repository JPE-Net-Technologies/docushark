# AGENTS.md

This file provides guidance to any AI coding agents such as OpenCode, GitHub Copilot, Claude Code, Cursor, etc. when working with code in this repository.

## Project Overview

**DocuShark** is a high-performance diagramming and whiteboard application built with TypeScript, React, and Canvas API, targeting 10,000+ shapes at 60fps. Prioritizes correctness, extensibility, and performance. Runs as both a web app (Vite) and a desktop app (Tauri with Rust backend), with a standalone Rust relay server (`docushark-relay`) for multi-user collaboration, JWT auth, and MCP.

> The project was previously named **Diagrammer**. The OSS engine and the user-facing product are now both **DocuShark**; the Diagrammer name is retired. Some inline comments still reference the old name — they're being cleaned up incrementally and are safe to update on sight.

### Cloud Provider Icon Licensing
This tool includes official service icons for AWS, Azure, and Google Cloud.
Icons are used **solely for architectural diagrams and technical documentation**, in accordance with each provider’s permitted‑use guidelines.  
All trademarks and rights remain with their respective owners.

## Backwards Compatibility & Document Safety

DocuShark is currently **pre-GA** on the `v2` branch — there are no shipped v2 releases or users with v2 documents in the wild. The v1 Diagrammer GitHub releases were retired with the brand collapse and are not part of the v2 compatibility surface.

### What this means right now (pre-GA, v2.0.0-beta.N)

- **Breaking changes are allowed** if a tested document migration in `/src/migrations/` lands in the same change. The bar is "no developer or future user is surprised by silent data loss," not "the wire/storage format is frozen."
- Migrations must be **idempotent**, **logged**, and **tested** against a fixture of the pre-change format. See `src/migrations/teamDocumentMigration.ts` + its tests as the canonical pattern.
- Wire-protocol changes still bump `PROTOCOL_VERSION` in both `src/collaboration/protocol.ts` and `relay/src/server/protocol.rs`, with matching fixtures under `relay/tests/protocol-fixtures/`.

### What this means at GA (v2.0.0 and after)

Once v2.0.0 ships:

- **Document format**, **wire protocol**, and **storage keys** are frozen within a major version. Breaking changes require a major-version bump.
- Deprecated APIs stay functional for at least one major-version cycle, with `Deprecation` warnings in code and release notes.
- Shape types are never removed — only marked deprecated and kept rendering.

### Always-on document safety rules (pre-GA and post-GA)

- **Never lose data**: if a field is removed or renamed, migrate it to the new structure.
- **Version tracking**: documents have a `version` field — bump it and add a migration in `/src/migrations/`.
- **Test migrations**: every document format change needs tests with old-document fixtures.
- **Blob references**: never orphan blobs — update `BlobGarbageCollector` if blob reference patterns change.
- **Settings**: new settings have defaults that preserve existing behavior.
- **Store changes**: new fields are optional with sensible defaults so partial in-memory state can be hydrated from older snapshots without crashing.

## Technology Stack

- **Runtime**: Bun (package manager and JS runtime — not Node.js)
- **Desktop**: Tauri v2 (Rust backend: Axum + Tokio WebSocket server, JWT auth, file system)
- **Language**: TypeScript (strict mode), Rust (Tauri backend)
- **UI Framework**: React 18+ (UI chrome only — canvas rendering is pure Canvas 2D API)
- **State Management**: Zustand with Immer middleware
- **Collaboration**: Yjs CRDTs over WebSocket
- **Rich Text**: Tiptap (ProseMirror wrapper)
- **Spatial Indexing**: RBush (R-tree)
- **Build**: Vite (frontend), Cargo (Rust)
- **Testing**: Vitest (jsdom environment, globals enabled)

## Development Commands

```bash
# Install dependencies
bun install

# Development server (web only)
bun run dev

# Type checking
bun run typecheck

# Run all tests (watch mode)
bun run test

# Run all tests once
bun run test --run

# Run a single test file
bun run test src/engine/Camera.test.ts

# Run tests with Vitest UI
bun run test:ui

# Build for production (web)
bun run build

# Tauri desktop development (requires Rust toolchain)
bun run tauri:dev

# Build desktop application
bun run tauri:build

# Check Rust backend compiles
cargo check --manifest-path src-tauri/Cargo.toml

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml
```

A `Taskfile.yml` is also available for use with [Task](https://taskfile.dev/) — `task check` runs typecheck + all tests.

### Tauri Requirements

Desktop development requires Rust toolchain (via [rustup](https://rustup.rs/)) and platform-specific dependencies (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)).

## TypeScript Configuration

- **Path alias**: `@/*` maps to `./src/*` (configured in both `tsconfig.json` and `vite.config.ts`)
- **Strict flags beyond standard `strict: true`**: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- These flags mean: index access returns `T | undefined`, optional properties must use `undefined` explicitly, and all variables/params must be used

## Testing

Tests use Vitest with jsdom environment. Config is inline in `vite.config.ts` (no separate vitest config file). Test globals (`describe`, `it`, `expect`) are available without imports.

Test files live alongside source code with `.test.ts` suffix (1045 tests across 32 files):
- `/src/math/` — Vec2, Mat3, Box, geometry (204 tests)
- `/src/engine/` — Camera, InputHandler, Renderer, SpatialIndex, HitTester
- `/src/store/` — DocumentStore, SessionStore, PageStore, HistoryStore, connectionStore
- `/src/shapes/` — Shape handlers and utilities (bounds, transforms)
- `/src/collaboration/` — Protocol, UnifiedSyncProvider, OfflineQueue, SyncStateManager
- `/src/storage/` — TeamDocumentCache, TrashStorage
- `/src/types/` — VersionConflict utilities

## Architecture Layers

```
React UI Layer (Toolbar, PropertyPanel, LayerPanel, SettingsModal)
    ↓
Bridge Layer (CanvasContainer.tsx - mounts canvas, forwards events)
    ↓
Engine Core (Camera, Renderer, InputHandler, ToolManager, SpatialIndex, ShapeRegistry, HitTester)
    ↓
Store Layer (Zustand stores — see below)
    ↓
Storage Layer (localStorage for state, IndexedDB for blobs via BlobStorage)
    ↓
Tauri Backend (src-tauri/ — native file system, WebSocket server, authentication)
```

### Store Separation

Zustand stores are split by responsibility:

**Core stores** (`/src/store/`):
- **DocumentStore**: Shape data, connections, groups — the single source of truth for document content
- **SessionStore**: Selection, camera state, active tool, cursor — ephemeral UI state
- **HistoryStore**: Undo/redo with complete document snapshots
- **PageStore**: Multi-page document structure and ordering
- **PersistenceStore**: Document save/load, auto-save, localStorage management

**Collaboration stores** (`/src/store/` and `/src/collaboration/`):
- **connectionStore**: WebSocket connection state, auth status, reconnection
- **collaborationStore**: Session management, remote users
- **presenceStore**: Real-time cursor and selection state from other users
- **teamStore / teamDocumentStore / userStore**: Server mode, team documents, authentication
- **documentRegistry**: Unified document index for local/remote/cached documents

**Feature stores**: Theme, style profiles, color palettes, icon library, shape libraries, settings, notifications, UI preferences — each in its own file under `/src/store/`.

### Storage Layer

Hybrid storage: localStorage for document metadata and preferences, IndexedDB for binary blobs.

`/src/storage/BlobStorage.ts` provides content-addressed storage using SHA-256 hashing with automatic deduplication and reference counting. `BlobGarbageCollector` cleans up orphaned blobs.

Additional storage utilities:
- **TeamDocumentCache**: IndexedDB cache for offline access to team documents with LRU eviction
- **TrashStorage**: Soft-delete with configurable retention for document recovery
- **AtomicFileWriter**: Write-to-temp-then-rename pattern for crash-safe file operations
- **StorageQuotaMonitor**: Proactive storage usage monitoring with warnings
- **AssetBundler**: Embeds blob:// references as base64 for document transfer over network

### Collaboration Architecture

Real-time multi-user editing via "Protected Local" mode. The Tauri host runs a WebSocket server (`src-tauri/src/server/`); clients connect via `UnifiedSyncProvider` which multiplexes CRDT sync (Yjs), document CRUD, and JWT auth over a single WebSocket.

**Critical**: The TypeScript protocol (`/src/collaboration/protocol.ts`) must stay in sync with the Rust protocol (`src-tauri/src/server/protocol.rs`). Message types include: SYNC (0), AWARENESS (1), AUTH (2), DOC_LIST/GET/SAVE/DELETE (3-6), DOC_EVENT (7), JOIN_DOC (10), AUTH_LOGIN (11).

**Authoritative relay Y.Doc (JP-34):** the standalone relay (`relay/src/sync/`)
now holds an authoritative server-side `Y.Doc` (the `yrs` crate) per active
document. On `JOIN_DOC` it hydrates the doc's active page from the JSON snapshot
and answers the joining client's `SyncStep1` with authoritative state; inbound
SYNC frames are applied to the Y.Doc and rebroadcast to peers. This makes the
relay the source of truth (removing whole-document last-write-wins) — it is a
**behavior** change only: the wire frames are unchanged lib0-v1 sync bodies and
`PROTOCOL_VERSION` does **not** move. The relay Y.Doc's shared types
(`shapes` map, `shapeOrder` array, `metadata` map) must keep mirroring
`src/collaboration/YjsDocument.ts`. Persisting the Y.Doc back to JSON is a
separate, later step (the eviction hook in `relay/src/sync/mod.rs` is currently
a no-op).

**Offline-first architecture**:
- **OfflineQueue**: Queues save/delete operations when disconnected, processes on reconnect
- **SyncStateManager**: Coordinates queue, storage, and connection state with auto-retry
- **SyncQueueStorage**: IndexedDB persistence for durability across app restarts

### Coordinate System

All coordinate transforms flow through the Camera class. Never manually apply pan/zoom.

```
Screen Space (canvas pixels)
  → camera.screenToWorld(point) → World Space (infinite 2D plane)
  → shape.worldToLocal(point)   → Local Space (for rotated shapes)
```

### Shape System

Shapes are plain data objects. Behavior is implemented via the **ShapeRegistry pattern**:
- Each shape type registers handlers for: `render`, `hitTest`, `getBounds`, `getHandles`, `create`
- Shape data extends `BaseShape` interface with type-specific properties
- No methods on shape objects — all behavior is external
- Shape metadata (`/shapes/ShapeMetadata.ts`) provides property definitions for dynamic PropertyPanel rendering

Shape library tiers: basic shapes (Rectangle, Ellipse, Line, Text, Connector, Group), flowchart shapes (`/shapes/library/`), UML shapes, and user-created custom libraries (stored in IndexedDB).

### Tool Architecture

- Tools are state machines responding to normalized input events (`NormalizedPointerEvent` with both screenPoint and worldPoint)
- One tool active at a time via ToolManager
- Tools receive `ToolContext` with camera, stores, hitTester, requestRender
- Tools can render overlays (selection boxes, guides) in screen space

## Critical Implementation Rules

- **Coordinate transforms**: Always use `camera.screenToWorld()` / `camera.worldToScreen()`. Never manually apply pan/zoom.
- **State mutations**: All document mutations through Immer. Never mutate state directly. DocumentStore is the single source of truth.
- **Canvas rendering**: React handles UI chrome only. Canvas rendering uses requestAnimationFrame in Engine core. Apply camera transform once per frame. Implement viewport culling.
- **Hit testing**: Use SpatialIndex (RBush) for candidates, then precise hit test. Respects z-order (`shapeOrder` array). Rebuild spatial index when shapes change.
- **Input handling**: InputHandler normalizes mouse/touch/pen. Handle pointer capture on down, release on up. Prevent default on wheel events.

## MCP (Model Context Protocol) Integration

The MCP server lives in the standalone relay at `relay/src/mcp/` (it was
extracted from `src-tauri/` along with the rest of the sync server). It lets
external MCP clients (Claude Code/Desktop, Cursor, Zed, etc.) create and
manipulate documents over an HTTP endpoint (default `127.0.0.1:9877/mcp`,
gated by a bearer token — the static MCP token or a relay JWT). The full tool
reference is **`relay/docs/mcp/README.md`** — keep it in sync when changing the
surface.

The surface is no longer shape-only: an agent can `create_document`, write
prose (`set_prose`/`add_prose_page`, Markdown → HTML), restructure an outline
(`get_outline`/`insert_section`/`restructure_outline`), and build diagrams
(`add_shape`/`add_shapes`/`connect`/`update_shape`, plus `generate_diagram` for
a whole node/edge graph). A document carries both a canvas (`pages` → shapes)
and prose (`richTextPages`, HTML).

**Two-tier document model — enforced, not advisory:**

- **Team documents** (relay-stored under `relay_documents/workspaces/<ws>/docs/`).
  Writable via MCP and scoped to the request's workspace (static token →
  `single_tenant`; JWT → its `wsp` claim). Writes broadcast `DocEvent::Updated`
  so a running app reloads.
- **Local documents** (renderer-owned, mirrored read-only into the
  per-workspace layout). Read-only via MCP under all conditions — enforced
  server-side by `reject_if_local` in `relay/src/mcp/tools.rs`, not a UI
  toggle. The mirror lets clients *review* personal documents without mutating
  them.

**When adding MCP tools that write,** call `ctx.team` (never `ctx.local`),
guard with `reject_if_local`, and persist through `mutate_with_retry` so the
optimistic-concurrency (`serverVersion`) check protects live collaborators.
The existing write tools are the reference pattern.

**When extending the DSL adapter** (`relay/src/mcp/adapter.rs`), keep field
names and defaults in sync with the TS handlers in `src/shapes/*.ts`
(DEFAULT_SHAPE_STYLE / DEFAULT_RECTANGLE / etc.). Drift will show up as a
diff between MCP-created shapes and toolbar-created shapes.

## Code Style

1. **No `any` types** — Use `unknown` and type guards
2. **Immutable updates** — Enforced by Immer
3. **Pure functions** — Shape handlers should be pure where possible
4. **Small, focused files** — One clear responsibility per file
5. **Explicit over implicit** — Verbose, clear code over clever shortcuts
6. **Test the math** — Vec2, Mat3, Box, geometry functions require unit tests

## Implementation Status

Active and future work is tracked in the project's internal board, not in this repo. Completed phases live in `docs-site/developer/roadmap.md`.

## UI Layout

The editor shell is driven by the **layout manager** in `src/ui/layout/`. The
top-level structure is a flex row of dockable panels around the canvas, with
an optional in-app titlebar above the toolbar when the user opts into custom
window chrome.

```
┌─────────────────────────────────────────────────────┐
│  TitleBar (28px, OPTIONAL — opt-in custom chrome)   │
├─────────────────────────────────────────────────────┤
│  Unified Toolbar (~44px)                            │
│  [Tools][PageTabs...][LayoutChip][Settings]         │
├──────────────────┬──────────┬───────────────────────┤
│  Document        │  Canvas  │  Properties           │
│  (DockedPanel,   │          │  (docked OR fly-out   │
│   left|right|    │          │   overlay; left|right │
│   hidden)        │          │   |hidden per layout) │
│                  │  Layers  │                       │
│                  │  (chip)  │                       │
├──────────────────┴──────────┴───────────────────────┤
│  Status Bar (coords, zoom, shape count, tool)       │
└─────────────────────────────────────────────────────┘
```

### Four named layouts

The four layouts in `src/ui/layout/modes.ts` map to the wedge personas:

| Mode | Document | Canvas | Properties | Persona |
|------|----------|--------|------------|---------|
| `relaxed` (default) | primary (reading column) | secondary, focus switch | hidden (on selection) | Personal — writing |
| `designer` | hidden, toggle | dominant | fly-out (auto-collapse) | Personal — diagramming |
| `technician` | left, split | split | fly-out (auto-collapse) | Researcher / mid-power |
| `power` | left, split | split | docked, pinned | Power-User |

Switch via the **layout selector** chip in the toolbar, `Cmd+Shift+1..4`, or
the command palette ("Switch to … layout"). Zen is a backlog item (Linear).

In **Relaxed** the document editor is the *primary* region (a centered reading
column), not a sidebar. A `Write · Split · Diagram` segmented control
(`RelaxedFocusControl`, toolbar-only in Relaxed; also `Cmd+Shift+\` and a
command-palette entry) switches focus between prose-only, prose + secondary
canvas, and canvas-primary. The focus is ephemeral app-level state
(`sessionStore.relaxedFocus`); `resolveRegions(mode, focus, band)` in
`modes.ts` maps it (plus the viewport band from `useBreakpoint`) to which region
is primary — a `compact` viewport forbids split, the single-pane shape a future
mobile (PWA) layout reuses.

### Persistence model

Layout is an **app-level** concern — a single active mode for the whole editor,
not keyed per document. All layout state lives in the `layout` slice on
`uiPreferencesStore` (`docushark-ui-preferences` localStorage key, version 3):

- `defaultMode` — the single active layout for the app.
- `modeOverrides[mode][panelId]` — user customization deltas scoped per
  layout. Moving Properties to the left in Technician does not move it in
  Power.
- `customChrome` — opt-in for the in-app TitleBar; reload required to apply.

(An earlier design kept a per-document `perDoc` map here; it coupled UI prefs to
document identity and was removed in the v3 migration. A document that needs to
*suggest* a layout should carry that in its own isolated metadata, not this UI
slice.)

### Key components

- `src/ui/layout/types.ts` — `LayoutMode`, `PanelId`, `DockSide`, `PanelState`,
  `LayoutState`. Source of truth for the contract.
- `src/ui/layout/modes.ts` — `LAYOUT_PRESETS` table + `resolvePanelState`
  merger + labels / descriptions. Pure data, no React.
- `src/ui/layout/useLayout.ts` — hooks: `useActiveLayoutMode`,
  `useActivePanelState`, `useLayoutActions` (infers current doc + mode at
  call time). Most UI consumes these.
- `src/ui/layout/FlyoutPanel.tsx` — rail + slide-out overlay; respects
  `prefers-reduced-motion`, traps focus when expanded. Used by Properties
  in Designer + Technician unless pinned.
- `src/ui/layout/DockedPanel.tsx` — resizable wrapper for the Document
  panel; writes drag-induced width back to `modeOverrides`.
- `src/ui/layout/LayoutSelector.tsx` — toolbar chip with thumbnail-preview
  dropdown. Footer hosts the custom-chrome toggle and "Customize layout…"
  link to Settings.
- `src/ui/layout/PanelChromeWrapper.tsx` + `PanelChromeMenu.tsx` —
  right-click on a panel header for Move to left / right / Hide / Pin.
- `src/ui/settings/LayoutSettings.tsx` — Settings → Layout tab; per-panel
  dock dropdowns per layout, reset button.
- `src/ui/chrome/TitleBar.tsx` + `WindowControls.tsx` — rendered only when
  `customChrome === true`. Tauri integration via `setDecorations(false)`
  synced from the store.

### Conventions when adding panels

Phase A treats `'document' | 'properties' | 'layers'` as the addressable
panel ids. Adding a new panel (e.g. an MCP tools panel) means:

1. Extend `PanelId` in `types.ts` and add the panel to `LAYOUT_PRESETS`
   for every layout (default to `dock: 'hidden'` for layouts where the
   panel is opt-in).
2. Render the panel in `App.tsx` conditional on its
   `useActivePanelState(...)`. Wrap in `<PanelChromeWrapper>` for
   right-click customization.
3. If the panel should fly out in Designer/Technician, wrap in
   `<FlyoutPanel>` when not pinned.

A plugin-aware `registerPanel` contract is on the backlog and will land
when the first non-core panel needs it (YAGNI today).

Plugin extensibility for shape libraries etc. still lives at
`/src/plugins/PanelExtensions.ts`.
