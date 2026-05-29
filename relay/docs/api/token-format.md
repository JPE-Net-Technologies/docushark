# App Token Format

The relay is an **OIDC resource server**. It does not mint tokens. It verifies tokens issued by whatever external issuer it has been pointed at.

Operators choose an OIDC issuer — Auth0, Cognito, Keycloak, dex, Authelia, ZITADEL, or a hosted Supabase-style backend — and point the relay at its JWKS URL. The relay does the rest.

## Configuration

`relay.toml` `[auth]` section. **Required** — `relay serve` refuses to
start until `issuer`, `jwks_url`, and `audience` are set. There is no
default signing secret; the relay never mints tokens.

```toml
[auth]
issuer = "https://auth.example.com"
jwks_url = "https://auth.example.com/.well-known/jwks.json"
audience = "docushark-relay"
```

- `issuer` is checked against the JWT `iss` claim.
- `jwks_url` is fetched on startup, cached in memory, refreshed in the background. See *JWKS caching + failure mode* below.
- `audience` is checked against the JWT `aud` claim.

## Signing algorithm

`RS256`. The JWKS endpoint must publish RSA public keys.

Other algorithms are not accepted. In particular:
- `HS256` is rejected (no shared secret model in the modern surface).
- `none` is rejected (obviously).
- `ES256` / `EdDSA` are not currently accepted; if you need them, open an issue with the use case.

## Claim shape

```json
{
  "iss": "https://auth.example.com",
  "sub": "user-or-account-id",
  "aud": "docushark-relay",
  "wsp": [
    { "id": "ws_01H...", "role": "owner",  "region": "yyz" },
    { "id": "ws_02H...", "role": "member", "region": "yyz" }
  ],
  "iat": 1716240000,
  "exp": 1718832000,
  "jti": "tok_01H..."
}
```

### Required claims

| Claim | Meaning |
| -- | -- |
| `iss` | Must equal the configured issuer. |
| `sub` | Opaque user identifier from the issuer. The relay stores this on documents the user creates. |
| `aud` | Must equal the configured audience (default `docushark-relay`). |
| `iat`, `exp` | Standard issued-at + expiry. Tokens past `exp` are rejected. |
| `jti` | Unique token identifier. Used for revocation lookups (see `revocation.md`). |

### Workspace claim (`wsp`)

`wsp` is an array of workspace memberships. Each entry has:

- `id` — workspace identifier the user belongs to.
- `role` — one of `owner`, `member`, `viewer`. Relay enforces role on document operations.
- `region` — region code the workspace is bound to (e.g. `yyz`, `ord`, `nrt`, `fra`). The relay refuses connections whose `region` does not match the relay's configured `region`.

