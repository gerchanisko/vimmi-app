//! Vimmi desktop (Rust/Tauri beta): the window, the vault on disk, settings and secrets.
//! The notes, sync and AI logic is the shared TypeScript core (shared/), the same one the web app
//! runs; this crate replaces the Electron main process (electron/).

mod electron_import;
mod mcp;
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
    /** A found update and, once downloaded and verified, its bytes. */
    update: Mutex<Option<(tauri_plugin_updater::Update, Option<Vec<u8>>)>>,
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
    /** Where to ask for the newest release (tests point it at a mock). */
    update_feed: Option<String>,
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
        update_feed: std::env::var("VIMMI_UPDATE_FEED").ok().filter(|v| !v.is_empty()),
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
    // First start after the update from the Electron app: take its vault, sync and AI choices.
    if let Some(old) = electron_dir().map(|d| d.join("settings.json")) {
        if let Ok(json) = std::fs::read_to_string(old) {
            return Ok(StoredSettings { json: Some(json), imported: true });
        }
    }
    Ok(StoredSettings { json: None, imported: false })
}

#[tauri::command]
fn settings_write(app: AppHandle, json: String) -> Res<()> {
    let dir = config_dir(&app)?;
    vault::atomic_write(&dir.join("settings.json"), json.as_bytes()).map(|_| ())
}

/// The Electron app's settings folder; tests point it elsewhere, and a test profile never reads the real one.
fn electron_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("VIMMI_ELECTRON_DIR") {
        return Some(PathBuf::from(dir));
    }
    if std::env::var("VIMMI_USER_DATA").is_ok() {
        return None;
    }
    electron_import::electron_dir()
}

/// Copies the API keys and GitHub token saved by the Electron app into the keyring (first start
/// after the update). Keys already saved here win. Returns the ids that were taken over.
#[tauri::command]
fn import_electron_keys(app: AppHandle) -> Res<Vec<String>> {
    let Some(dir) = electron_dir() else { return Ok(Vec::new()) };
    let cfg = config_dir(&app)?;
    let mut taken = Vec::new();
    for (id, value) in electron_import::read_keys(&dir) {
        if secrets::get(&cfg, &id)?.is_none() {
            secrets::set(&cfg, &id, Some(&value))?;
            taken.push(id);
        }
    }
    Ok(taken)
}

// ---------- updates ----------

/// How this install updates: "auto" (Windows installer, AppImage: the updater plugin), "script"
/// (Linux install.sh in ~/.local/opt/vimmi: run the installer again), "none" (development).
#[tauri::command]
fn update_method() -> &'static str {
    match std::env::var("VIMMI_UPDATE_METHOD").as_deref() {
        Ok("auto") => return "auto",
        Ok("script") => return "script",
        Ok("none") => return "none",
        _ => {}
    }
    if cfg!(debug_assertions) {
        return "none";
    }
    if cfg!(windows) || std::env::var_os("APPIMAGE").is_some() {
        return "auto";
    }
    let script_dir = dirs::home_dir().map(|h| h.join(".local/opt/vimmi"));
    match (std::env::current_exe(), script_dir) {
        (Ok(exe), Some(dir)) if exe.starts_with(&dir) => "script",
        _ => "none",
    }
}

/// Variables the AppImage runtime (AppRun and its GTK hook) sets for Vimmi itself. Programs Vimmi
/// starts (the update script and its curl, Claude Code) must not inherit them: with the bundled
/// libraries first on LD_LIBRARY_PATH, the system's curl fails ("symbol lookup error").
const APPIMAGE_VARS: [&str; 20] = [
    "LD_LIBRARY_PATH", "LD_PRELOAD", "PYTHONPATH", "QT_PLUGIN_PATH", "GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GTK_DATA_PREFIX", "GTK_THEME", "GTK_EXE_PREFIX", "GTK_PATH", "GTK_IM_MODULE_FILE", "GDK_PIXBUF_MODULE_FILE",
    "GSETTINGS_SCHEMA_DIR", "GI_TYPELIB_PATH", "GIO_MODULE_DIR", "GIO_EXTRA_MODULES", "APPDIR", "APPIMAGE", "ARGV0", "OWD",
];

