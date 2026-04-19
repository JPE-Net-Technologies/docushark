# Project Setup

This page covers everything you need to start developing Diagrammer locally.

## Prerequisites

1. **Bun** — JavaScript runtime and package manager ([bun.sh](https://bun.sh))
2. **Rust toolchain** — via [rustup](https://rustup.rs) (stable channel)
3. **Platform dependencies** — see [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)
4. **Task** *(optional)* — task runner ([taskfile.dev](https://taskfile.dev)) for convenient commands

::: details Linux (Debian/Ubuntu)
```bash
# System dependencies for Tauri
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev \
  librsvg2-dev patchelf
```
:::

::: details macOS
```bash
# Xcode command line tools (provides system headers)
xcode-select --install
```
:::

::: details Windows
Install the **Desktop development with C++** workload from [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
:::

## Getting the Code

```bash
git clone https://github.com/QR-Madness/diagrammer.git
cd diagrammer
bun install
```

## Development Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Start Vite dev server (web only) |
| `bun run tauri:dev` | Start Tauri desktop app with hot-reload |
| `bun run typecheck` | Run TypeScript type checking |
| `bun run test` | Run Vitest in watch mode |
| `bun run test --run` | Run all tests once |
| `bun run build` | Production web build |
| `bun run tauri:build` | Build desktop installer |
| `task check` | Run typecheck + all tests (requires Task) |

### Rust Backend

```bash
# Type-check the Rust backend
cargo check --manifest-path src-tauri/Cargo.toml

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml
```

## Project Layout

```
diagrammer/
├── src/                    # TypeScript source
│   ├── math/               # Vec2, Mat3, Box, geometry utilities
│   ├── engine/             # Camera, Renderer, InputHandler, SpatialIndex
│   ├── store/              # Zustand stores (Document, Session, History…)
│   ├── shapes/             # Shape handlers and libraries
│   ├── collaboration/      # Protocol, sync providers, offline queue
│   ├── storage/            # BlobStorage, TeamDocumentCache, TrashStorage
│   ├── ui/                 # React components (Toolbar, PropertyPanel…)
│   ├── tauri/              # Tauri command bindings
│   └── plugins/            # Panel extension registry
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── lib.rs          # Tauri commands, docs server, window setup
│   │   └── server/         # WebSocket server, protocol, auth
│   ├── Cargo.toml
│   └── tauri.conf.json     # Tauri build and window config
├── docs-site/              # VitePress documentation site
├── vite.config.ts          # Vite + Vitest config
├── tsconfig.json           # TypeScript config (strict mode)
└── Taskfile.yml            # Task runner definitions
```

## TypeScript Configuration

The project uses strict TypeScript with additional flags beyond `strict: true`:

| Flag | Effect |
|------|--------|
| `noUncheckedIndexedAccess` | Index access returns `T \| undefined` |
| `exactOptionalPropertyTypes` | Optional properties require explicit `undefined` |
| `noPropertyAccessFromIndexSignature` | Forces bracket notation for index signatures |
| `noUnusedLocals` / `noUnusedParameters` | Unused variables are errors |
| `noImplicitReturns` | All code paths must return |

The path alias `@/*` maps to `./src/*` and is configured in both `tsconfig.json` and `vite.config.ts`.

## Testing

Tests use **Vitest** with jsdom environment. Test globals (`describe`, `it`, `expect`) are available without imports. Test files live alongside source code with `.test.ts` suffix.

```bash
# Run a single test file
bun run test src/engine/Camera.test.ts

# Run tests with browser UI
bun run test:ui
```

| Module | Coverage |
|--------|----------|
| `/src/math/` | Vec2, Mat3, Box, geometry |
| `/src/engine/` | Camera, InputHandler, Renderer, SpatialIndex, HitTester, ToolManager |
| `/src/store/` | DocumentStore, SessionStore, PageStore, HistoryStore, connectionStore |
| `/src/shapes/` | Shape handlers, bounds, transforms, library shapes |
| `/src/collaboration/` | Protocol, sync providers, offline queue, SyncStateManager |
| `/src/storage/` | TeamDocumentCache, TrashStorage |
| `/src/types/` | VersionConflict utilities |

**Total: 1,427 tests across 45 files** (as of v1.3.0-beta.1).

::: tip
Run `task check` to typecheck and test in one command — this is what CI runs.
:::
