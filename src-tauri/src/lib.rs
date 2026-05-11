//! Diagrammer Tauri Backend
//!
//! This module provides the Rust backend for the Diagrammer desktop application,
//! including WebSocket server for Protected Local mode collaboration.

mod auth;
mod mcp;
mod server;

use auth::{
    create_token, hash_password, verify_password, LoginResponse, SessionToken, TokenConfig, User,
    UserInfo, UserRole, UserStore,
};
use mcp::{McpServer, McpStatus};
use server::{get_local_ips, ServerConfig, ServerStatus, WebSocketServer};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tokio::sync::RwLock;

/// Application state for managing server mode and other runtime config
pub struct AppState {
    /// Whether the app is running in Protected Local (server) mode
    pub server_mode: AtomicBool,
    /// WebSocket server instance
    pub server: Arc<RwLock<WebSocketServer>>,
    /// User store for authentication
    pub user_store: Arc<UserStore>,
    /// JWT token configuration
    pub token_config: TokenConfig,
    /// Embedded MCP server (foundation scope: read + single shape draft)
    pub mcp_server: Arc<RwLock<Option<Arc<McpServer>>>>,
}

/// Get the current server mode status
#[tauri::command]
fn get_server_mode(state: tauri::State<AppState>) -> bool {
    state.server_mode.load(Ordering::Relaxed)
}

/// Set the server mode (Protected Local on/off)
#[tauri::command]
fn set_server_mode(state: tauri::State<AppState>, enabled: bool) {
    state.server_mode.store(enabled, Ordering::Relaxed);
    log::info!("Server mode set to: {}", enabled);
}

/// Get app version from Cargo.toml
#[tauri::command]
fn get_app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Get the current server status
#[tauri::command]
async fn get_server_status(state: tauri::State<'_, AppState>) -> Result<ServerStatus, String> {
    let server = state.server.read().await;
    Ok(server.status().await)
}

/// Get the current server configuration
#[tauri::command]
async fn get_server_config(state: tauri::State<'_, AppState>) -> Result<ServerConfig, String> {
    let server = state.server.read().await;
    Ok(server.get_config().await)
}

/// Update server configuration (only when server is not running)
#[tauri::command]
async fn set_server_config(
    state: tauri::State<'_, AppState>,
    config: ServerConfig,
) -> Result<(), String> {
    let server = state.server.read().await;
    server.set_config(config).await
}

/// Get available LAN IP addresses for client connections
#[tauri::command]
fn get_lan_addresses() -> Vec<String> {
    get_local_ips()
        .iter()
        .map(|ip| ip.to_string())
        .collect()
}

/// Start the WebSocket server for Protected Local mode
#[tauri::command]
async fn start_server(state: tauri::State<'_, AppState>, port: u16) -> Result<String, String> {
    let server = state.server.read().await;

    if server.is_running() {
        return Err("Server is already running".to_string());
    }

    // Drop read lock and acquire write lock
    drop(server);

    let server = state.server.write().await;
    let result = server.start(port).await?;

    // Update server mode
    state.server_mode.store(true, Ordering::Relaxed);

    log::info!("WebSocket server started: {}", result);
    Ok(result)
}

/// Stop the WebSocket server
#[tauri::command]
async fn stop_server(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let server = state.server.write().await;
    server.stop().await?;

    // Update server mode
    state.server_mode.store(false, Ordering::Relaxed);

    log::info!("WebSocket server stopped");
    Ok(())
}

// ============ Authentication Commands ============

