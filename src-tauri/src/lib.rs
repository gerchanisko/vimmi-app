//! Vimmi desktop (Rust/Tauri beta): the window, the vault on disk, settings and secrets.
//! The notes, sync and AI logic is the shared TypeScript core (shared/), the same one the web app
//! runs; this crate replaces the Electron main process (electron/).

mod secrets;
mod vault;

use std::path::PathBuf;
use std::sync::Mutex;

use notify::{RecursiveMode, Watcher};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};

use vault::{FileStat, Listing};

#[derive(Default)]
struct AppState {
    root: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

impl AppState {
    fn root(&self) -> Result<PathBuf, String> {
        self.root.lock().unwrap().clone().ok_or_else(|| "Není otevřený žádný trezor.".to_string())
    }
    fn file(&self, rel: &str) -> Result<PathBuf, String> {
        vault::safe_join(&self.root()?, rel)
    }
}

type Res<T> = Result<T, String>;

// ---------- the app ----------

#[derive(Serialize)]
struct EnvInfo {
    platform: &'static str,
    hostname: String,
    version: String,
    github_api: Option<String>,
    documents: Option<String>,
    /** AI keys given as environment variables (developers), by variable name. */
    env_keys: std::collections::HashMap<String, String>,
}

#[tauri::command]
fn env_info(app: AppHandle) -> EnvInfo {
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        _ => "linux",
    };
    let mut env_keys = std::collections::HashMap::new();
    for name in ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "VIMMI_GITHUB_TOKEN"] {
        if let Ok(v) = std::env::var(name) {
            if !v.is_empty() {
                env_keys.insert(name.to_string(), v);
            }
        }
    }
    EnvInfo {
        platform,
        hostname: gethostname::gethostname().to_string_lossy().into_owned(),
        version: app.package_info().version.to_string(),
        github_api: std::env::var("VIMMI_GITHUB_API").ok().filter(|v| !v.is_empty()),
        documents: dirs::document_dir().map(|p| p.to_string_lossy().into_owned()),
        env_keys,
    }
}

fn config_dir(app: &AppHandle) -> Res<PathBuf> {
    if let Ok(dir) = std::env::var("VIMMI_USER_DATA") {
        return Ok(PathBuf::from(dir));
    }
    app.path().app_config_dir().map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct StoredSettings {
    json: Option<String>,
    /** True when the settings were copied from the Electron app on first start (keys excluded). */
    imported: bool,
}

#[tauri::command]
fn settings_read(app: AppHandle) -> Res<StoredSettings> {
    let file = config_dir(&app)?.join("settings.json");
    if let Ok(json) = std::fs::read_to_string(&file) {
        return Ok(StoredSettings { json: Some(json), imported: false });
    }
    // First start of the beta: take the vault, sync and AI choices from the Electron app.
    if std::env::var("VIMMI_USER_DATA").is_err() {
        if let Some(old) = dirs::config_dir().map(|d| d.join("Vimmi").join("settings.json")) {
            if let Ok(json) = std::fs::read_to_string(old) {
                return Ok(StoredSettings { json: Some(json), imported: true });
            }
        }
    }
    Ok(StoredSettings { json: None, imported: false })
}

#[tauri::command]
fn settings_write(app: AppHandle, json: String) -> Res<()> {
    let dir = config_dir(&app)?;
    vault::atomic_write(&dir.join("settings.json"), json.as_bytes()).map(|_| ())
}

#[tauri::command]
fn secret_get(app: AppHandle, id: String) -> Res<Option<String>> {
    secrets::get(&config_dir(&app)?, &id)
}

#[tauri::command]
fn secret_set(app: AppHandle, id: String, value: Option<String>) -> Res<()> {
    secrets::set(&config_dir(&app)?, &id, value.as_deref())
}

#[tauri::command]
fn secret_encrypted() -> bool {
    secrets::keyring_works()
}

// ---------- the vault ----------

#[tauri::command]
fn vault_open(app: AppHandle, state: State<AppState>, dir: String) -> Res<String> {
    let root = PathBuf::from(&dir);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    *state.root.lock().unwrap() = Some(root.clone());
    // Live changes made outside the app (another editor, a sync tool) reach the page as events.
    let handle = app.clone();
    let watch_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        for path in event.paths {
            let Ok(rel) = path.strip_prefix(&watch_root) else { continue };
            let rel = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
            if rel.is_empty() || vault::is_ignored(&rel) || rel.ends_with(".tmp") {
                continue;
            }
            let _ = handle.emit("vault-fs", rel);
        }
    })
    .map_err(|e| e.to_string())?;
    // Recursive watching is not available everywhere; the app still works without live outside edits.
    let _ = watcher.watch(&root, RecursiveMode::Recursive);
    *state.watcher.lock().unwrap() = Some(watcher);
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command]
fn vault_close(state: State<AppState>) {
    *state.watcher.lock().unwrap() = None;
    *state.root.lock().unwrap() = None;
}

