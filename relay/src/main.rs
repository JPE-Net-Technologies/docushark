//! DocuShark Relay binary entry point.
//!
//! Subcommands:
//!   `relay init`   — write a starter `relay.toml`. Operators must fill
//!                    in the `[auth]` block with their OIDC issuer
//!                    (Keycloak, dex, Authelia, ZITADEL, Supabase, or
//!                    DocuShark Cloud) before `relay serve` will run.
//!   `relay serve`  — load `relay.toml` (CLI overrides win), start the
//!                    HTTP + WebSocket sync server, and — when enabled
//!                    in config — the MCP HTTP endpoint alongside it.
//!                    Blocks until Ctrl-C, then shuts everything down
//!                    cleanly.

use std::path::PathBuf;
use std::sync::Arc;

use clap::{Parser, Subcommand};

use docushark_relay::auth::{
    JwksCache, OidcAuthState, OidcValidationConfig, RevocationSet,
};
use docushark_relay::config::{NetworkMode, RelayConfig};
use docushark_relay::mcp::{McpConfig as InternalMcpConfig, McpServer};
use docushark_relay::server::protocol::{DocEventType, DocId, WorkspaceId};
use docushark_relay::server::{NetworkMode as ServerNetworkMode, ServerConfig, WebSocketServer};

#[derive(Parser, Debug)]
#[command(name = "relay", version, about = "DocuShark Relay server")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Generate a starter `relay.toml`. Operators fill in the `[auth]`
    /// block with their OIDC issuer before `relay serve` will run.
    Init {
        #[arg(long, default_value = "relay.toml")]
        config: PathBuf,
        /// Overwrite an existing config file.
        #[arg(long)]
        force: bool,
    },
    /// Start the relay server.
    Serve {
        /// Path to the relay config file.
        #[arg(long, default_value = "relay.toml")]
        config: PathBuf,
        /// Override the TCP port from config.
        #[arg(long)]
        port: Option<u16>,
        /// Override the storage root from config.
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// DEBUG-ONLY: inject a panic in any WS handler invoked by a
        /// client whose workspace id matches this value. Hidden from
        /// `--help` and ignored in release builds. Phase 21.2 — used
        /// only by integration tests to exercise the panic-isolation
        /// boundary.
        #[arg(long, hide = true)]
        panic_tenant: Option<String>,
        /// Override `[tenancy].mode` from `relay.toml`. `shared`
        /// routes per request by the JWT `wsp` claim; `dedicated`
        /// pins the relay to one workspace and refuses mismatches.
        /// Phase 21.5.
        #[arg(long)]
        tenancy: Option<String>,
        /// Override `[tenancy].workspace_id`. Required for non-default
        /// `dedicated` deployments; ignored in `shared` mode.
        #[arg(long)]
        tenancy_workspace: Option<String>,
        /// Override the relay region (used to enforce `wsp[].region`).
        #[arg(long, default_value = "default")]
        region: String,
    },
}

fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let cli = Cli::parse();
    match cli.command {
        Command::Init { config, force } => run_init(config, force),
        Command::Serve {
            config,
            port,
            data_dir,
            panic_tenant,
            tenancy,
            tenancy_workspace,
            region,
        } => {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            runtime.block_on(run_serve(
                config,
                port,
                data_dir,
                panic_tenant,
                tenancy,
                tenancy_workspace,
                region,
            ))
        }
    }
}

fn run_init(config: PathBuf, force: bool) -> anyhow::Result<()> {
    if config.exists() && !force {
        anyhow::bail!(
            "{} already exists. Pass --force to overwrite.",
            config.display()
        );
    }
    let fresh = RelayConfig::fresh();
    std::fs::write(&config, fresh.to_toml_string()?)?;
    log::info!("wrote {}", config.display());
    log::info!(
        "fill in [auth].issuer / [auth].jwks_url / [auth].audience, then run `relay serve --config {}`",
        config.display()
    );
    Ok(())
}