/// Login with username and password
#[tauri::command]
fn login(state: tauri::State<AppState>, username: String, password: String) -> LoginResponse {
    // Find user by username
    let user = match state.user_store.get_user_by_username(&username) {
        Some(u) => u,
        None => {
            log::warn!("Login failed: user '{}' not found", username);
            return LoginResponse {
                success: false,
                user: None,
                token: None,
                error: Some("Invalid username or password".to_string()),
            };
        }
    };

    // Verify password
    match verify_password(&password, &user.password_hash) {
        Ok(true) => {}
        Ok(false) => {
            log::warn!("Login failed: invalid password for user '{}'", username);
            return LoginResponse {
                success: false,
                user: None,
                token: None,
                error: Some("Invalid username or password".to_string()),
            };
        }
        Err(e) => {
            log::error!("Password verification error: {}", e);
            return LoginResponse {
                success: false,
                user: None,
                token: None,
                error: Some("Authentication error".to_string()),
            };
        }
    }

    // Update last login time
    let _ = state.user_store.update_last_login(&user.id);

    // Create JWT token
    let (token, expires_at) = match create_token(
        &user.id,
        &user.username,
        &user.role.to_string(),
        &state.token_config,
    ) {
        Ok(t) => t,
        Err(e) => {
            log::error!("Token creation error: {}", e);
            return LoginResponse {
                success: false,
                user: None,
                token: None,
                error: Some("Failed to create session".to_string()),
            };
        }
    };

    log::info!("User '{}' logged in successfully", username);

    LoginResponse {
        success: true,
        user: Some(UserInfo::from(&user)),
        token: Some(SessionToken { token, expires_at }),
        error: None,
    }
}

/// Validate a JWT token and return user info
#[tauri::command]
fn validate_token(state: tauri::State<AppState>, token: String) -> LoginResponse {
    // Validate the token
    let claims = match auth::validate_token(&token, &state.token_config) {
        Ok(c) => c,
        Err(e) => {
            log::debug!("Token validation failed: {}", e);
            return LoginResponse {
                success: false,
                user: None,
                token: None,
                error: Some("Invalid or expired token".to_string()),
            };
        }
    };

    // Get the user
    let user = match state.user_store.get_user(&claims.sub) {
        Some(u) => u,
        None => {
            log::warn!("Token valid but user '{}' not found", claims.sub);
            return LoginResponse {
                success: false,
                user: None,
                token: None,
                error: Some("User not found".to_string()),
            };
        }
    };

    LoginResponse {
        success: true,
        user: Some(UserInfo::from(&user)),
        token: None, // Don't return token on validation
        error: None,
    }
}

/// Create a new user (admin only in production)
#[tauri::command]
fn create_user(
    state: tauri::State<AppState>,
    username: String,
    password: String,
    display_name: String,
    role: String,
) -> Result<UserInfo, String> {
    // Parse role
    let user_role = match role.as_str() {
        "admin" => UserRole::Admin,
        "user" => UserRole::User,
        _ => return Err("Invalid role".to_string()),
    };

    // Hash password
    let password_hash = hash_password(&password)?;

    // Generate user ID
    let id = nanoid::nanoid!();

    // Get current timestamp
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let user = User {
        id,
        display_name: display_name.clone(),
        username: username.clone(),
        password_hash,
        role: user_role,
        created_at,
        last_login_at: None,
    };

    state.user_store.add_user(user.clone())?;

    log::info!("User '{}' created", username);

    Ok(UserInfo::from(&user))
}

/// Check if any users exist (for initial setup)
#[tauri::command]
fn has_users(state: tauri::State<AppState>) -> bool {
    state.user_store.has_users()
}

/// List all users (returns UserInfo without password hashes)
#[tauri::command]
fn list_users(state: tauri::State<AppState>) -> Vec<UserInfo> {
    state
        .user_store
        .list_users()
        .iter()
        .map(UserInfo::from)
        .collect()
}

/// Update a user's role (admin only)
#[tauri::command]
fn update_user_role(
    state: tauri::State<AppState>,
    user_id: String,
    new_role: String,
) -> Result<(), String> {
    let role = match new_role.as_str() {
        "admin" => UserRole::Admin,
        "user" => UserRole::User,
        _ => return Err("Invalid role".to_string()),
    };

    state.user_store.update_user_role(&user_id, role)?;
    log::info!("Updated role for user '{}' to '{}'", user_id, new_role);
    Ok(())
}

