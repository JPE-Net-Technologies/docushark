# Connecting an agent to DocuShark (MCP)

Every recipe assumes your agent can reach a DocuShark relay's MCP endpoint. The
relay exposes a Streamable-HTTP MCP server at **`/mcp`** (use `https://` for any
remote relay). The credential is either:

- a **static MCP token** — generated on the relay's first run, written to
  `mcp_token` in its data dir and surfaced in the desktop app's Settings (this maps
  to a single workspace); or
- a **relay JWT** — for a public/multi-workspace relay, obtained via the relay's
  OAuth flow (RFC 9728 discovery at `/.well-known/oauth-protected-resource`).

## Per-client setup

The MCP server is the same for everyone; clients differ in how you add it and which
auth they accept.

| Client | How to add the server | Auth it accepts |
|---|---|---|
| **Claude Code** | `claude mcp add --transport http docushark https://<host>/mcp --header "Authorization: Bearer <token>"` (or an `.mcp.json` entry) | Bearer token / custom header ✅ |
| **Claude Desktop** | Add an HTTP server to `claude_desktop_config.json` with the `/mcp` URL + an `Authorization: Bearer <token>` header | Bearer token / custom header ✅ |
| **claude.ai (web)** | Settings → Connectors → add a custom connector by URL | **OAuth only** — the web connector UI has no bearer/header field, so the static token won't work here. Needs the relay's OAuth flow live + a public relay. **Until then, use Claude Desktop or Claude Code.** |
| **ChatGPT (web)** | Enable **Developer Mode** (Settings → Connectors → Advanced), then add the `/mcp` URL + token under Connectors | URL + auth token ✅ |
| **OpenAI API** (Responses / Agents SDK) | Pass it as an MCP tool: `tools: [{ type: "mcp", server_label: "docushark", server_url: "https://<host>/mcp", headers: { Authorization: "Bearer <token>" } }]` | Bearer token / header ✅ |

> **claude.ai caveat:** the web product's connector flow is OAuth-based and does not
> expose a place to paste a bearer token. This is the one surface where the static
> MCP token can't be used today — connect from Claude Desktop/Code instead, or wait
> for the relay's hosted OAuth.

## Smoke-test the connection

```bash
curl -s -H "Authorization: Bearer <token>" https://<host>/mcp -d '{}'
```

- A JSON-RPC error (e.g. `"Unknown method"`) means the connection + auth are good.
- A **401** means the token is missing or invalid.

## First call

Once connected, confirm tools are visible by listing documents, then create one:

1. `list_documents` → should return your workspace's documents.
2. `create_document` → returns a new `{ id }` you then write prose + diagrams into.

From here, follow any recipe in this directory.
