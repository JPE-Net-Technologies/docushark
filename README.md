# DocuShark

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Deploy Documentation](https://github.com/JPE-Net-Technologies/docushark/actions/workflows/docs.yml/badge.svg)](https://github.com/JPE-Net-Technologies/docushark/actions/workflows/docs.yml)
[![Build Release Artifacts](https://github.com/JPE-Net-Technologies/docushark/actions/workflows/release.yml/badge.svg)](https://github.com/JPE-Net-Technologies/docushark/actions/workflows/release.yml)

The open-source DocuShark engine: a high-performance technical diagramming
and docs editor. Runs as a Tauri desktop app or in the browser, talks to a
self-hostable Rust relay for real-time collaboration.

**[Download the latest release →](https://github.com/JPE-Net-Technologies/docushark/releases)**
&nbsp;·&nbsp; **[Documentation →](https://dev.docushark.app/)**

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
AGPL-3.0; the managed **DocuShark Cloud** control plane (marketing,
billing, account portal, relay provisioning, premium integrations) is a
separate proprietary codebase.

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
