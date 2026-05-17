//! Diagrammer Tauri Backend
//!
//! Phase 20.3 Slice E.4: Protected Local, JWT auth, MCP, and blob
//! storage all moved to the standalone `diagrammer-relay` binary.
//! The desktop is now a pure client; the only Rust surface that
//! remains is what the renderer can't do from JavaScript — opening
//! the bundled docs in the system browser via a tiny local static
//! server.

use std::sync::atomic::AtomicU16;
use tauri::Manager;

/// Port for the local documentation server (0 until first launch).
static DOCS_SERVER_PORT: AtomicU16 = AtomicU16::new(0);

/// Rewrite clean URL paths (e.g. `/guide/welcome`) to the matching
/// `index.html` so the bundled docs site works without ServeDir's
/// 301-to-trailing-slash dance.
async fn rewrite_clean_urls(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = request.uri().path();
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

/// Spawn (or reuse) a localhost HTTP server that serves `docs_dir`.
/// Returns the bound port.
async fn start_docs_server(docs_dir: std::path::PathBuf) -> Result<u16, String> {
    use axum::{routing::get_service, Router};
    use tower_http::services::ServeDir;

    let current_port = DOCS_SERVER_PORT.load(std::sync::atomic::Ordering::Relaxed);
    if current_port != 0 {
        return Ok(current_port);
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind docs server: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {}", e))?
        .port();
    DOCS_SERVER_PORT.store(port, std::sync::atomic::Ordering::Relaxed);

    let app = Router::new()
        .fallback_service(get_service(ServeDir::new(docs_dir)))
        .layer(axum::middleware::from_fn(rewrite_clean_urls));

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("Docs server error: {}", e);
        }
    });

    log::info!("Documentation server started on port {}", port);
    Ok(port)
}

/// Open the bundled documentation in the system browser. Falls back
/// to the hosted docs site if no bundled copy is present.
#[tauri::command]
async fn open_docs(app: tauri::AppHandle) -> Result<(), String> {
    let online_url = "https://QR-Madness.github.io/diagrammer/";

    let candidates: Vec<std::path::PathBuf> = vec![
        // Production: bundled resources.
        app.path()
            .resource_dir()
            .map(|p| p.join("docs"))
            .unwrap_or_default(),
        // Dev: relative to project root.
        std::env::current_dir()
            .map(|p| p.join("docs-site").join("dist"))
            .unwrap_or_default(),
        // Dev: running from src-tauri/.
        std::env::current_dir()
            .map(|p| {
                p.parent()
                    .map(|parent| parent.join("docs-site").join("dist"))
                    .unwrap_or_default()
            })
            .unwrap_or_default(),
    ];

    for docs_dir in candidates {
        if docs_dir.join("index.html").exists() {
            let port = start_docs_server(docs_dir).await?;
            let url = format!("http://127.0.0.1:{}/", port);
            log::info!("Opening local docs at: {}", url);
            return tauri_plugin_opener::open_url(&url, None::<&str>)
                .map_err(|e| format!("Failed to open docs: {}", e));
        }
    }

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

            log::info!("Diagrammer v{} starting...", env!("CARGO_PKG_VERSION"));

            // Set window icon (for development mode - bundle icons handle production)
            if let Some(window) = app.get_webview_window("main") {
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
        .invoke_handler(tauri::generate_handler![open_docs])
        .run(tauri::generate_context!())
        .expect("error while running Diagrammer");
}
