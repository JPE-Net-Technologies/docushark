# docushark-relay

Standalone collaboration server for DocuShark clients. Owns:

- **WebSocket sync** (`/ws`, Yjs CRDT + presence)
- **REST API** (`/api/auth/*`, `/api/docs/*`, `/api/blobs/*`)
- **MCP HTTP endpoint** (`http://localhost:9877/mcp`) for IDE / agent integrations
- **User store + JWT auth** (HS256, per-deploy secret)
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
task dev:relay:init   # one-shot: writes ./relay/relay.toml + prompts for the first admin
task d                # launches the relay and the Tauri client side-by-side
```

Or directly against the crate:

```bash
cd relay
cargo build
cargo test                                # unit + integration tests
cargo run -- init                         # prompts for admin creds + writes ./relay.toml
cargo run -- serve                        # listens on :9876 + :9877
```

`relay init` seeds the first admin in `users.json` so a fresh relay
is reachable through the desktop's login form. For Docker / CI use,
pass the credentials non-interactively:

```bash
cargo run -- init \
  --admin-user admin \
  --admin-password 'a-real-password' \
  --admin-display-name 'Admin'
# or skip the seed step entirely (you'll need to call /api/auth/register manually):
cargo run -- init --skip-admin
```

`relay serve` accepts `--port` and `--data-dir` flags that override
the corresponding values in `relay.toml`. CLI overrides win.

## Configuration

A minimal `relay.toml` (everything optional — `relay init` writes
the canonical form with a fresh JWT secret):

```toml
[server]
port = 9876
# "lan" binds 0.0.0.0; "localhost" binds 127.0.0.1.
network_mode = "lan"

[storage]
backend = "filesystem"   # only backend in Phase 20.
path = "data"            # relative to working directory.

[auth]
jwt_secret = "<64 hex chars; per-deploy>"
token_ttl_hours = 24

[mcp]
enabled = true
port = 9877
```

Unknown keys are rejected at parse time so typos surface loudly
instead of being silently dropped.

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

- The JWT secret is the only credential gating access. Roll it (`relay
  init --force`) on suspected compromise. Existing sessions invalidate
  on first use of the new secret.
- The MCP endpoint binds to 127.0.0.1 by design — it carries write
  capability against relay-stored documents and has its own bearer
  token. If you need it remotely, SSH-forward port 9877 rather than
  binding it publicly.
- Bcrypt hashes (argon2 swap pending in a follow-up slice). Passwords
  must be at least 8 characters; the first registered user becomes
  admin so a fresh deploy is bootstrappable.
