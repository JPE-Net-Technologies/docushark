//! DocuShark Tauri Backend
//!
//! Phase 20.3 Slice E.4: Protected Local, JWT auth, MCP, and blob
//! storage all moved to the standalone `docushark-relay` binary.
//! The desktop is now a pure client; the only Rust surface that
//! remains is what the renderer can't do from JavaScript — opening
//! the bundled docs in the system browser via a tiny local static
//! server.

use std::sync::atomic::AtomicU16;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Port for the local documentation server (0 until first launch).
static DOCS_SERVER_PORT: AtomicU16 = AtomicU16::new(0);

/// Filename used to persist the custom-chrome flag across launches.
/// Lives in the OS-standard app data dir. Read at startup by the
/// setup callback so the main window is created with the correct
/// decoration flag from the start — necessary on Linux WMs that ignore
/// runtime `setDecorations` (Wayland tilers, older XFCE).
const CHROME_FLAG_FILE: &str = "chrome.json";

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
    let online_url = "https://JPE-Net-Technologies.github.io/docushark/";

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

/// Apply the dev-mode icon override to a window. Production bundles ship
/// platform-specific icons via Tauri's bundle config, but in `tauri dev`
/// we set the runtime icon from `icons/icon.png` so the recreated window
/// keeps the DocuShark icon after `reload_with_decorations` rebuilds it.
fn apply_dev_window_icon(window: &tauri::WebviewWindow) {
    let icon_bytes = include_bytes!("../icons/icon.png");
    match tauri::image::Image::from_bytes(icon_bytes) {
        Ok(icon) => {
            if let Err(e) = window.set_icon(icon) {
                log::warn!("Failed to set window icon: {}", e);
            }
        }
        Err(e) => log::warn!("Failed to load icon: {}", e),
    }
}

/// Close the main window and recreate it with the new `decorations` flag.
///
/// Needed for Linux WMs (Wayland tilers, older XFCE) that only honor
/// decoration changes at window-creation time — runtime `setDecorations`
/// calls reach the OS but are ignored. The frontend's `customChrome`
/// preference is already persisted in localStorage; the recreated window
/// reads it on mount.
///
/// `enabled` means "custom chrome on" → native `decorations(false)`.
/// Resolve the on-disk path for the persisted chrome flag.
fn chrome_flag_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {}", e))?;
    Ok(dir.join(CHROME_FLAG_FILE))
}

/// Read the persisted `customChrome` flag. Defaults to `false` on any
/// I/O or parse error — the worst case is the user sees native chrome
/// once and re-toggles.
fn read_custom_chrome(app: &tauri::AppHandle) -> bool {
    let Ok(path) = chrome_flag_path(app) else {
        return false;
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return false;
    };
    // Tiny format: `{"enabled":true}` or `{"enabled":false}`.
    contents.contains("\"enabled\":true")
}

/// Persist the `customChrome` flag to disk so the next call to
/// `build_main_window` (on the next launch) picks it up. Does not
/// restart — see `apply_custom_chrome` for that.
///
/// Exposed separately so the frontend can persist the flag in dev
/// mode without triggering a restart (in `tauri dev`, `app.restart()`
/// kills the cargo-spawned process without re-spawning it, so the
/// developer has to manually re-run `bun run tauri:dev` anyway).
#[tauri::command]
async fn persist_custom_chrome(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let path = chrome_flag_path(&app)?;
    let body = format!("{{\"enabled\":{}}}", enabled);
    std::fs::write(&path, body).map_err(|e| format!("write chrome flag: {}", e))?;
    log::info!("persist_custom_chrome: wrote enabled={} → {:?}", enabled, path);
    Ok(())
}

/// Persist the flag and restart the app so the main window is rebuilt
/// from scratch with the new decoration setting.
///
/// Restart is the only reliable path on Linux WMs that ignore runtime
/// `setDecorations` calls (Wayland tilers, older XFCE). Close+recreate
/// from a running app trips Tauri's last-window-closed exit logic.
///
/// Callers in dev mode should prefer `persist_custom_chrome` — see its
/// docs for why.
#[tauri::command]
async fn apply_custom_chrome(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    persist_custom_chrome(app.clone(), enabled).await?;
    log::info!("apply_custom_chrome: restarting");
    app.restart();
}

/// Resolve the URL the main window should load. Tauri's auto-substitution
/// of `devUrl` only applies to windows declared in `tauri.conf.json`; when
/// we build the window programmatically we have to wire it ourselves.
fn main_window_url(app: &tauri::AppHandle) -> WebviewUrl {
    #[cfg(debug_assertions)]
    {
        if let Some(dev_url) = app.config().build.dev_url.clone() {
            return WebviewUrl::External(dev_url);
        }
    }
    // Release / no devUrl configured → load the bundled index.html.
    let _ = app;
    WebviewUrl::default()
}

/// Build the main window programmatically, picking up the persisted
/// `customChrome` flag so Linux WMs that only honor decoration changes
/// at window-creation time get the right frame from the start.
///
/// Dev-mode caveat: in `tauri dev`, after `app.restart()` the new window
/// reconnects to Vite's dev server but the HMR pipeline doesn't re-attach
/// cleanly the way it does for conf-declared windows, so the post-restart
/// window can come up blank or with "Connection refused" until the dev
/// server is restarted alongside the app. Production bundles (which load
/// the bundled `index.html` instead of `devUrl`) are unaffected. The
/// frontend toggle surface warns the developer about this in dev mode.
fn build_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let custom_chrome = read_custom_chrome(app);
    let url = main_window_url(app);
    log::info!("build_main_window: custom_chrome={} url={:?}", custom_chrome, url);

    WebviewWindowBuilder::new(app, "main", url)
        .title("DocuShark")
        .inner_size(1400.0, 900.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .maximized(true)
        .center()
        .decorations(!custom_chrome)
        .build()
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

            log::info!("DocuShark v{} starting...", env!("CARGO_PKG_VERSION"));

            // Build the main window from code (not tauri.conf.json) so we
            // can honor the persisted customChrome flag at creation time.
            let window = build_main_window(app.handle())?;
            apply_dev_window_icon(&window);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_docs,
            apply_custom_chrome,
            persist_custom_chrome,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DocuShark");
}
