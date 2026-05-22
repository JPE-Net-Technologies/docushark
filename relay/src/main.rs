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
        } => {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            runtime.block_on(run_serve(config, port, data_dir))
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
) -> anyhow::Result<()> {
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

        match McpServer::new(config.storage.path.clone(), on_doc_changed) {
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
