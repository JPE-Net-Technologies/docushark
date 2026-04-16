# AGENTS.md — Diagrammer

## Critical Rules

- **Bun, not Node.js** — `bun` is the JS runtime and package manager
- **Document format is sacred** — v1.0.0-beta.1 is released; all changes must be backwards-compatible. Document migrations go in `/src/migrations/` with version bumps
- **Protocol sync** — `src/collaboration/protocol.ts` and `src-tauri/src/server/protocol.rs` must stay in sync (message type constants)

## Commands

```bash
# Single-command verification (fastest feedback)
bun run typecheck              # TS type check
bun run test --run            # all tests once
cargo check --manifest-path src-tauri/Cargo.toml  # Rust compile check

# Task runner shortcuts
task check                    # typecheck + tests (both JS and Rust)
task dev                      # Tauri desktop dev (NOT just `bun run dev`)

# Single test file
bun run test src/engine/Camera.test.ts
```

## Architecture Notes

- **Canvas rendering** — React is UI chrome only; canvas uses `requestAnimationFrame` in engine core
- **Coordinate transforms** — Always `camera.screenToWorld()` / `camera.worldToScreen()`; never manually apply pan/zoom
- **State mutations** — All document changes through Immer; DocumentStore is the single source of truth
- **Shape system** — Shapes are plain data; behavior via ShapeRegistry handlers (`render`, `hitTest`, `getBounds`, etc.)

## TypeScript Strict Flags

Beyond standard `strict: true`: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`. Index access returns `T | undefined`.

## CI Verification Order

PR checks run: `typecheck` → `test --run` → `docs build` → `cargo check` → `cargo test`

## Directory Ownership

| Directory | Purpose |
|-----------|---------|
| `src/engine/` | Camera, Renderer, InputHandler, SpatialIndex, HitTester |
| `src/store/` | Zustand stores (DocumentStore, SessionStore, etc.) |
| `src/collaboration/` | Yjs CRDT sync, WebSocket protocol |
| `src/storage/` | BlobStorage, TeamDocumentCache, TrashStorage |
| `src/shapes/` | ShapeRegistry, shape handlers, libraries |
| `src-tauri/src/server/` | Rust WebSocket server, JWT auth |
