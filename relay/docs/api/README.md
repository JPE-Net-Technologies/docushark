# DocuShark Relay — Wire Specification

This directory is the **authoritative wire spec** for the DocuShark relay's HTTP and WebSocket surface. Anything that wants to talk to a relay — the editor, a self-hosted control plane, a third-party MCP client, a future replacement implementation — codes against the files here.

## Layout

| File | Purpose |
| -- | -- |
| `openapi.yaml` | OpenAPI 3.1 specification of every REST endpoint under `/api/v1/*` (and current `/api/*` legacy endpoints). |
| `token-format.md` | App-token claim shape, signing algorithm (RS256), JWKS URL semantics, audience values, `wsp` and `region` claim meaning. |
| `webhooks.md` | Outbound webhook payload schemas (revocation push, doc events). |
| `revocation.md` | Webhook + polling protocol for app-token revocation, including the 60-second propagation window and fail-open semantics. |
| `deprecation-policy.md` | Published deprecation policy — versioning rules, 6-month sunset window, `Deprecation` header semantics. |

## Source of truth

These files are the source of truth for the wire. If a PR changes a route shape, claim, header, or webhook payload **without** updating the relevant file here in the same commit, that PR is broken — doc-drift is treated as a bug.

The relay implementation under `relay/src/` is expected to **match** this spec. Where they differ today (e.g., a legacy endpoint not yet retired), the spec marks the endpoint as `deprecated`.

## Versioning

All canonical endpoints live under `/api/v1/`. Older `/api/*` endpoints without the `v1` prefix are pre-v1 and scheduled for removal — see `deprecation-policy.md`.

The protocol-version negotiation header on WebSocket connect is described in `openapi.yaml` (the `/ws` endpoint) and uses the same numeric `PROTOCOL_VERSION` constant published in both `src/collaboration/protocol.ts` (TypeScript) and `relay/src/server/protocol.rs` (Rust). Fixture tests in `relay/tests/protocol-fixtures/` keep both implementations honest.

## What this directory does NOT contain

This is the *wire*, not the *operator manual*. The following are explicitly out of scope here:

- Deployment recipes, Docker run lines, systemd unit files (see `relay/README.md` + `relay/Dockerfile`).
- Configuration of any particular OIDC issuer (the relay is issuer-agnostic; the operator picks one).
- Performance tuning, monitoring, observability setup.
- Cluster topology, regional deployment patterns, multi-tenancy operations.

Operators standing up a relay should also read `relay/README.md` and `relay/relay.toml`.
