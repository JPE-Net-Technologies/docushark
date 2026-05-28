# docushark-relay

Standalone collaboration server for DocuShark clients. Owns:

- **WebSocket sync** (`/ws`, Yjs CRDT + presence)
- **REST API** (`/api/docs/*`, `/api/blobs/*`)
- **MCP HTTP endpoint** (`http://localhost:9877/mcp`) for IDE / agent integrations
- **OIDC token validation** — RS256 JWTs verified against an external
  issuer's JWKS; the relay never mints tokens or stores passwords
- **Document + blob storage** (filesystem, content-addressed for blobs)

The Tauri desktop becomes a pure client in v2 — local documents stay
on the user's machine, anything collaborative goes through a relay.
Self-hosted is free and trivial to run; a managed tier is on the
roadmap.

## One-command run (Docker)

```bash
docker build -t docushark/relay -f relay/Dockerfile relay/
docker run --rm \
  -v "$PWD/data:/data" \
  -p 9876:9876 \
  -p 9877:9877 \
  docushark/relay
```

On first boot `relay init` runs automatically inside the container —
if `/data/relay.toml` doesn't exist, the entrypoint creates one with
a freshly-rolled JWT secret. **Do not commit `/data/relay.toml` to
any repo: it holds the per-deploy signing key.**

> Note: the bundled CMD assumes `/data/relay.toml` already exists.
> Run `relay init` once on a fresh volume:
>
> ```bash
> docker run --rm -v "$PWD/data:/data" docushark/relay init --config /data/relay.toml
> ```

Ports:

| Port | What | Bind |
|------|------|------|
| 9876 | HTTP + WebSocket (sync, REST API) | configurable, default `0.0.0.0` |
| 9877 | MCP HTTP endpoint | loopback by design — proxy/SSH-forward if you need it remote |

## Bare-metal install (systemd)

```bash
# 1. Build
cd relay && cargo build --release

# 2. Install binary + user
sudo install -m 0755 target/release/relay /usr/local/bin/relay
sudo useradd --system --home /var/lib/docushark-relay \
     --shell /usr/sbin/nologin docushark-relay
sudo install -d -m 0750 -o docushark-relay -g docushark-relay \
     /var/lib/docushark-relay

# 3. Roll a config
sudo -u docushark-relay /usr/local/bin/relay init \
     --config /var/lib/docushark-relay/relay.toml

# 4. Service
sudo install -m 0644 relay.service /etc/systemd/system/docushark-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now docushark-relay
sudo systemctl status docushark-relay
```

## Development

From the repo root, the easiest path is:

```bash
task dev:relay:init   # one-shot: writes ./relay/relay.toml
task d                # launches the relay and the Tauri client side-by-side
```

Or directly against the crate:

```bash
cd relay
cargo build
cargo test                                # unit + integration tests
cargo run -- init                         # writes a starter ./relay.toml
cargo run -- serve                        # listens on :9876 + :9877
```

`relay init` writes a starter `relay.toml`. Before `relay serve` will
start, fill in the `[auth]` block to point at your OIDC issuer (see
**Authentication** below) — there is no built-in user store to seed.

