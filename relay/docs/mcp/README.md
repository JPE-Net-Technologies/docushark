# DocuShark Relay — MCP Tool Surface

The relay embeds a [Model Context Protocol](https://modelcontextprotocol.io)
server so external AI agents (Claude Code/Desktop, Cursor, Zed, ChatGPT,
Notion, and any other MCP-capable client) can **create and manipulate
DocuShark documents** — not just edit existing ones. This is the "publish
target" surface: an agent can author a real document, with prose *and*
diagrams, and a human drops into the editor when they want to touch it
visually.

This file is the authoritative reference for the MCP surface. The REST/WS wire
spec lives next door in [`../api/`](../api/README.md).

## Endpoint & transport

- **HTTP endpoint:** `POST /mcp`. JSON-RPC 2.0 over HTTP (streamable-HTTP MCP).
- **Send `Accept: application/json`.** If you send
  `Accept: text/event-stream`, the server replies with SSE framing; plain
  JSON clients should not advertise the event-stream type.

### Where it listens — `[mcp].expose`

| `expose` | Where `/mcp` lives | Use |
|---|---|---|
| `local` (default) | a loopback-only listener on `[mcp].port` (default **9877**) | desktop / self-host on one machine |
| `public` | folded onto the relay's **main** HTTP listener (the one already serving `/ws` + REST, `[server].port`) | a relay reachable over the network, so a remote MCP client can connect |

With `expose = "public"` there is no second port or TLS endpoint: `/mcp` and
its discovery doc ride the relay's real origin. `[mcp].port` is ignored. Set it
in `relay.toml` (`[mcp] expose = "public"`) or via `RELAY_MCP_EXPOSE=public`.

## Authentication

Every request carries `Authorization: Bearer <token>`. Two credential types
are accepted, tried in this order:

1. **Static MCP token** — a per-host bearer (generated on first run, persisted
   to `mcp_token` under the data dir, logged at startup). Authenticates as the
   single-tenant (`default`) workspace. This is the desktop / local default.
   **Refused when `expose = "public"`** — it resolves to the catch-all
   `default` workspace, so a network-reachable (potentially multi-tenant) pod
   accepts only the JWT below.
2. **Relay app token (JWT)** — an RS256 token minted by the OIDC issuer;
   validated via JWKS. The workspace is taken from the token's `wsp` claim
   (see [`../api/token-format.md`](../api/token-format.md)). This is how a
   multi-workspace deployment scopes an agent to one workspace.

A missing or invalid credential returns `401` with no disambiguation.

### OAuth discovery (self-serve auth)

So an MCP client can authenticate without a hand-pasted token, `/mcp` advertises
its authorization server per the MCP auth profile (`2025-06-18`):

- An unauthenticated `/mcp` request returns `401` with
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
- `GET /.well-known/oauth-protected-resource` (RFC 9728) returns the resource
  identifier (`<origin>/mcp`) and the configured authorization server
  (`[auth].issuer`). The client runs the auth-code + PKCE dance there and comes
  back with a JWT. The discovery URLs echo the origin the request arrived on
  (honoring `X-Forwarded-Proto` behind a TLS-terminating proxy), so they're
  correct whether reached on loopback or a public host.

## Document model

A DocuShark document carries **two surfaces in one object**:

- **Canvas pages** (`pages`) — the diagram: shapes and connectors.
- **Prose pages** (`richTextPages`) — the written body, stored as **HTML**.

The MCP tools operate on both. Prose is authored in **Markdown** by default
(agents produce it reliably) and rendered to the HTML the editor persists;
pass `format: "html"` to supply HTML directly.

## Tools

All tools are namespaced `docushark.*`.

### Read

| Tool | Purpose |
| -- | -- |
| `list_documents` | List documents in the workspace (`id`, `name`, `pageCount`, `modifiedAt`, `source`). |
| `get_document` | Document metadata + canvas `pages` summary + `prosePages` summary. The map of what exists. |
| `get_page` | The shapes on one canvas page, as DSL objects. |
| `get_prose` | All prose pages (or one, with `pageId`): `id`, `name`, `order`, HTML `content`. |
| `get_outline` | A prose page's heading outline: ordered `{ index, level, title }`. `index` is used by the structural tools. |

### Author

| Tool | Purpose |
| -- | -- |
| `create_document` | Create a new document (one blank canvas page + one blank prose page). Returns `{ id, name }`. The starting point for authoring from scratch. |

### Prose (write)

| Tool | Purpose |
| -- | -- |
| `add_prose_page` | Append a prose page. Markdown by default. |
| `set_prose` | Replace a prose page's entire body. Markdown by default. |
| `rename_prose_page` | Rename a prose page. |

### Structure (write)

| Tool | Purpose |
| -- | -- |
| `insert_section` | Insert a heading (+ optional body) at `start`/`end` or after a heading `index`. |
| `restructure_outline` | `promote`/`demote` a heading's level, or `move` a section to a new index. |

### Diagram (write)

| Tool | Purpose |
| -- | -- |
| `add_shape` | Add one shape (rectangle, ellipse, text, connector). |
| `add_shapes` | Add many shapes in one all-or-nothing call. |
| `connect` | Connect two existing shapes with a connector. |
| `update_shape` | Patch an existing shape (`x`, `y`, `w`, `h`, `text`, `style`). |
| `generate_diagram` | Build a whole diagram from a `nodes` + `edges` graph; the relay auto-positions (`layered` or `grid`) and wires connectors. |

## Concurrency

All write tools persist through an **optimistic-concurrency check** on the
document's `serverVersion`: a write reads the current version, applies its
mutation, and saves only if the version still matches, retrying on conflict.
A concurrent editor's live change is therefore never silently clobbered.

## Limits & current constraints

- **Local documents are read-only** via MCP. Renderer-owned (local) documents
  are mirrored read-only; writes target team documents only, and a write to a
  local id is refused with a clear message.
- **Prose is HTML.** Markdown in is rendered (GFM tables / strikethrough /
  task-lists on); HTML pass-through is re-parsed by the editor against its
  schema on load, which drops anything unmodelled.
- **Outlines are flat.** A section is a heading plus the content up to the
  next heading; nesting is conveyed by `level`, not containment. `move` moves a
  single section, not its descendants.
- **`generate_diagram` layout is relay-side and approximate** — a layered or
  grid placement, not the editor's full auto-layout. The editor can re-layout
  on open. Node caps: 500 nodes / 1000 edges per call.
- **No open-in-editor link yet.** `create_document` returns the document `id`;
  a deep link back into the editor is not yet wired.

## Example: author a document from scratch

```jsonc
// 1. create
{"method":"tools/call","params":{"name":"docushark.create_document",
  "arguments":{"name":"Architecture RFC"}}}
// → { "id": "doc-…" }

// 2. discover the page ids
{"method":"tools/call","params":{"name":"docushark.get_document",
  "arguments":{"docId":"doc-…"}}}
// → pages:[{id:"page-…"}], prosePages:[{id:"page-…"}]

// 3. write prose (Markdown)
{"method":"tools/call","params":{"name":"docushark.set_prose",
  "arguments":{"docId":"doc-…","pageId":"<prose page>",
  "content":"# Overview\n\n## Goals\n\n## Approach"}}}

// 4. draw a diagram
{"method":"tools/call","params":{"name":"docushark.generate_diagram",
  "arguments":{"docId":"doc-…","pageId":"<canvas page>",
  "nodes":[{"id":"client","label":"Client"},{"id":"relay","label":"Relay"}],
  "edges":[{"from":"client","to":"relay","label":"WebSocket"}]}}}
```

A runnable end-to-end smoke test of every tool lives in
[`../../scripts/mcp-smoke.sh`](../../scripts/mcp-smoke.sh).

## Per-provider verification

The bar for this surface is "smooth on every MCP provider," not "works on
one." Each provider should be able to (a) create a document, (b) generate a
structured diagram, and (c) restructure an outline. Status:

| Provider | Status |
| -- | -- |
| Claude Code | ✅ verified (create → prose → outline → diagram round-trip) |
| Claude Desktop | ☐ to verify |
| Cursor | ☐ to verify |
| Zed | ☐ to verify |
| ChatGPT (custom GPT) | ☐ to verify |
| Notion custom agents | ☐ to verify |
| Atlassian Rovo | ☐ to verify |

To add a provider: point it at `/mcp` on the relay (loopback
`http://127.0.0.1:9877/mcp` with `expose = "local"`, or the relay's origin
`https://<host>/mcp` with `expose = "public"`) with the bearer token, run the
three acceptance steps, and tick the box.