#[tauri::command]
fn vault_abs(state: State<AppState>, rel: String) -> Res<String> {
    Ok(state.file(&rel)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn fs_list(state: State<AppState>) -> Res<Listing> {
    vault::list(&state.root()?)
}

#[tauri::command]
fn fs_read_text(state: State<AppState>, rel: String) -> Res<String> {
    std::fs::read_to_string(state.file(&rel)?).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_read_bytes(state: State<AppState>, rel: String) -> Res<Response> {
    std::fs::read(state.file(&rel)?).map(Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_write_text(state: State<AppState>, rel: String, content: String) -> Res<FileStat> {
    vault::atomic_write(&state.file(&rel)?, content.as_bytes())
}

/// Binary writes (pasted images) come as the raw request body; the path is in a header.
#[tauri::command]
fn fs_write_bytes(state: State<AppState>, request: Request) -> Res<FileStat> {
    let InvokeBody::Raw(data) = request.body() else { return Err("Chybí data souboru.".into()) };
    let rel = request.headers().get("x-vimmi-path").and_then(|v| v.to_str().ok()).ok_or("Chybí cesta souboru.")?;
    let rel = percent_decode_str(rel).decode_utf8_lossy();
    vault::atomic_write(&state.file(&rel)?, data)
}

#[tauri::command]
fn fs_stat(state: State<AppState>, rel: String) -> Res<Option<FileStat>> {
    Ok(vault::stat(&state.file(&rel)?))
}

#[tauri::command]
fn fs_mkdir(state: State<AppState>, rel: String) -> Res<()> {
    std::fs::create_dir_all(state.file(&rel)?).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_rename(state: State<AppState>, from: String, to: String) -> Res<()> {
    vault::rename(&state.file(&from)?, &state.file(&to)?)
}

#[tauri::command]
fn fs_trash(state: State<AppState>, rel: String) -> Res<()> {
    let root = state.root()?;
    vault::trash(&root, &vault::safe_join(&root, &rel)?)
}

#[tauri::command]
fn private_read(state: State<AppState>, name: String) -> Res<Option<String>> {
    Ok(std::fs::read_to_string(vault::private_path(&state.root()?, &name)?).ok())
}

#[tauri::command]
fn private_write(state: State<AppState>, name: String, content: String) -> Res<()> {
    vault::atomic_write(&vault::private_path(&state.root()?, &name)?, content.as_bytes()).map(|_| ())
}

#[tauri::command]
fn private_delete(state: State<AppState>, name: String) -> Res<()> {
    let p = vault::private_path(&state.root()?, &name)?;
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn private_list(state: State<AppState>, dir: String) -> Res<Vec<String>> {
    let p = vault::private_path(&state.root()?, &dir)?;
    Ok(std::fs::read_dir(p)
        .map(|it| it.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default())
}

/// Serves vault files (images, attachments) to the page: vimmi-file://localhost/<relative path>.
fn serve_file(app: &AppHandle, uri_path: &str) -> tauri::http::Response<Vec<u8>> {
    let respond = |status: u16, mime: &str, body: Vec<u8>| {
        tauri::http::Response::builder().status(status).header("Content-Type", mime).body(body).unwrap()
    };
    let state = app.state::<AppState>();
    let rel = percent_decode_str(uri_path.trim_start_matches('/')).decode_utf8_lossy().into_owned();
    let Ok(full) = state.file(&rel) else { return respond(403, "text/plain", b"Forbidden".to_vec()) };
    match std::fs::read(&full) {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&full).first_or_octet_stream();
            respond(200, mime.essence_str(), bytes)
        }
        Err(_) => respond(404, "text/plain", b"Not found".to_vec()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .register_uri_scheme_protocol("vimmi-file", |ctx, req| serve_file(ctx.app_handle(), req.uri().path()))
        .invoke_handler(tauri::generate_handler![
            env_info,
            settings_read,
            settings_write,
            secret_get,
            secret_set,
            secret_encrypted,
            vault_open,
            vault_close,
            vault_abs,
            fs_list,
            fs_read_text,
            fs_read_bytes,
            fs_write_text,
            fs_write_bytes,
            fs_stat,
            fs_mkdir,
            fs_rename,
            fs_trash,
            private_read,
            private_write,
            private_delete,
            private_list,
        ])
        .run(tauri::generate_context!())
        .expect("Vimmi se nepodařilo spustit");
}