/// Reset a user's password (admin only)
#[tauri::command]
fn reset_user_password(
    state: tauri::State<AppState>,
    user_id: String,
    new_password: String,
) -> Result<(), String> {
    if new_password.len() < 6 {
        return Err("Password must be at least 6 characters".to_string());
    }

    let password_hash = hash_password(&new_password)?;
    state.user_store.update_user_password(&user_id, password_hash)?;
    log::info!("Reset password for user '{}'", user_id);
    Ok(())
}

/// Delete a user (admin only)
#[tauri::command]
fn delete_user(state: tauri::State<AppState>, user_id: String) -> Result<(), String> {
    let removed = state.user_store.remove_user(&user_id)?;
    if removed {
        log::info!("Deleted user '{}'", user_id);
        Ok(())
    } else {
        Err("User not found".to_string())
    }
}

// ============ Team Document Commands (Direct Access for Host) ============

/// List all team documents (host only - direct access)
#[tauri::command]
async fn list_team_documents(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<server::documents::DocumentMetadata>, String> {
    let server = state.server.read().await;
    let doc_store = server
        .get_doc_store()
        .await
        .ok_or("Server not running")?;

    Ok(doc_store.list_documents())
}

/// Save a team document (host only - direct access)
#[tauri::command]
async fn save_team_document(
    state: tauri::State<'_, AppState>,
    document: serde_json::Value,
) -> Result<(), String> {
    let doc_id = document
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("Document missing 'id' field")?
        .to_string();

    let doc_name = document
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("(unnamed)")
        .to_string();

    log::debug!("Saving team document '{}' ({})", doc_name, doc_id);

    let server = state.server.read().await;
    let doc_store = server
        .get_doc_store()
        .await
        .ok_or("Server not running")?;

    // Check if document exists (for event type)
    let is_new = doc_store.get_metadata(&doc_id).is_none();

    // Save the document
    doc_store.save_document(document)?;

    log::info!("Saved team document '{}' ({})", doc_name, doc_id);

    // Broadcast event to connected clients
    let event_type = if is_new {
        server::protocol::DocEventType::Created
    } else {
        server::protocol::DocEventType::Updated
    };
    server.broadcast_doc_event(&doc_id, event_type, None).await;

    Ok(())
}

/// Get a team document by ID (host only - direct access)
#[tauri::command]
async fn get_team_document(
    state: tauri::State<'_, AppState>,
    doc_id: String,
) -> Result<serde_json::Value, String> {
    let server = state.server.read().await;
    let doc_store = server
        .get_doc_store()
        .await
        .ok_or("Server not running")?;

    doc_store.get_document(&doc_id)
}

/// Delete a team document (host only - direct access)
#[tauri::command]
async fn delete_team_document(
    state: tauri::State<'_, AppState>,
    doc_id: String,
) -> Result<bool, String> {
    log::debug!("Deleting team document: {}", doc_id);

    let server = state.server.read().await;
    let doc_store = server
        .get_doc_store()
        .await
        .ok_or("Server not running")?;

    let deleted = doc_store.delete_document(&doc_id)?;

    if deleted {
        log::info!("Deleted team document: {}", doc_id);

        // Broadcast delete event to connected clients
        server
            .broadcast_doc_event(&doc_id, server::protocol::DocEventType::Deleted, None)
            .await;
    }

    Ok(deleted)
}

// ============ MCP Server Commands ============

/// Get current MCP server status (running, port, address).
#[tauri::command]
async fn mcp_status(state: tauri::State<'_, AppState>) -> Result<McpStatus, String> {
    let guard = state.mcp_server.read().await;
    match guard.as_ref() {
        Some(server) => Ok(server.status().await),
        None => Ok(McpStatus {
            running: false,
            port: 0,
            address: String::new(),
        }),
    }
}

/// Start the MCP server (idempotent — returns error if already running).
#[tauri::command]
async fn mcp_start(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let guard = state.mcp_server.read().await;
    let server = guard
        .as_ref()
        .ok_or("MCP server not initialized")?
        .clone();
    drop(guard);
    server.start().await
}

/// Stop the MCP server.
#[tauri::command]
async fn mcp_stop(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let guard = state.mcp_server.read().await;
    let server = guard
        .as_ref()
        .ok_or("MCP server not initialized")?
        .clone();
    drop(guard);
    server.stop().await
}

/// Return the current MCP bearer token (for display in Settings UI).
#[tauri::command]
async fn mcp_get_token(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let guard = state.mcp_server.read().await;
    let server = guard
        .as_ref()
        .ok_or("MCP server not initialized")?
        .clone();
    drop(guard);
    Ok(server.get_token().await)
}

/// Replace the MCP bearer token with a user-supplied value. The new token
/// must use the URL-safe alphabet [A-Za-z0-9_-] and be 16–128 characters.
/// Returns the trimmed token that was persisted.
#[tauri::command]
async fn mcp_set_token(
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<String, String> {
    let guard = state.mcp_server.read().await;
    let server = guard
        .as_ref()
        .ok_or("MCP server not initialized")?
        .clone();
    drop(guard);
    server.set_token(&token).await
}

/// Push a snapshot of a renderer-owned ("local") document into the MCP
/// local mirror so MCP clients can read it. No-op if local access is
/// disabled — the frontend should skip calling this in that case, but we
/// also guard server-side as a safety net.
#[tauri::command]
async fn mcp_mirror_local_document(
    state: tauri::State<'_, AppState>,
    document: serde_json::Value,
) -> Result<(), String> {
    let guard = state.mcp_server.read().await;
    let server = guard
        .as_ref()
        .ok_or("MCP server not initialized")?
        .clone();
    drop(guard);
    if !server.feature_config().local_access_enabled() {
        return Ok(());
    }
    server.local_mirror().mirror(document)
}

/// Remove a previously mirrored local document.
#[tauri::command]
async fn mcp_unmirror_local_document(
    state: tauri::State<'_, AppState>,
    doc_id: String,
) -> Result<bool, String> {
    let guard = state.mcp_server.read().await;
    let server = guard
        .as_ref()
        .ok_or("MCP server not initialized")?
        .clone();
    drop(guard);
    server.local_mirror().unmirror(&doc_id)
}

/// Wipe the entire local-document mirror. Called when the user disables
/// local access from Settings.
#[tauri::command]
async fn mcp_clear_local_mirror(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let guard = state.mcp_server.read().await;
    let server = guard
        .as_ref()
        .ok_or("MCP server not initialized")?
        .clone();
    drop(guard);
    server.local_mirror().clear_all()
}

/// Whether MCP clients can see renderer-owned local documents.
#[tauri::command]
async fn mcp_get_local_access(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let guard = state.mcp_server.read().await;
    let server = guard
        .as_ref()
        .ok_or("MCP server not initialized")?
        .clone();
    drop(guard);
    Ok(server.feature_config().local_access_enabled())
}

/// Toggle local document access. When turned off the mirror directory is
/// wiped so disabled clients can't read stale snapshots after a crash.
#[tauri::command]
async fn mcp_set_local_access(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<bool, String> {
    let guard = state.mcp_server.read().await;
    let server = guard
        .as_ref()
        .ok_or("MCP server not initialized")?
        .clone();
    drop(guard);
    let value = server.feature_config().set_local_access(enabled)?;
    if !enabled {
        server.local_mirror().clear_all()?;
    }
    Ok(value)
}

/// Regenerate the MCP bearer token. Existing sessions using the old token
/// will start receiving 401s on their next request.
#[tauri::command]
async fn mcp_regenerate_token(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let guard = state.mcp_server.read().await;
    let server = guard
        .as_ref()
        .ok_or("MCP server not initialized")?
        .clone();
    drop(guard);
    server.regenerate_token().await
}

use std::sync::atomic::AtomicU16;

/// Port for the local documentation server
static DOCS_SERVER_PORT: AtomicU16 = AtomicU16::new(0);

/// Middleware that rewrites clean URL paths (e.g. `/guide/welcome`) to serve
/// the corresponding `index.html` directly, avoiding ServeDir's 301 redirect
/// to a trailing-slash URL.
async fn rewrite_clean_urls(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = request.uri().path();

    // Only rewrite paths that look like clean URLs (no file extension, not root)
    if path != "/" && !path.ends_with('/') && !path.contains('.') {
        let new_path = format!("{}/index.html", path);
        if let Ok(uri) = new_path.parse::<axum::http::Uri>() {
            let (mut parts, body) = request.into_parts();
            parts.uri = uri;
            return next.run(axum::extract::Request::from_parts(parts, body)).await;
        }
    }

    next.run(request).await
}

/// Start a simple HTTP server to serve documentation
async fn start_docs_server(docs_dir: std::path::PathBuf) -> Result<u16, String> {
    use axum::{Router, routing::get_service};
    use tower_http::services::ServeDir;
    use std::net::SocketAddr;
    
    // Check if already running
    let current_port = DOCS_SERVER_PORT.load(std::sync::atomic::Ordering::Relaxed);
    if current_port != 0 {
        return Ok(current_port);
    }
    
    // Find an available port
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind docs server: {}", e))?;
    
    let port = listener.local_addr()
        .map_err(|e| format!("Failed to get local address: {}", e))?
        .port();
    
    DOCS_SERVER_PORT.store(port, std::sync::atomic::Ordering::Relaxed);
    
    let app = Router::new()
        .fallback_service(get_service(ServeDir::new(docs_dir)))
        .layer(axum::middleware::from_fn(rewrite_clean_urls));
    
    // Spawn the server in the background
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("Docs server error: {}", e);
        }
    });
    
    log::info!("Documentation server started on port {}", port);
    Ok(port)
}

