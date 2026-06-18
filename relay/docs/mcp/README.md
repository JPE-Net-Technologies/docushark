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

A document may also carry a **reference library** (`references`) — citations as
**CSL-JSON** keyed by id, with an explicit display order — manipulated by the
citation tools below.

The MCP tools operate on both. Prose is authored in **Markdown** by default
(agents produce it reliably) and rendered to the HTML the editor persists;
pass `format: "html"` to supply HTML directly.

## Tools

All tools are namespaced `docushark.*`.

### Read

| Tool | Purpose |
| -- | -- |
| `list_documents` | List documents in the workspace (`id`, `name`, `pageCount`, `modifiedAt`, `source`). |
| `get_document` | Document metadata + canvas `pages` summary + `prosePages` summary + `fields` (the document's `{{name}}` values). The map of what exists. |
| `get_page` | The shapes on one canvas page, as DSL objects. |
| `get_shape` | One shape on a page, by id, as a DSL object (the read-one companion to `get_page`). |
| `get_prose` | All prose pages (or one, with `pageId`): `id`, `name`, `order`, HTML `content`. |
| `get_outline` | A prose page's heading outline: ordered `{ index, level, title }`. `index` is used by the structural tools. |
| `list_references` | The document's reference library as CSL-JSON in display order, plus the active `style`. |
| `resolve_doi` | Resolve a `doi` to a CSL-JSON reference via doi.org content negotiation, **without** writing — preview before `add_reference`. |
| `list_fields` | The document's fields (reusable `{{name}}` values) in display order, each `{ name, value }`. |
| `get_skills` | Agent onboarding: with no args, the **content contract** (rules for valid prose + shapes) plus a recipe catalogue; with `{ skill }`, that recipe's full steps. Call it first if unsure how a tool expects its input — authoring valid content avoids the relay having to heal it. |

### Author

| Tool | Purpose |
| -- | -- |
| `create_document` | Create a new document (one blank canvas page + one blank prose page). Returns `{ id, name }`. The starting point for authoring from scratch. |

### Prose (write)

| Tool | Purpose |
| -- | -- |
| `add_prose_page` | Append a prose page. Markdown by default. |
| `set_prose` | Write a prose page. Replaces the whole body by default; pass `anchor` (the current text of a block) to replace **only that block** — a targeted edit. Markdown by default. |
| `rename_prose_page` | Rename a prose page. |

### Structure (write)

| Tool | Purpose |
| -- | -- |
| `insert_section` | Insert a heading (+ optional body) at `start`/`end` or after a heading `index`. |
| `restructure_outline` | `promote`/`demote` a heading's level, or `move` a section to a new index. |

### Diagram (write)

| Tool | Purpose |
| -- | -- |
| `add_canvas_page` | Append a blank canvas page; returns `{ id }`. Target it with the returned id in `add_shape(s)`/`generate_diagram` to build a second diagram in the same document. |
| `rename_canvas_page` | Rename a canvas page. |
| `add_shape` | Add one shape (rectangle, ellipse, text, connector). |
| `add_shapes` | Add many shapes in one all-or-nothing call. |
| `connect` | Connect two existing shapes with a connector. |
| `update_shape` | Patch an existing shape (`x`, `y`, `w`, `h`, `text`, `style`). |
| `generate_diagram` | Build a whole diagram from a `nodes` + `edges` graph; the relay auto-positions (`layered` with crossing minimization, or `grid`) and wires connectors to typed anchors with orthogonal obstacle-avoiding routing (`routing: "straight"` opts out). Writes the live Y.Doc on a resident doc (a connected editor sees the shapes immediately) — like the other shape tools. |

### Manage (write)

| Tool | Purpose |
| -- | -- |
| `delete_shape` | Delete a shape by id. **Cascade-removes** any connectors attached to it (start or end), so no dangling connectors are left; returns the ids actually deleted. |
| `delete_prose_page` | Delete a prose page by id. Refuses to delete the **last** remaining prose page. In a connected editor the page's *tab* may persist until reload (the prose page list isn't yet live-synced); its content is cleared immediately. |
| `reorder_shapes` | Set a page's z-order. `order` must be a permutation of the page's current shape ids (later ids render on top). |
| `reorder_prose_pages` | Set the order of a document's prose pages. `order` must be a permutation of the current prose page ids. Tab order may update on reload (page list not yet live-synced). |

### Citations (write)

| Tool | Purpose |
| -- | -- |
| `add_reference` | Add reference(s) to the document's library. Supply **either** `doi` (resolved via doi.org to CSL-JSON) **or** `items` (raw CSL-JSON object(s)). Dedups by DOI then id; returns the ids added + how many were skipped. |

This populates the **library** only — it doesn't yet insert an inline citation
or bibliography into the prose (do that in the editor). The library is stored as
the document's top-level `references` field and round-trips durably; a *connected*
editor sees new references on reload, as references aren't live-synced yet.
Formatting (CSL → APA/MLA/Chicago/Vancouver) is done in the editor, not the
relay — the MCP surface only reads and writes CSL-JSON.