`relay serve` accepts `--port`, `--data-dir`, and `--region` flags that
override the corresponding values in `relay.toml`. CLI overrides win.
Settings can also come from `RELAY_*` environment variables (see
[Configuration → Environment variables](#environment-variables)) — handy
for containerized deploys that ship no `relay.toml`.

## Authentication

The relay is a pure **OIDC resource server**. It validates RS256 JWTs
against a JWKS URL you point it at; it does not mint tokens, register
users, or store passwords. Bring any OIDC issuer:

- **Self-host:** Keycloak, dex, Authelia, ZITADEL, or Supabase Auth.
- **DocuShark Cloud:** the hosted control plane is the issuer.

Point `[auth]` at the issuer's discovery values:

```toml
[auth]
issuer = "https://auth.example.com"
jwks_url = "https://auth.example.com/.well-known/jwks.json"
audience = "docushark-relay"
```

Tokens must carry a `wsp[]` workspace claim (`{ id, role, region }`).
Claim shape, validation order, and JWKS caching behaviour are specified
in [`docs/api/token-format.md`](docs/api/token-format.md). Revocation
(push + polling transports) is in [`docs/api/revocation.md`](docs/api/revocation.md).

## Configuration

A `relay.toml`. The `[auth]` block is **required** (see
**Authentication**); everything else has defaults.

```toml
[server]
port = 9876
# "lan" binds 0.0.0.0; "localhost" binds 127.0.0.1.
network_mode = "lan"

[storage]
backend = "filesystem"   # only backend in Phase 20.
path = "data"            # relative to working directory.

[auth]
issuer = "https://auth.example.com"
jwks_url = "https://auth.example.com/.well-known/jwks.json"
audience = "docushark-relay"
# Optional revocation transports (see docs/api/revocation.md):
# revocation_push_bearer = "<shared secret for POST /api/v1/internal/revoke>"
# revocation_polling_url = "https://control-plane.example.com/api/v1/revocations"
# revocation_polling_bearer = "<shared secret>"
# revocation_polling_interval_seconds = 60

[mcp]
enabled = true
port = 9877
```

Unknown keys are rejected at parse time so typos surface loudly
instead of being silently dropped.

### Environment variables

Every load-bearing setting can also be supplied via a `RELAY_*`
environment variable. This is aimed at containerized deploys: set the
env and the relay runs with **no `relay.toml` at all**. Precedence is
**CLI flag > env var > `relay.toml` > built-in default**, so env values
override the file but an explicit CLI flag still wins. Malformed values
(a non-numeric port, an unknown mode) fail fast at startup.

| Variable | Overrides |
|---|---|
| `RELAY_PORT` | `[server].port` |
| `RELAY_NETWORK_MODE` | `[server].network_mode` (`localhost`/`lan`) |
| `RELAY_DATA_DIR` | `[storage].path` |
| `RELAY_JWT_ISSUER` | `[auth].issuer` |
| `RELAY_JWT_JWKS_URL` | `[auth].jwks_url` |
| `RELAY_JWT_AUDIENCE` | `[auth].audience` |
| `RELAY_REVOCATION_BEARER` | `[auth].revocation_push_bearer` |
| `RELAY_REVOCATION_POLLING_URL` | `[auth].revocation_polling_url` |
| `RELAY_REVOCATION_POLLING_BEARER` | `[auth].revocation_polling_bearer` |
| `RELAY_TENANCY_MODE` | `[tenancy].mode` (`shared`/`dedicated`) |
| `RELAY_TENANCY_WORKSPACE` | `[tenancy].workspace_id` |
| `RELAY_REGION` | the `--region` value (used to enforce `wsp[].region`) |

## What's *not* here

Phase 20 keeps the self-hosted relay deliberately small. Out of
scope:

- Postgres / S3 / any non-filesystem storage backend
- TLS termination (run behind nginx / Caddy / Traefik)
- SSO / SAML / SCIM
- Horizontal scaling, sharding, replication
- Audit log dispatcher / webhooks

A managed tier handles these. The self-hosted shape stays "single
binary, single config file, one volume."

## Trust model

- Access is gated by RS256 JWTs from your configured OIDC issuer. The
  relay trusts the issuer's JWKS; rotate signing keys at the issuer and
  the relay picks them up within the JWKS cache TTL (5 min) without a
  restart. Revoke a leaked token by `jti` via the revocation transports.
- The MCP endpoint binds to 127.0.0.1 by design — it carries write
  capability against relay-stored documents and has its own bearer
  token. If you need it remotely, SSH-forward port 9877 rather than
  binding it publicly.
- The relay holds no password material. User lifecycle, MFA, and session
  management are the issuer's responsibility.
