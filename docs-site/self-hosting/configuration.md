---
title: Configuration
description: The config file and environment variables for DocuShark's self-hosted sync server.
---

# Configuration

::: warning Future — not officially supported yet
See the [Self-Hosting overview](./overview) for the full framing. This page documents the DIY path that exists in the code today, not a supported product.
:::

Everything is driven by one config file, `relay.toml`. Only the `[auth]` block is required — see [Authentication](./authentication) — everything else has a sensible default.

```toml
[server]
port = 9876
# "lan" binds to all interfaces; "localhost" binds to loopback only.
network_mode = "lan"

[storage]
backend = "filesystem"
path = "data"            # relative to working directory

[auth]
issuer = "https://auth.example.com"
jwks_url = "https://auth.example.com/.well-known/jwks.json"
audience = "docushark-relay"
# Optional revocation transports:
# revocation_push_bearer = "<shared secret for the revoke endpoint>"
# revocation_polling_url = "https://control-plane.example.com/api/v1/revocations"
# revocation_polling_bearer = "<shared secret>"
# revocation_polling_interval_seconds = 60

[mcp]
enabled = true
port = 9877
```

Unknown keys are rejected at parse time, so a typo surfaces loudly instead of being silently ignored.

## Environment variables

Every setting above can also come from an environment variable instead — handy for containerized deploys that ship no config file at all. Precedence is **CLI flag > environment variable > config file > built-in default**.

| Variable | Overrides |
|---|---|
| `RELAY_PORT` | Server port |
| `RELAY_NETWORK_MODE` | `localhost` / `lan` |
| `RELAY_DATA_DIR` | Storage path |
| `RELAY_JWT_ISSUER` | Auth issuer |
| `RELAY_JWT_JWKS_URL` | Auth JWKS URL |
| `RELAY_JWT_AUDIENCE` | Auth audience |
| `RELAY_REVOCATION_BEARER` | Revocation push bearer token |
| `RELAY_REVOCATION_POLLING_URL` | Revocation polling URL |
| `RELAY_REVOCATION_POLLING_BEARER` | Revocation polling bearer token |
| `RELAY_TENANCY_MODE` | `shared` / `dedicated` |
| `RELAY_TENANCY_WORKSPACE` | Tenancy workspace id |
| `RELAY_REGION` | Region enforcement value |
| `RELAY_ENFORCE_PRIVATE_DOCS` | Gate document reads on owner/share set (default off) |

Malformed values (a non-numeric port, an unknown mode) fail fast at startup rather than silently falling back to a default.
