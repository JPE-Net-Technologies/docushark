# DocuShark

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Deploy Documentation](https://github.com/JPE-Net-Technologies/docushark/actions/workflows/docs.yml/badge.svg)](https://github.com/JPE-Net-Technologies/docushark/actions/workflows/docs.yml)
[![Build Release Artifacts](https://github.com/JPE-Net-Technologies/docushark/actions/workflows/release.yml/badge.svg)](https://github.com/JPE-Net-Technologies/docushark/actions/workflows/release.yml)

**The open-source engine behind DocuShark — a page-based document editor where prose, diagrams, data, and files live on the same page, with a built-in MCP server so AI agents can read and write your documents directly.**

Write in rich text, drop in a flowchart or an architecture diagram, attach
files, define reusable data fields and citations — then collaborate on it live,
or hand the whole document to an AI agent over MCP.

<!-- TODO(JP-412): hero screenshot / short GIF of the editor goes here.
     Add the asset under docs/ or .github/ and reference it above the fold. -->

## Try it

**[Open DocuShark free in your browser → app.docushark.app](https://app.docushark.app)**
No account required — documents you create in local mode never leave your device.

**[Read the docs → dev.docushark.app](https://dev.docushark.app/)**

> A desktop build (Tauri, offline-first) is in beta; the browser app is the
> recommended way to start today.

## What's inside

- **Prose and canvas in one document** — a rich-text editor (Tiptap /
  ProseMirror) alongside a high-performance Canvas 2D diagramming engine
  (targeting 10,000+ shapes at 60fps). Page-based, not two tools bolted
  together.
- **Diagramming** — flowchart, UML, and custom shape libraries, with
  auto-layout and smart connector routing. Import from **Mermaid, draw.io,
  and Excalidraw**.
- **Structured documents** — reusable document fields, citations, and
  file/blob attachments as first-class content.
- **Real-time collaboration** — CRDT sync (Yjs) over a self-hostable Rust
  relay that holds the authoritative document; offline-first by design.
- **MCP-native** — the relay ships a Model Context Protocol server, so agents
  (Claude Code/Desktop, Cursor, Zed, …) can create documents, write prose, and
  build diagrams programmatically. See
  [`relay/docs/mcp/README.md`](relay/docs/mcp/README.md).

## Quick start

```bash
bun install
bun run dev          # web dev server
bun run tauri:dev    # desktop dev
bun run test         # vitest
bun run build        # web build
bun run tauri:build  # desktop build
```

## Repository layout

```
src/                 React canvas editor (also the PWA target)
src-tauri/           Tauri v2 desktop wrapper (Rust)
relay/               docushark-relay — standalone sync + REST + MCP server (Rust)
docs-site/           VitePress source for dev.docushark.app
```

See [`AGENTS.md`](AGENTS.md) for tech stack details, dev commands, testing
conventions, backwards-compatibility rules, and the migration policy for
document format changes. See [`relay/README.md`](relay/README.md) for relay
deploy + ops.

## License

[GNU Affero General Public License v3.0 or later](LICENSE).

DocuShark is open-core. This repository (engine, desktop, relay, docs) is
AGPL-3.0; the managed **DocuShark Cloud** service (hosted relay + account
portal) is a separate proprietary codebase.

If you run a modified version as a network service, AGPL-3.0 requires you
to release your modifications. Self-hosting for your own use is
unrestricted. For commercial-use exceptions or an enterprise license,
contact the maintainers.

> **Previously MIT.** Relicensed to AGPL-3.0-or-later as part of the
> open-core / managed-SaaS direction. All prior MIT-licensed contributions
> were sublicensed under AGPL-3.0 by the project owner, which MIT permits.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Contributions are accepted on an
inbound = outbound basis under AGPL-3.0-or-later.

---

Cloud provider service icons (AWS, Azure, GCP) bundled with this app are
used solely for architectural diagrams in accordance with each provider's
permitted-use guidelines. All trademarks remain with their respective
owners.
