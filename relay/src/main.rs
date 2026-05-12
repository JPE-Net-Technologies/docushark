//! Diagrammer Relay binary entry point.
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

use diagrammer_relay::auth::UserStore;
use diagrammer_relay::config::{NetworkMode, RelayConfig};
use diagrammer_relay::server::{NetworkMode as ServerNetworkMode, ServerConfig, WebSocketServer};

#[derive(Parser, Debug)]
#[command(name = "relay", version, about = "Diagrammer Relay server")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Generate a `relay.toml` with default settings and a fresh JWT secret.
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
        } => {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            runtime.block_on(run_serve(config, port, data_dir))
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
    log::info!("wrote {} (with a fresh JWT secret)", config.display());
    log::info!(
        "edit it to taste, then run `relay serve --config {}`",
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

    let server = WebSocketServer::new();
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
    log::info!("diagrammer-relay sync listener on {}", bound);
    log::info!("storage root: {}", config.storage.path.display());

    // TODO(Slice D.2): wire McpServer here when config.mcp.enabled.
    if config.mcp.enabled {
        log::info!(
            "MCP endpoint configured for port {} (wiring lands in Slice D.2)",
            config.mcp.port
        );
    }

    log::info!("press Ctrl-C to shut down");
    tokio::signal::ctrl_c().await?;
    log::info!("shutdown requested");

    server
        .stop()
        .await
        .map_err(|e| anyhow::anyhow!("failed to stop relay cleanly: {}", e))?;
    Ok(())
}