/// The environment changes for a program started from inside the AppImage: variables to remove
/// (None) and lists to set without the AppImage's own folders. Nothing outside an AppImage.
fn host_env(vars: &[(String, String)]) -> Vec<(String, Option<String>)> {
    let Some(appdir) = vars.iter().find(|(k, _)| k == "APPDIR").map(|(_, v)| v.trim_end_matches('/').to_string()) else {
        return Vec::new();
    };
    if appdir.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<(String, Option<String>)> = APPIMAGE_VARS.iter().map(|k| (k.to_string(), None)).collect();
    for name in ["PATH", "XDG_DATA_DIRS"] {
        if let Some((_, v)) = vars.iter().find(|(k, _)| k == name) {
            let kept: Vec<&str> = v.split(':').filter(|p| !p.is_empty() && !p.starts_with(&appdir)).collect();
            out.push((name.to_string(), Some(kept.join(":"))));
        }
    }
    out
}

/// A command for a program of the user's system, without the AppImage's environment.
pub(crate) fn host_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    let vars: Vec<(String, String)> = std::env::vars().collect();
    for (k, v) in host_env(&vars) {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
    cmd
}

/// The updater; development builds may point it at a test server, key and file (never release builds).
fn updater(app: &AppHandle) -> Res<tauri_plugin_updater::Updater> {
    use tauri_plugin_updater::UpdaterExt;
    let mut b = app.updater_builder();
    if cfg!(debug_assertions) {
        if let Ok(url) = std::env::var("VIMMI_UPDATE_ENDPOINT") {
            b = b.endpoints(vec![url.parse().map_err(|e: url::ParseError| e.to_string())?]).map_err(|e| e.to_string())?;
        }
        if let Ok(key) = std::env::var("VIMMI_UPDATE_PUBKEY") {
            b = b.pubkey(key);
        }
        if let Ok(exe) = std::env::var("VIMMI_UPDATE_EXE") {
            b = b.executable_path(exe);
        }
    }
    b.build().map_err(|e| e.to_string())
}

/// Checks GitHub Releases (latest.json) for a newer signed version; returns its number.
#[tauri::command]
async fn updater_check(app: AppHandle, state: State<'_, AppState>) -> Res<Option<String>> {
    let found = updater(&app)?.check().await.map_err(|e| e.to_string())?;
    let version = found.as_ref().map(|u| u.version.clone());
    *state.update.lock().unwrap() = found.map(|u| (u, None));
    Ok(version)
}

