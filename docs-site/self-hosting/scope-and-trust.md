---
title: Current Limitations
description: What a self-hosted DocuShark sync server doesn't do yet, and its trust model.
---

# Current Limitations

::: warning Future — not officially supported yet
See the [Self-Hosting overview](./overview) for the full framing. This page documents the DIY path that exists in the code today, not a supported product.
:::

## What's not here yet

The self-hosted server is deliberately small today. Out of scope for now — all on the roadmap, not a permanent ceiling:

- Postgres, S3, or any storage backend beyond the local filesystem
- TLS termination (run it behind nginx, Caddy, or Traefik in the meantime)
- SSO / SAML / SCIM
- Horizontal scaling, sharding, or replication
- An audit log dispatcher or webhooks

The shape stays intentionally minimal for now: a single binary, a single config file, one data volume.

## Trust model

- Access is gated by RS256 JWTs from whichever OIDC issuer you configure (see [Authentication](./authentication)). The server trusts that issuer's JWKS; rotate signing keys at the issuer and the server picks them up automatically, within a short cache window, with no restart needed. A leaked token can be revoked individually via the revocation transports.
- The MCP endpoint binds to loopback (127.0.0.1) by design — it carries write access to your documents and has its own bearer token. If you need it reachable remotely, forward the port over SSH rather than exposing it publicly.
- The server holds no password material of its own. User accounts, multi-factor auth, and session management are entirely your identity provider's responsibility.
