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
| `max_ws_connections_per_workspace` | Authenticated WS connection cap per workspace. The Nth + 1 connect fails with `ERR_WORKSPACE_CONNECTION_LIMIT` on the `AUTH_RESPONSE`. |
| `max_ws_payload_bytes` | Per-frame payload size cap. Pathologically large WS frames are rejected before dispatch; the connection is dropped. |

Defaults match the project's Free-Tier reference values; self-hosters can override any field.

## Token lifetime guidance

- App tokens issued by an external control plane should have a TTL of 30 days or less. The relay does not impose its own ceiling, but the revocation window grows with token TTL.
- Refresh-token flow is the issuer's responsibility — the relay never sees refresh tokens.

## No legacy / password auth

The relay does not mint tokens, store passwords, or expose `/api/auth/login`-style endpoints. The pre-v1 HS256 + bcrypt surface was removed when the relay became a pure OIDC resource server. Self-hosters point `[auth].issuer` / `[auth].jwks_url` at any OIDC provider (Keycloak, dex, Authelia, ZITADEL, Supabase, or a hosted control plane) — see the relay README for a setup recipe.