async fn run_serve(
    config_path: PathBuf,
    port_override: Option<u16>,
    data_dir_override: Option<PathBuf>,
    panic_tenant: Option<String>,
    tenancy_override: Option<String>,
    tenancy_workspace_override: Option<String>,
    region: String,
) -> anyhow::Result<()> {
    // The flag is parsed in all builds (so release builds don't reject
    // unknown args), but only honoured in debug. Release builds compile
    // out the trigger field on `ServerState`.
    #[cfg(not(debug_assertions))]
    if panic_tenant.is_some() {
        log::warn!("--panic-tenant is ignored in release builds");
    }
    #[cfg(not(debug_assertions))]
    let _ = panic_tenant;
    let mut config = match RelayConfig::load(&config_path)? {
        Some(c) => {
            log::info!("loaded config from {}", config_path.display());
            c
        }
        None => {
            log::warn!(
                "{} does not exist — running with built-in defaults. Use `relay init` to create one.",
                config_path.display()
            );
            RelayConfig::default()
        }
    };

    // CLI overrides win over file values.
    if let Some(port) = port_override {
        config.server.port = port;
    }
    if let Some(dir) = data_dir_override {
        config.storage.path = dir;
    }
    if let Some(mode) = tenancy_override.as_deref() {
        config.tenancy.mode = match mode {
            "shared" => docushark_relay::config::TenancyMode::Shared,
            "dedicated" => docushark_relay::config::TenancyMode::Dedicated,
            other => anyhow::bail!("--tenancy must be 'shared' or 'dedicated' (got {})", other),
        };
    }
    if let Some(ws) = tenancy_workspace_override {
        config.tenancy.workspace_id = Some(ws);
    }

    config
        .auth
        .validate()
        .map_err(|e| anyhow::anyhow!("invalid [auth] in {}: {}", config_path.display(), e))?;

    std::fs::create_dir_all(&config.storage.path)?;

    // Build the OIDC validator + JWKS cache + revocation set. The
    // background refresh task and the polling task are spawned below.
    let jwks_cache = JwksCache::new(config.auth.jwks_url.clone());
    let revocations = RevocationSet::new();
    let auth = OidcAuthState::new(
        OidcValidationConfig {
            issuer: config.auth.issuer.clone(),
            audience: config.auth.audience.clone(),
        },
        jwks_cache.clone(),
        revocations.clone(),
    );

    // Spawn the periodic JWKS refresh (5-min cadence + 1-h fail-open
    // grace; see `token-format.md`).
    let _jwks_refresh_handle = jwks_cache.start_background_refresh();

    // Optional polling fallback for revocations. Push transport lives
    // on `POST /api/v1/internal/revoke`.
    if let (Some(url), Some(bearer)) = (
        config.auth.revocation_polling_url.clone(),
        config.auth.revocation_polling_bearer.clone(),
    ) {
        let interval = config.auth.revocation_polling_interval();
        let revocations_for_poll = revocations.clone();
        tokio::spawn(async move {
            poll_revocations(url, bearer, interval, revocations_for_poll).await;
        });
    }

    let server = Arc::new(WebSocketServer::new());
    server.set_app_data_dir(config.storage.path.clone()).await;
    server.set_auth(auth.clone()).await;
    server
        .set_revocation_push_bearer(config.auth.revocation_push_bearer.clone())
        .await;
    server.set_relay_region(region.clone()).await;
    server.set_tenancy(config.tenancy.clone()).await;
    server.set_metering_debug_log(config.observability.metering_debug_log);
    log::info!(
        "tenancy: mode={:?} workspace_id={:?} region={}",
        config.tenancy.mode,
        config.tenancy.workspace_id.as_deref().unwrap_or(""),
        region,
    );
    #[cfg(debug_assertions)]
    if let Some(trigger) = panic_tenant {
        log::warn!(
            "DEBUG: --panic-tenant active — handlers will panic for workspace_id={}",
            trigger,
        );
        let trigger_ws = WorkspaceId::from_configured(&trigger)
            .unwrap_or_else(WorkspaceId::single_tenant);
        server.set_panic_tenant(Some(trigger_ws)).await;
    }

    let server_config = ServerConfig {
        port: config.server.port,
        network_mode: match config.server.network_mode {
            NetworkMode::Localhost => ServerNetworkMode::Localhost,
            NetworkMode::Lan => ServerNetworkMode::Lan,
        },
        max_connections: 0,
    };
    server
        .set_config(server_config)
        .await
        .map_err(|e| anyhow::anyhow!("apply server config: {}", e))?;

    let bound = server
        .start(config.server.port)
        .await
        .map_err(|e| anyhow::anyhow!("failed to start relay: {}", e))?;
    log::info!("docushark-relay sync listener on {}", bound);
    log::info!("storage root: {}", config.storage.path.display());
    log::info!(
        "oidc issuer: {} audience: {} jwks: {}",
        config.auth.issuer,
        config.auth.audience,
        config.auth.jwks_url,
    );

    let mcp = if config.mcp.enabled {
        let server_for_mcp = server.clone();
        let on_doc_changed: Arc<dyn Fn(DocId) + Send + Sync> =
            Arc::new(move |doc_id: DocId| {
                let server = server_for_mcp.clone();
                tokio::spawn(async move {
                    let ws = WorkspaceId::single_tenant();
                    server
                        .broadcast_doc_event(&ws, &doc_id, DocEventType::Updated, None)
                        .await;
                });
            });

        let panic_counter = server.panic_counter_handle();
        let rate_limit_rejections = server.rate_limit_rejections_handle();
        let write_limiter = server.build_write_limiter().await;
        match McpServer::new(
            config.storage.path.clone(),
            on_doc_changed,
            panic_counter,
            rate_limit_rejections,
            write_limiter,
            auth.clone(),
            region.clone(),
        ) {
            Ok(mcp) => {
                let mcp = Arc::new(mcp);
                mcp.set_config(InternalMcpConfig {
                    port: config.mcp.port,
                })
                .await
                .map_err(|e| anyhow::anyhow!("apply mcp config: {}", e))?;
                match mcp.start().await {
                    Ok(addr) => {
                        log::info!("MCP endpoint on {}", addr);
                        log::info!("MCP bearer token: {}", mcp.get_token().await);
                        Some(mcp)
                    }
                    Err(e) => {
                        log::error!("failed to start MCP endpoint: {}", e);
                        log::warn!("relay sync listener stays up; MCP is disabled this run");
                        None
                    }
                }
            }
            Err(e) => {
                log::error!("failed to initialize MCP server: {}", e);
                None
            }
        }
    } else {
        log::info!("MCP endpoint disabled in config");
        None
    };

    log::info!("press Ctrl-C to shut down");
    tokio::signal::ctrl_c().await?;
    log::info!("shutdown requested");

    if let Some(mcp) = mcp {
        if let Err(e) = mcp.stop().await {
            log::warn!("MCP shutdown error: {}", e);
        }
    }

    server
        .stop()
        .await
        .map_err(|e| anyhow::anyhow!("failed to stop relay cleanly: {}", e))?;
    Ok(())
}

