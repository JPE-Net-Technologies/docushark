---
title: Authentication
description: Bringing your own OIDC identity provider to a self-hosted DocuShark sync server.
---

# Authentication

::: warning Future — not officially supported yet
See the [Self-Hosting overview](./overview) for the full framing. This page documents the DIY path that exists in the code today, not a supported product.
:::

The self-hosted server is a pure **OIDC resource server**: it validates RS256 JWTs against a JWKS URL you point it at. It does not mint tokens, register users, or store passwords — bring any OIDC issuer:

- **Self-host your own identity provider**: Keycloak, dex, Authelia, ZITADEL, or Supabase Auth all work.
- **DocuShark Cloud**: use the hosted control plane as your issuer instead, if you want the sync server self-hosted but authentication managed.

Point the config's `[auth]` block at your issuer's discovery values:

```toml
[auth]
issuer = "https://auth.example.com"
jwks_url = "https://auth.example.com/.well-known/jwks.json"
audience = "docushark-relay"
```

Tokens must carry a workspace claim (`{ id, role, region }`). Revocation (push and polling transports) is configured alongside the rest of `[auth]` — see [Configuration](./configuration) for the relevant fields.

`http` JWKS URLs are only accepted for loopback issuers; any remote issuer must be `https`.