### Fields (write)

| Tool | Purpose |
| -- | -- |
| `set_fields` | Set/update document **fields** — reusable named values (e.g. `Company` → `Acme Inc.`, `Version` → `2.0`). Upsert by name: a new name is created, an existing name's value is replaced. Returns the names written + which were newly added. |

A *field* is a `name → value` pair that propagates everywhere it's referenced. To
**reference** a field in prose, write `{{name}}` in Markdown via
`set_prose`/`add_prose_page` — it becomes a live field placeholder (`<span
data-field data-name="name">`) that renders the current value and updates when the
value changes. (`{{name}}` inside inline code or a code block stays literal.)

Fields are stored as the document's top-level `fields` object —
`{ fields: { "<name>": { name, value } }, order: [...] }` — and round-trip
durably. On a *connected* (resident) document, `set_fields` writes the live CRDT
library and broadcasts, so collaborators see new values immediately, per item (a
concurrent editor's field isn't clobbered).

(Renames: `rename_prose_page`.)

## Concurrency

**Live docs (a client is connected/editing).** When a document is resident on
the relay, writes apply to the **authoritative Y.Doc** and broadcast a CRDT
delta, so connected editors see the change immediately (they merge it — no
reload):

- **Shape** tools (`add_shape`/`add_shapes`/`connect`/`update_shape`/
  `delete_shape`/`reorder_shapes`/`generate_diagram`) write the live shape map
  when the doc is resident *and* the target page is the active page. (Canvas
  page-list tools — `add_canvas_page`/`rename_canvas_page` — are JSON-only,
  like the prose page list; a new page's *tab* may lag until reload.)
- **Prose** tools (`set_prose`/`add_prose_page`/`insert_section`/
  `restructure_outline`) rebuild the page's live `prose:<pageId>` fragment
  (whole-page replace) when the doc is resident — so an agent's prose appears in
  a connected editor live, and an MCP read reflects an editor's un-snapshotted
  prose. (A new `add_prose_page` page's *tab* may lag until the prose page list
  syncs; its content lands immediately.)
- **Anchored prose edits** (`set_prose` with `anchor`) are the *targeted* path:
  the block whose text matches the anchor is the only one rewritten, so the CRDT
  delta touches just that block and a concurrent edit elsewhere on the page is
  preserved. The anchor doubles as a **block-level compare-and-swap** — it must
  match exactly one block (matched against the live fragment when resident, the
  JSON content when cold), so a stale anchor is refused (`ERR_ANCHOR_*`) rather
  than clobbering drifted content. (Full PM-tree diff-merge for *whole-page*
  writes is future work.)

**Cold docs (no client connected).** Writes persist through an
**optimistic-concurrency check** on the document's `serverVersion`: read the
current version, apply, save only if it still matches, retrying on conflict — so
a concurrent editor's change is never silently clobbered. The relay's snapshot
flatten later projects live edits back into this JSON, so cold reads stay
current.

## Limits & current constraints

- **Local documents are read-only** via MCP. Renderer-owned (local) documents
  are mirrored read-only; writes target team documents only, and a write to a
  local id is refused with a clear message.
- **Prose is HTML.** Markdown in is rendered (GFM tables / strikethrough /
  task-lists on); HTML pass-through is re-parsed by the editor against its
  schema on load, which drops anything unmodelled.
- **Prose write limits.** A single prose write's content is capped at **~1 MiB**
  (`set_prose`/`add_prose_page`/`insert_section`; over it → `ERR_PROSE_TOO_LARGE`,
  advertised as `maxLength`). Nesting deeper than **64** levels is truncated
  (real prose nests <~10) — a safety bound so pathological input can't exhaust
  the server.
- **Outlines are flat.** A section is a heading plus the content up to the
  next heading; nesting is conveyed by `level`, not containment. `move` moves a
  single section, not its descendants.
- **`generate_diagram` layout is relay-side and self-contained.** Layered mode
  runs a full Sugiyama pipeline (cycle handling, crossing minimization,
  deterministic coordinates); connectors attach to typed anchors and are
  routed orthogonally around intervening shapes with explicit `waypoints`
  (`routing: "straight"` opts out), so the document looks right before any
  editor opens it. The same input always reproduces the same geometry. The
  editor re-routes connectors with the same algorithm when shapes move.
  Connectors route around nodes, not around each other — heavily parallel
  edges can still overlap. Node caps: 500 nodes / 1000 edges per call.
- **Rate limits (per workspace).** Writes draw from the shared write bucket
  (`[tenancy.limits] writes_per_sec`/`writes_burst`, shared with WS sync); reads
  draw from a **separate** bucket (`reads_per_sec`/`reads_burst`, `0` =
  unlimited). Over the bucket → HTTP `429` with `ERR_RATE_LIMIT`. Tunable via
  `RELAY_*` env on Cloud pods.
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
