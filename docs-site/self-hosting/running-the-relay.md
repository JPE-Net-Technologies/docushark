---
title: Running It
description: Docker and bare-metal setup for DocuShark's open-source sync server — the advanced, DIY self-hosting path.
---

# Running It

::: warning Future — not officially supported yet
See the [Self-Hosting overview](./overview) for the full framing. This page documents the DIY path that exists in the code today, not a supported product.
:::

## One-command run (Docker)

```bash
docker build -t docushark/relay -f relay/Dockerfile relay/
docker run --rm \
  -v "$PWD/data:/data" \
  -p 9876:9876 \
  -p 9877:9877 \
  docushark/relay
```

The container needs a config file before it will start with your own settings. Run this once on a fresh volume:

```bash
docker run --rm -v "$PWD/data:/data" docushark/relay init --config /data/relay.toml
```

Then fill in the `[auth]` block (see [Authentication](./authentication)) before running the container for real. **Don't commit that config file to any repo** — it can hold operational secrets.

| Port | What | Bind |
|------|------|------|
| 9876 | HTTP + WebSocket (sync, REST API) | configurable, default all interfaces |
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

## Next: configure it

Before it will actually start, you need to point it at an identity provider — see [Authentication](./authentication) — and, optionally, adjust anything else in [Configuration](./configuration).