/// Downloads the found update and checks its signature; progress goes to the page in percent.
#[tauri::command]
async fn updater_download(state: State<'_, AppState>, on_progress: tauri::ipc::Channel<u32>) -> Res<()> {
    let update = state.update.lock().unwrap().as_ref().map(|(u, _)| u.clone()).ok_or("Žádná aktualizace.")?;
    let mut done: u64 = 0;
    let bytes = update
        .download(
            |chunk, total| {
                done += chunk as u64;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let _ = on_progress.send(((done * 100) / total).min(100) as u32);
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    if let Some(entry) = state.update.lock().unwrap().as_mut() {
        entry.1 = Some(bytes);
    }
    Ok(())
}

/// Installs the downloaded update (Windows: the installer takes over; AppImage: the file is replaced).
#[tauri::command]
fn updater_install(state: State<'_, AppState>) -> Res<()> {
    let guard = state.update.lock().unwrap();
    let Some((update, Some(bytes))) = guard.as_ref() else { return Err("Aktualizace ještě není stažená.".into()) };
    update.install(bytes).map_err(|e| e.to_string())
}

/// Linux (install.sh): runs the installer of the given release, which installs the new version.
#[tauri::command]
async fn run_install_script(version: String) -> Res<()> {
    let ok = version.split('.').count() == 3 && version.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if !ok {
        return Err(format!("Neplatná verze: {version}"));
    }
    let tag = format!("v{version}");
    let command = std::env::var("VIMMI_UPDATE_COMMAND").unwrap_or_else(|_| {
        format!("curl -fsSL https://raw.githubusercontent.com/gerchanisko/vimmi-app/{tag}/install.sh | bash -s -- --update")
    });
    let log_file = dirs::data_dir().ok_or("Chybí složka dat")?.join("vimmi").join("update.log");
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(log_file.parent().unwrap()).map_err(|e| e.to_string())?;
        let log = std::fs::File::create(&log_file).map_err(|e| e.to_string())?;
        let status = host_command("bash")
            .args(["-c", &command])
            .env("VIMMI_NONINTERACTIVE", "1")
            .env("VIMMI_BRANCH", &tag)
            .stdin(std::process::Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
        let text = std::fs::read_to_string(&log_file).unwrap_or_default();
        let tail: Vec<_> = text.trim().lines().rev().take(3).collect();
        let tail: Vec<_> = tail.into_iter().rev().collect();
        Err(format!("Aktualizace selhala ({}). Podrobnosti v {}.", tail.join(" "), log_file.display()))
    })
    .await
    .map_err(|e| e.to_string())?
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

/// Startup steps go to startup.log in the settings folder (a fresh file each start), so a start that
/// stops halfway shows where. VIMMI_EXIT_AFTER_START (tests) closes the app once the UI is up or failed.
#[tauri::command]
fn startup_log(app: AppHandle, step: String) {
    use std::io::Write;
    let step: String = step.chars().filter(|c| !c.is_control()).take(500).collect();
    if let Ok(dir) = config_dir(&app) {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("startup.log")) {
            let _ = writeln!(f, "{} {step}", chrono::Utc::now().format("%H:%M:%S%.3f"));
        }
    }
    if std::env::var_os("VIMMI_EXIT_AFTER_START").is_some() && (step.starts_with("ui ready") || step.starts_with("error")) {
        app.exit(if step.starts_with("error") { 1 } else { 0 });
    }
}

fn start_log(app: &AppHandle) {
    if let Ok(dir) = config_dir(app) {
        let _ = std::fs::create_dir_all(&dir);
        let head = format!("Vimmi {} ({} {})\n", app.package_info().version, std::env::consts::OS, std::env::consts::ARCH);
        let _ = std::fs::write(dir.join("startup.log"), head);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .setup(|app| {
            // `vimmi --mcp`: an MCP server for the Claude apps, with a hidden window and no updates.
            if mcp::requested() {
                return Ok(mcp::start(app.handle())?);
            }
            start_log(app.handle());
            let main = app.config().app.windows.first().cloned().ok_or("no window in tauri.conf.json")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &main)?.build()?;
            Ok(())
        })
        .register_uri_scheme_protocol("vimmi-file", |ctx, req| serve_file(ctx.app_handle(), req.uri().path()))
        .invoke_handler(tauri::generate_handler![
            env_info,
            startup_log,
            settings_read,
            settings_write,
            secret_get,
            secret_set,
            secret_encrypted,
            import_electron_keys,
            update_method,
            run_install_script,
            updater_check,
            updater_download,
            updater_install,
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
            mcp::mcp_read,
            mcp::mcp_write,
            mcp::mcp_setup,
            mcp::mcp_add_to_claude_code,
            mcp::mcp_add_to_claude_desktop,
        ])
        .run(tauri::generate_context!())
        .expect("Vimmi se nepodařilo spustit");
}

#[cfg(test)]
mod tests {
    use super::host_env;

    fn vars(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn programs_started_from_the_appimage_get_the_system_environment() {
        let app = "/home/u/.local/opt/vimmi/app";
        let env = vars(&[
            ("APPDIR", app),
            ("LD_LIBRARY_PATH", "/home/u/.local/opt/vimmi/app/usr/lib/:/home/u/.local/opt/vimmi/app/lib/"),
            ("PATH", "/home/u/.local/opt/vimmi/app/usr/bin/:/home/u/.local/bin:/usr/bin"),
            ("XDG_DATA_DIRS", "/home/u/.local/opt/vimmi/app/usr/share:/usr/share"),
            ("HOME", "/home/u"),
        ]);
        let fixes = host_env(&env);
        let get = |k: &str| fixes.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("LD_LIBRARY_PATH"), Some(None));
        assert_eq!(get("APPDIR"), Some(None));
        assert_eq!(get("PATH"), Some(Some("/home/u/.local/bin:/usr/bin".into())));
        assert_eq!(get("XDG_DATA_DIRS"), Some(Some("/usr/share".into())));
        assert_eq!(get("HOME"), None);
    }

    #[test]
    fn outside_an_appimage_nothing_changes() {
        assert!(host_env(&vars(&[("LD_LIBRARY_PATH", "/opt/x"), ("PATH", "/usr/bin")])).is_empty());
    }
}