/// Open the bundled documentation in the default browser
/// Starts a local HTTP server to properly serve static assets
#[tauri::command]
async fn open_docs(app: tauri::AppHandle) -> Result<(), String> {
    let online_url = "https://QR-Madness.github.io/diagrammer/";
    
    // Try multiple locations for docs directory
    let possible_paths: Vec<std::path::PathBuf> = vec![
        // Production: bundled resources
        app.path().resource_dir()
            .map(|p| p.join("docs"))
            .unwrap_or_default(),
        // Dev mode: relative to project root
        std::env::current_dir()
            .map(|p| p.join("docs-site").join("dist"))
            .unwrap_or_default(),
        // Dev mode: if running from src-tauri directory
        std::env::current_dir()
            .map(|p| p.parent().map(|parent| parent.join("docs-site").join("dist")).unwrap_or_default())
            .unwrap_or_default(),
    ];
    
    for docs_dir in possible_paths {
        let index_path = docs_dir.join("index.html");
        if index_path.exists() {
            // Start local HTTP server for docs
            let port = start_docs_server(docs_dir).await?;
            let docs_url = format!("http://127.0.0.1:{}/", port);
            log::info!("Opening local docs at: {}", docs_url);
            
            return tauri_plugin_opener::open_url(&docs_url, None::<&str>)
                .map_err(|e| format!("Failed to open docs: {}", e));
        }
    }
    
    // Fall back to online docs
    log::info!("Local docs not found, opening online: {}", online_url);
    tauri_plugin_opener::open_url(online_url, None::<&str>)
        .map_err(|e| format!("Failed to open docs: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize devtools FIRST, before builder (debug builds only)
    #[cfg(debug_assertions)]
    let devtools = tauri_plugin_devtools::init();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    // Add devtools plugin in debug builds
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(devtools);
    }

    builder
        .setup(|app| {
            // Initialize logging in release mode only (devtools handles logging in debug)
            #[cfg(not(debug_assertions))]
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;

            // Log startup
            log::info!("Diagrammer v{} starting...", env!("CARGO_PKG_VERSION"));

            // Initialize UserStore with persistence
            // Get app data directory for user persistence
            let app_data_dir = app.path().app_data_dir()
                .map_err(|e| format!("Failed to get app data directory: {}", e))?;

            // Ensure directory exists
            std::fs::create_dir_all(&app_data_dir)
                .map_err(|e| format!("Failed to create app data directory: {}", e))?;

            // Create users.json path
            let users_path = app_data_dir.join("users.json");
            let users_path_str = users_path.to_string_lossy().to_string();

            log::info!("User store path: {}", users_path_str);

            // Initialize UserStore with persistence
            let user_store = Arc::new(UserStore::with_persistence(users_path_str));
            let has_existing_users = user_store.has_users();
            log::info!("Existing users found: {}", has_existing_users);

            // Initialize WebSocket server with app data directory
            let server = WebSocketServer::new();
            let token_config = TokenConfig::default();

            // Use tokio runtime to set async properties
            let app_data_dir_clone = app_data_dir.clone();
            let jwt_secret = token_config.secret.clone();
            let user_store_clone = user_store.clone();
            let token_config_clone = token_config.clone();
            tauri::async_runtime::block_on(async {
                server.set_app_data_dir(app_data_dir_clone).await;
                server.set_jwt_secret(jwt_secret).await;
                server.set_user_store(user_store_clone).await;
                server.set_token_config(token_config_clone).await;
            });

            log::info!("WebSocket server initialized with document store and user store");

            let server_arc = Arc::new(RwLock::new(server));

            // Build the MCP server. on_doc_changed forwards into the
            // WebSocketServer's broadcast so connected clients reload the
            // mutated doc. We capture an Arc to the same RwLock the rest
            // of AppState uses, dispatched onto the Tauri async runtime.
            let server_for_mcp = server_arc.clone();
            let on_doc_changed: Arc<dyn Fn(String) + Send + Sync> =
                Arc::new(move |doc_id: String| {
                    let server = server_for_mcp.clone();
                    tauri::async_runtime::spawn(async move {
                        let guard = server.read().await;
                        guard
                            .broadcast_doc_event(
                                &doc_id,
                                server::protocol::DocEventType::Updated,
                                None,
                            )
                            .await;
                    });
                });

            let mcp_server = match McpServer::new(app_data_dir.clone(), on_doc_changed) {
                Ok(s) => Some(Arc::new(s)),
                Err(e) => {
                    log::error!("Failed to initialize MCP server: {}", e);
                    None
                }
            };

            // Auto-start the MCP server so external clients (Claude Code)
            // can connect as soon as the app is running.
            if let Some(server) = mcp_server.as_ref() {
                let server = server.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = server.start().await {
                        log::error!("MCP server failed to start: {}", e);
                    }
                });
            }

            app.manage(AppState {
                server_mode: AtomicBool::new(false),
                server: server_arc,
                user_store,
                token_config,
                mcp_server: Arc::new(RwLock::new(mcp_server)),
            });

            // Set window icon (for development mode - bundle icons handle production)
            if let Some(window) = app.get_webview_window("main") {
                // Load icon from embedded PNG bytes
                let icon_bytes = include_bytes!("../icons/icon.png");
                match tauri::image::Image::from_bytes(icon_bytes) {
                    Ok(icon) => {
                        if let Err(e) = window.set_icon(icon) {
                            log::warn!("Failed to set window icon: {}", e);
                        } else {
                            log::info!("Window icon set successfully");
                        }
                    }
                    Err(e) => log::warn!("Failed to load icon: {}", e),
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_server_mode,
            set_server_mode,
            get_app_version,
            get_server_status,
            get_server_config,
            set_server_config,
            get_lan_addresses,
            start_server,
            stop_server,
            // Authentication
            login,
            validate_token,
            create_user,
            has_users,
            // User management
            list_users,
            update_user_role,
            reset_user_password,
            delete_user,
            // Team documents (direct host access)
            list_team_documents,
            save_team_document,
            get_team_document,
            delete_team_document,
            // Documentation
            open_docs,
            // MCP server
            mcp_status,
            mcp_start,
            mcp_stop,
            mcp_get_token,
            mcp_regenerate_token,
            mcp_set_token,
            mcp_mirror_local_document,
            mcp_unmirror_local_document,
            mcp_clear_local_mirror,
            mcp_get_local_access,
            mcp_set_local_access,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Diagrammer");
}