Each entry may also carry two **optional** per-workspace limit fields. When
present they are authoritative; when absent the relay falls back to its
`[tenancy.limits]` config (see [Per-workspace limits](#per-workspace-limits)).
The relay enforces the raw numbers — it has no notion of plans or tiers.

- `quota_bytes` — integer storage-byte quota for the workspace. New blob
  uploads / document saves past this return **HTTP 507**.
- `editor_limit` — integer cap on concurrent **editor** (role `owner`/`member`)
  connections. Viewers are never counted against it.

```json
{ "id": "ws_01H...", "role": "owner", "region": "yyz", "quota_bytes": 262144000, "editor_limit": 2 }
```

Single-workspace deployments may still ship a one-entry `wsp` array — the shape is fixed.

### Optional claims

- `org_id` — string identifier for an organization (parent of multiple workspaces). Optional; useful for organizations migrating from the legacy auth surface.
- Issuer-specific claims (e.g. `email`, `name`) are tolerated but ignored.

## Validation order

For each incoming request bearing a token, the relay:

1. Parses the JWT (rejects malformed tokens with `400`).
2. Looks up the signing key in the JWKS cache by `kid`. Refuses unknown `kid` (`401`).
3. Verifies the RS256 signature.
4. Checks `iss` and `aud` against configured values.
5. Checks `exp` is in the future and `iat` is not absurdly in the future (60s skew tolerance).
6. Checks `jti` is not in the revocation set (see `revocation.md`).
7. For workspace-scoped operations: matches the requested workspace against `wsp[].id` and applies role.
8. For region-scoped connections (WebSocket): matches the relay's configured region against `wsp[].region` for the requested workspace.

A failure at any step results in a `401` (or `403` if the workspace/region check fails).

## JWKS caching + failure mode

- **In-memory cache, 5-minute TTL.**
- **Background refresh** before TTL expiry; never blocks a request.
- **Fail-open with last known good key for a 1-hour grace window** if the JWKS endpoint is unreachable. This prevents an issuer outage from knocking the relay offline.

After the 1-hour grace expires, all token verifications fail closed.

## Tenancy modes

The relay has two operating modes selected in `relay.toml` `[tenancy]`:

```toml
[tenancy]
# "shared" | "dedicated" — default "dedicated".
mode = "dedicated"
# Required when mode = "dedicated" and you need to pin to a
# specific workspace id. Blank in the default `relay init` template
# (which pins to the legacy "default" workspace).
workspace_id = ""

[tenancy.limits]
writes_per_sec = 40
writes_burst = 80
max_ws_connections_per_workspace = 25
max_ws_payload_bytes = 262144
```

- `mode = "shared"` — multi-tenant. Routes by the JWT workspace claim. Used by hosted deployments serving many workspaces from one process.
- `mode = "dedicated"` — single-tenant. The relay refuses any token whose workspace claim does not match the configured `workspace_id` (or the legacy `"default"` value when `workspace_id` is blank). Mismatches return HTTP `403` with body `"forbidden"` — no leak of the expected workspace.

`relay init` defaults to `dedicated` with the workspace id blank — safe-by-default for self-hosters.

`--tenancy=shared|dedicated` and `--tenancy-workspace=<id>` on `relay serve` override the `[tenancy]` block.

## Per-workspace limits

The `[tenancy.limits]` block configures per-workspace traffic limits, enforced for every authenticated connection:

| Field | Meaning |
| -- | -- |
| `writes_per_sec` | Token-bucket refill rate. Applies to WS CRDT sync frames and MCP write tools. Over-quota WS frames are silently dropped with an `ERR_RATE_LIMIT` reply; over-quota MCP calls return HTTP `429` with `Retry-After`. |
| `writes_burst` | Token-bucket capacity. Short spikes up to this size pass through without throttling. |
| `max_ws_connections_per_workspace` | Authenticated WS connection cap per workspace (editors + viewers — the total-connection safety ceiling that also guards pure-viewer flooding). The Nth + 1 connect fails with `ERR_WORKSPACE_CONNECTION_LIMIT` on the `AUTH_RESPONSE`. |
| `max_ws_payload_bytes` | Per-frame payload size cap. Pathologically large WS frames are rejected before dispatch; the connection is dropped. |
| `storage_quota_bytes` | Per-workspace storage-byte quota. `0` = unlimited. Fallback for the JWT `quota_bytes` claim. |
| `max_editors_per_workspace` | Per-workspace concurrent-**editor** cap. `0` = unlimited. Fallback for the JWT `editor_limit` claim. |

Defaults match the project's Free-Tier reference values; self-hosters can override any field. `storage_quota_bytes` and `max_editors_per_workspace` default to `0` (unlimited) so a self-host deploy is unconstrained out of the box.

### Effective limit resolution

For `quota_bytes` / `editor_limit`, the **effective limit is the JWT claim value if present, else the config fallback**. A resolved `0` (from either source) means unlimited. This lets a control plane mint absolute per-workspace numbers in the token while self-hosters rely on `[tenancy.limits]`.

### Storage enforcement (`507`)

Storage is a *level* read live from disk (full-size-per-grant attribution) — no persisted counter. A blob upload (`POST /api/blobs/:hash`) or document save (`PUT /api/docs/:id`) returns **HTTP 507 Insufficient Storage** when the projected workspace total would exceed the effective `quota_bytes`. A re-upload of an already-stored hash adds 0 (dedup) and is never refused. Existing data stays **readable** when over quota (`GET` is unaffected) — only new writes are refused.

### Editor cap (`ERR_EDITOR_LIMIT`)

When a workspace has an effective `editor_limit`, the Nth + 1 **editor** (role `owner`/`member`) WS connection is refused at auth with `ERR_EDITOR_LIMIT` on the `AUTH_RESPONSE`. **Viewers (role `viewer`) are never refused on this axis.** The total-connection ceiling above still applies to everyone.

## Usage endpoint

`GET /api/v1/usage` returns the **calling token's own** workspace usage and effective limits (JSON, camelCase). The workspace is resolved from the validated JWT exactly like `/api/docs`, so a caller can never read another workspace's numbers. `null` quota/limit means unlimited.

```json
{ "storageBytes": 12345678, "storageQuota": 262144000, "activeEditors": 1, "editorLimit": 2 }
```

The response carries counts only — no document ids and no content.

## Token lifetime guidance

- App tokens issued by an external control plane should have a TTL of 30 days or less. The relay does not impose its own ceiling, but the revocation window grows with token TTL.
- Refresh-token flow is the issuer's responsibility — the relay never sees refresh tokens.

## No legacy / password auth

The relay does not mint tokens, store passwords, or expose `/api/auth/login`-style endpoints. The pre-v1 HS256 + bcrypt surface was removed when the relay became a pure OIDC resource server. Self-hosters point `[auth].issuer` / `[auth].jwks_url` at any OIDC provider (Keycloak, dex, Authelia, ZITADEL, Supabase, or a hosted control plane) — see the relay README for a setup recipe.
