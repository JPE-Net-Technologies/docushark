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

- `getting-started/` + `guide/` — the user-facing guides, sharing one sidebar (`guidesSidebar` in `.vitepress/config.mts`), ordered as a product-flow journey rather than an alphabetical feature list.
- `developer/` — technical reference for contributors extending DocuShark (architecture, shape/tool authoring, the collaboration protocol).
- `.vitepress/config.mts` — sidebar/nav structure, breadcrumb JSON-LD, and `llms.txt`/`llms-full.txt` generation. Any new top-level nav section needs a matching sidebar array, a `resolveBreadcrumb` branch, and a `buildEnd` section here.
- `.vitepress/plugins/llms.ts` — generates `/llms.txt` + `/llms-full.txt` from the sidebar structures at build time.
- `guide/shape-libraries.data.ts` — a VitePress build-time data loader that reads the shape/icon catalog directly from application source (`src/shapes/library/`, `scripts/gen-icon-catalog.ts`), so `shape-libraries.md` never drifts from what's actually in the app.

See the repo root `AGENTS.md` (one directory up) for the DocuShark codebase's broader conventions.
