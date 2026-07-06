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
| **claude.ai (web)** | Settings → Connectors → add a custom connector with the `/mcp` URL, then complete the OAuth sign-in when prompted | **OAuth only** — the web connector UI has no bearer/header field. Works out of the box: the relay advertises its authorization server via RFC 9728 discovery and the connector runs the auth-code + PKCE flow. Requires a network-reachable relay with `[mcp] expose = "public"`. |
| **ChatGPT (web)** | Enable **Developer Mode** (Settings → Connectors → Advanced), then add the `/mcp` URL + token under Connectors | URL + auth token ✅ |
| **OpenAI API** (Responses / Agents SDK) | Pass it as an MCP tool: `tools: [{ type: "mcp", server_label: "docushark", server_url: "https://<host>/mcp", headers: { Authorization: "Bearer <token>" } }]` | Bearer token / header ✅ |

> **Which credential where:** claude.ai is OAuth-only (no bearer field) and signs in
> through the relay's OAuth 2.1 flow — an unauthenticated `/mcp` request returns a
> `401` pointing at `/.well-known/oauth-protected-resource`, the connector completes
> auth-code + PKCE at the advertised issuer, and comes back with a relay JWT (see
> `relay/docs/mcp/README.md`, *OAuth discovery*). The static MCP token remains the
> desktop / self-host path — note it is **refused when `expose = "public"`**, so a
> public multi-tenant relay accepts JWTs only.

## Smoke-test the connection

```bash
curl -s -H "Authorization: Bearer <token>" https://<host>/mcp -d '{}'
```

- A JSON-RPC error (e.g. `"Unknown method"`) means the connection + auth are good.
- A **401** means the token is missing or invalid. If it carries a
  `WWW-Authenticate: Bearer resource_metadata=…` header, that's the relay's OAuth
  discovery pointer — expected on any unauthenticated request, and how OAuth-based
  clients find the sign-in flow (not a server failure).

## First call

Once connected, confirm tools are visible by listing documents, then create one:

1. `list_documents` → should return your workspace's documents.
2. `create_document` → returns a new `{ id }` you then write prose + diagrams into.

From here, follow any recipe in this directory.
