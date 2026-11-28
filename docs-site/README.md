# DocuShark Docs (VitePress)

Source for [docs.docushark.app](https://docs.docushark.app), built with [VitePress](https://vitepress.dev/).

## Commands

Run from `docs-site/`:

| Command | Action |
|---|---|
| `bun install` | Install dependencies |
| `bun run dev` | Start the local dev server |
| `bun run build` | Production build (online mode — fetches live data where applicable) |
| `bun run build:offline` | Production build without network calls — use this to verify changes locally |
| `bun run preview` | Preview a built site locally |

## Structure

- `guide/` + `tutorials/` — the user guide: one page per job (Start here, Start with what you do, Write, Draw, Organize, Share and collaborate, Make it yours, Export and import, Keyboard shortcuts), then the tutorials and the example gallery. Each page reads top to bottom on its own, and the whole sidebar fits on one screen; add a section to the page it belongs to rather than a new page. Sections that other pages or redirects point at carry explicit ids (`## Connectors {#connectors}`), so rewording a heading can't break a link.
- `.vitepress/sidebar.ts` — both sidebars (`guidesSidebar`, `developerSidebar`). It imports nothing, so plain Node tests can read it.
- `.vitepress/redirects.ts` — old URLs of merged or renamed pages, mapped to their new page and section; `buildEnd` writes a redirect page at each. `scripts/docs-guides.test.ts` (run with the main test suite) checks every sidebar link, redirect target and anchor.
- `developer/` — the **Build** section (customer-facing nav label "Build"; routes stay under `/developer/`). Scoped to two jobs: **Extend** (shapes, tools, UI features, plugins) and **Integrate** (REST/MCP consumption, building clients). The engine core + relay CRDT/sync internals are readable AGPL but deliberately *not* a documented extension surface here — see the "extension surface vs engine core" note in `developer/architecture.md`.
- `.vitepress/config.mts` — nav, breadcrumb JSON-LD, `llms.txt`/`llms-full.txt` generation and the redirects. Any new top-level nav section needs a sidebar array in `sidebar.ts`, a `resolveBreadcrumb` branch, and a `buildEnd` section here.
- `.vitepress/plugins/llms.ts` — generates `/llms.txt` + `/llms-full.txt` from the sidebar structures at build time.
- `scripts/capture-screenshots.cjs` — regenerates `public/screenshots/` from a production build of the app, with a fresh browser profile and the example documents; its header says how to run it. Refresh the pictures when the interface they show changes.
- `guide/shape-libraries.data.ts` — a VitePress build-time data loader that reads the shape/icon catalog directly from application source (`src/shapes/library/`, `scripts/gen-icon-catalog.ts`), so the shape catalogue on the Draw page never drifts from what's actually in the app.

See the repo root `AGENTS.md` (one directory up) for the DocuShark codebase's broader conventions.