/// Polling fallback for the revocation transport (see
/// `relay/docs/api/revocation.md`). Loops at the configured cadence,
/// fetches new revocations since the last successful poll, and applies
/// them to the in-memory set. On any error, `since` is *not* advanced;
/// the next loop iteration retries.
async fn poll_revocations(
    url: String,
    bearer: String,
    interval: std::time::Duration,
    revocations: RevocationSet,
) {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("reqwest client");
    let mut since = chrono::Utc::now() - chrono::Duration::days(1);
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let response = client
            .get(&url)
            .bearer_auth(&bearer)
            // Emit the JS-interoperable RFC3339 subset: `Z` suffix + millisecond
            // precision. Plain `to_rfc3339()` uses a numeric `+00:00` offset,
            // which some runtimes' `Date.parse` (e.g. workerd) reject, 400ing
            // the poll. `next_since` echoed back from the control plane is
            // re-normalised here too, so a populated batch can't re-break it.
            .query(&[("since", since.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))])
            .send()
            .await;
        let body = match response {
            Ok(r) if r.status().is_success() => r.json::<docushark_relay::auth::RevocationBatch>().await,
            Ok(r) => {
                log::warn!("revocation poll: HTTP {}", r.status());
                continue;
            }
            Err(e) => {
                log::warn!("revocation poll: {}", e);
                continue;
            }
        };
        match body {
            Ok(batch) => {
                if !batch.revocations.is_empty() {
                    log::info!("revocation poll: applied {} entries", batch.revocations.len());
                    revocations.revoke_many(&batch.revocations);
                }
                if let Some(next) = batch.next_since {
                    since = next;
                }
            }
            Err(e) => log::warn!("revocation poll: decode {}", e),
        }
    }
}
