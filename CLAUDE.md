# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A high-performance diagramming and whiteboard application built with TypeScript, React, and Canvas API, targeting 10,000+ shapes at 60fps. Prioritizes correctness, extensibility, and performance. Runs as both a web app (Vite) and a desktop app (Tauri with Rust backend).

### Cloud Provider Icon Licensing
This tool includes official service icons for AWS, Azure, and Google Cloud.
Icons are used **solely for architectural diagrams and technical documentation**, in accordance with each provider’s permitted‑use guidelines.  
All trademarks and rights remain with their respective owners.

## CRITICAL: Backwards Compatibility & Document Safety

**Since v1.0.0-beta.1 is released, all changes MUST be backwards-compatible and protect user documents.**

### Document Safety Requirements

- **Document format changes**: Must include automatic migration code that runs on load
- **Never lose data**: If a field is removed or renamed, migrate it to the new structure
- **Version tracking**: Documents have a `version` field — bump it and add migration in `/src/migrations/`
- **Test migrations**: Every document format change needs tests with old document fixtures
- **Blob references**: Never orphan blobs — update `BlobGarbageCollector` if blob reference patterns change

### Backwards Compatibility Rules

- **Store changes**: New fields must be optional with sensible defaults
- **API changes**: Deprecated functions must remain functional with console warnings
- **Protocol changes**: WebSocket protocol must handle older message formats gracefully
- **Settings changes**: New settings must have defaults that preserve existing behavior
- **Shape type changes**: Never remove shape types — mark as deprecated, keep rendering

### When Breaking Changes Are Unavoidable

1. Implement automatic migration that runs transparently on document load
2. Add version detection to handle both old and new formats
3. Log migration events for debugging (but don't alarm users)
4. Test with real documents from earlier versions
5. Document the migration path in release notes

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

## Code Style

1. **No `any` types** — Use `unknown` and type guards
2. **Immutable updates** — Enforced by Immer
3. **Pure functions** — Shape handlers should be pure where possible
4. **Small, focused files** — One clear responsibility per file
5. **Explicit over implicit** — Verbose, clear code over clever shortcuts
6. **Test the math** — Vec2, Mat3, Box, geometry functions require unit tests

## Implementation Status

See `Todo.md` for detailed phase tracking and current tasks.

## UI Layout

```
┌─────────────────────────────────────────────────────┐
│  Unified Toolbar (~44px)                            │
│  [Tools][PageTabs...][Rebuild][Settings]            │
├──────────────────┬──────────────────────────────────┤
│  Document Editor │  Canvas Area                     │
│  (resizable)     │                      PropertyPanel│
│  ┌──────────────┐│                       (collapsible)
│  │Tiptap Editor ││                      LayerPanel  │
│  └──────────────┘│                       (collapsible)
├──────────────────┴──────────────────────────────────┤
│  Status Bar (coords, zoom, shape count, tool)       │
└─────────────────────────────────────────────────────┘
```

Plugin extensibility: `/src/plugins/PanelExtensions.ts` registry pattern allows extending UI panels without modifying core components.
