//! DocuShark Relay binary entry point.
//!
//! Subcommands:
//!   `relay init`   — write a fresh `relay.toml` with a CSPRNG-derived
//!                    JWT secret and sensible defaults for everything
//!                    else.
//!   `relay serve`  — load `relay.toml` (CLI overrides win), start the
//!                    HTTP + WebSocket sync server, and — when enabled
//!                    in config — the MCP HTTP endpoint alongside it.
//!                    Blocks until Ctrl-C, then shuts everything down
//!                    cleanly.

use std::path::PathBuf;
use std::sync::Arc;

use clap::{Parser, Subcommand};

use docushark_relay::auth::{seed_admin, AdminSeedOptions, SeedOutcome, UserStore};
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
    /// Generate a `relay.toml` with default settings and a fresh JWT secret,
    /// and seed the first admin user.
    Init {
        #[arg(long, default_value = "relay.toml")]
        config: PathBuf,
        /// Overwrite an existing config file.
        #[arg(long)]
        force: bool,
        /// Skip the admin-bootstrap step entirely (advanced).
        #[arg(long)]
        skip_admin: bool,
        /// Username for the seeded admin (non-interactive).
        #[arg(long)]
        admin_user: Option<String>,
        /// Password for the seeded admin (non-interactive; min 8 chars).
        #[arg(long)]
        admin_password: Option<String>,
        /// Display name for the seeded admin (defaults to --admin-user).
        #[arg(long)]
        admin_display_name: Option<String>,
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
    },
}

fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let cli = Cli::parse();
    match cli.command {
        Command::Init {
            config,
            force,
            skip_admin,
            admin_user,
            admin_password,
            admin_display_name,
        } => run_init(
            config,
            force,
            AdminSeedOptions {
                username: admin_user,
                password: admin_password,
                display_name: admin_display_name,
                skip: skip_admin,
            },
        ),
        Command::Serve {
            config,
            port,
            data_dir,
            panic_tenant,
            tenancy,
            tenancy_workspace,
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
            ))
        }
    }
}

fn run_init(config: PathBuf, force: bool, admin: AdminSeedOptions) -> anyhow::Result<()> {
    if config.exists() && !force {
        anyhow::bail!(
            "{} already exists. Pass --force to overwrite.",
            config.display()
        );
    }
    let fresh = RelayConfig::fresh();
    std::fs::write(&config, fresh.to_toml_string()?)?;
    log::info!("wrote {} (with a fresh JWT secret)", config.display());

    let users_path = fresh.storage.path.join("users.json");
    match seed_admin(&users_path, admin)? {
        SeedOutcome::Seeded { username } => {
            log::info!(
                "seeded admin user '{}' in {}",
                username,
                users_path.display()
            );
        }
        SeedOutcome::SkippedExisting { count } => {
            log::info!(
                "{} already has {} user(s); leaving it alone",
                users_path.display(),
                count
            );
        }
        SeedOutcome::SkippedByFlag => {
            log::warn!(
                "admin bootstrap skipped (--skip-admin); register a user via POST /api/auth/register before logging in"
            );
        }
    }

    log::info!(
        "edit {} to taste, then run `relay serve --config {}`",
        config.display(),
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

    if config.auth.jwt_secret.is_empty() {
        log::warn!(
            "no jwt_secret configured — falling back to a built-in development secret. \
             Run `relay init` to generate one and put it in {}.",
            config_path.display()
        );
    }

    std::fs::create_dir_all(&config.storage.path)?;

    let users_path = config.storage.path.join("users.json");
    let user_store = Arc::new(UserStore::with_persistence(
        users_path.to_string_lossy().into_owned(),
    ));

    let server = Arc::new(WebSocketServer::new());
    server.set_app_data_dir(config.storage.path.clone()).await;
    server.set_user_store(user_store).await;
    if !config.auth.jwt_secret.is_empty() {
        server.set_jwt_secret(config.auth.jwt_secret.clone()).await;
    }
    server.set_tenancy(config.tenancy.clone()).await;
    log::info!(
        "tenancy: mode={:?} workspace_id={:?}",
        config.tenancy.mode,
        config.tenancy.workspace_id.as_deref().unwrap_or(""),
    );
    #[cfg(debug_assertions)]
    if let Some(trigger) = panic_tenant {
        log::warn!(
            "DEBUG: --panic-tenant active — handlers will panic for workspace_id={}",
            trigger,
        );
        // The CLI hands us a raw string; translate it into the typed
        // WorkspaceId by using the same single-tenant constructor when
        // it matches, or a thin debug-only From impl otherwise. Today
        // only "default" is meaningful (single-tenant), so the simplest
        // path is to accept any string for now — 21.5 will hand the
        // trigger a real workspace claim to compare against.
        let trigger_ws = if trigger == docushark_relay::server::protocol::WorkspaceId::single_tenant().as_str() {
            docushark_relay::server::protocol::WorkspaceId::single_tenant()
        } else {
            // Until 21.5, no non-default workspace exists. Fall back to
            // single-tenant so the flag at least exercises the boundary
            // for integration tests, and log the mismatch.
            log::warn!(
                "--panic-tenant={} does not match the current single-tenant workspace; falling back to single_tenant() for the trigger",
                trigger,
            );
            docushark_relay::server::protocol::WorkspaceId::single_tenant()
        };
        server.set_panic_tenant(Some(trigger_ws)).await;
    }

    let server_config = ServerConfig {
        port: config.server.port,
        network_mode: match config.server.network_mode {
            NetworkMode::Localhost => ServerNetworkMode::Localhost,
            NetworkMode::Lan => ServerNetworkMode::Lan,
        },
        // max_connections=0 means unlimited — the relay isn't trying to
        // gate concurrent clients via the connection count (the Storage
        // backend bounds throughput). Slice D may revisit.
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

    let mcp = if config.mcp.enabled {
        // Bridge MCP doc-write events into the WS broadcast channel so
        // connected sync clients reload the affected doc. Mirrors what
        // the Tauri host did in src-tauri/src/lib.rs.
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
        let write_limiter = server.build_write_limiter().await;
        let jwt_config = server.current_token_config().await;
        match McpServer::new(
            config.storage.path.clone(),
            on_doc_changed,
            panic_counter,
            write_limiter,
            jwt_config,
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
