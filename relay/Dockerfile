# syntax=docker/dockerfile:1
#
# Multi-stage build for diagrammer-relay.
#   builder: compile a static-ish release binary inside the official
#            rust image so the host doesn't need a Rust toolchain.
#   runtime: small Debian slim layer with just the binary + a non-root
#            user. Distroless was considered but Debian-slim is easier
#            to debug on a fresh box and the image is only ~80 MB.
#
# Build:    docker build -t diagrammer/relay -f relay/Dockerfile relay/
# Run:      docker run --rm -p 9876:9876 -p 9877:9877 \
#               -v "$PWD/data:/data" diagrammer/relay
#
# The container expects (and `relay init` will create) `/data/relay.toml`
# on first boot. Mount a host directory at `/data` for persistence.

# ---------- builder ----------
FROM rust:1.83-bookworm AS builder
WORKDIR /build

# Cache deps first by copying the manifests, faking a `main.rs`, and
# letting `cargo fetch` warm the build cache. Then drop in the real
# source for the actual compile.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src \
 && echo 'fn main(){}' > src/main.rs \
 && echo '' > src/lib.rs \
 && cargo fetch \
 && rm -rf src

COPY src ./src
COPY tests ./tests

# Release build. `--locked` enforces Cargo.lock so the image is
# reproducible against the committed lockfile.
RUN cargo build --release --locked --bin relay

# ---------- runtime ----------
FROM debian:bookworm-slim AS runtime

# ca-certificates: HTTPS calls (if a future S3/Postgres backend lands).
# tini: PID 1 reaping + signal forwarding so `docker stop` triggers a
#       clean shutdown via SIGINT.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# Non-root runtime user. UID/GID 10001 is high enough to avoid collisions
# with host system users on bind-mount setups.
RUN groupadd --system --gid 10001 relay \
 && useradd --system --uid 10001 --gid relay --home-dir /data --shell /usr/sbin/nologin relay \
 && mkdir -p /data \
 && chown -R relay:relay /data

COPY --from=builder /build/target/release/relay /usr/local/bin/relay

USER relay
WORKDIR /data
VOLUME ["/data"]

# Sync listener on 9876, MCP on 9877. Bind to 0.0.0.0 inside the
# container; operators publish only what they want exposed.
EXPOSE 9876 9877

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/relay"]
CMD ["serve", "--config", "/data/relay.toml", "--data-dir", "/data"]
