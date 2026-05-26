# Deprecation Policy

The relay commits to a published deprecation policy so consumers can plan migrations. This document is part of the wire spec — changes to the policy require the same versioning treatment as the wire itself.

## Versioning

- **REST endpoints.** Canonical surface lives under `/api/v1/`. Breaking changes ship as `/api/v2/`, `/api/v3/`, etc.
- **OSS relay crate** follows [Semantic Versioning](https://semver.org/). Major bumps coincide with REST surface bumps (`/api/v1/` → `/api/v2/` lands with relay `2.0.0`).
- **Container image** tags: `:1.x.y`, `:1`, `:latest`. Operators pinning to `:1` get the latest minor + patch within the `v1` major, automatically.
- **Wire protocol** (WebSocket message types) has its own `PROTOCOL_VERSION` constant published in both `protocol.ts` and `protocol.rs`. Additive changes within a major bump the minor number; breaking changes require a major REST bump too.

## What "deprecated" means

When an endpoint, header, claim, or behaviour is marked deprecated:

- It continues working unchanged for the duration of the deprecation window.
- Responses include a `Deprecation` header (RFC 9745):
  ```
  Deprecation: @1716240000
  Sunset: Sat, 21 Nov 2026 00:00:00 GMT
  Link: <https://docs.example.com/api/migration>; rel="sunset"
  ```
- New work targets the replacement surface; the deprecated path receives only security fixes.

## Sunset window

- **Minimum 6 months** between marking deprecated and physical removal.
- For breaking changes to widely-deployed endpoints (`/api/docs/*`, `/ws`, JWT verification), the minimum is **12 months**.
- The exact removal date is published in the `Sunset` header from day one of the deprecation window.

## Communication

- Every deprecation is announced in the relay release notes for the version it lands in.
- Every deprecation has a migration note in the OSS docs site (`docs-site/`) explaining the recommended replacement path.
- The `Deprecation` header is the machine-readable signal — automated consumers should look for it and report it.

## Removed (pre-GA)

The legacy HS256 + bcrypt auth surface was **removed** when the relay
became a pure OIDC resource server (JP-77). DocuShark is pre-GA, so this
landed as a breaking change rather than a deprecation window. There is no
in-relay user store, password flow, or token issuance:

| Removed | Replacement |
| -- | -- |
| `POST /api/auth/register` | External OIDC issuer registration flow. |
| `POST /api/auth/login` | External OIDC token issuance + `/api/v1/auth/exchange` on the control plane. |
| `GET /api/auth/me` | Direct claim inspection client-side, or control-plane `/me` endpoint. |
| `POST /api/auth/password` | Issuer's password / credential management UI. |
| HS256 token verification path | RS256 + JWKS (see `token-format.md`). |

## Currently deprecated

These items are deprecated as of relay 1.x and scheduled for removal in 2.0.0:

| Item | Status | Replacement |
| -- | -- | -- |
| `POST /api/docs/{id}/share` (legacy share endpoint) | Deprecated | `POST /api/v1/docs/{id}/share-links`. |

## What is NOT deprecated

To set expectations: the following surface is committed within `v1` and will not be removed without a major bump:

- `GET/PUT/DELETE /api/docs/*` (the canonical CRUD).
- `POST/GET/HEAD /api/blobs/{hash}` (content-addressed blob store).
- `/ws` WebSocket sync + awareness multiplexing.
- `/mcp` MCP HTTP transport.
- The claim shape documented in `token-format.md` — new claims may be added (additive), existing claims may not be removed or repurposed within `v1`.
- The webhook events documented in `webhooks.md`.

## Asking for an extension

If a deprecation window doesn't give you enough time to migrate, file an issue. We'd rather extend the window than break running deployments.
