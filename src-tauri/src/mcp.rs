//! `vimmi --mcp`: Vimmi as an MCP server for Claude Code, Claude Desktop and other MCP clients.
//!
//! The client starts this process and talks JSON-RPC over stdin/stdout. The protocol and the tools
//! are the shared TypeScript core (shared/ai/mcp.ts, the same tools the in-app AI uses), running in
//! a hidden window (tauri/mcp.ts); this side only moves lines between stdio and that window and
//! sets Vimmi up in the user's Claude apps. The client brings its own Claude account: Vimmi never
//! sees or stores Claude credentials.

use std::io::{BufRead, Write};
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::{mpsc, Mutex};

/// True when the process was started as an MCP server.
pub fn requested() -> bool {
    std::env::args().skip(1).any(|a| a == "--mcp")
}

pub struct McpInput(Mutex<mpsc::UnboundedReceiver<String>>);

/// Reads stdin line by line for the hidden window and quits when the client closes it.
pub fn start(app: &AppHandle) -> tauri::Result<()> {
    let (tx, rx) = mpsc::unbounded_channel();
    app.manage(McpInput(Mutex::new(rx)));
    let handle = app.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
        handle.exit(0);
    });
    // Its own browser data, so it never collides with an open Vimmi window.
    let data = app.path().app_local_data_dir()?.join("mcp-webview");
    WebviewWindowBuilder::new(app, "mcp", WebviewUrl::App("mcp.html".into()))
        .title("Vimmi MCP")
        .visible(false)
        .data_directory(data)
        .build()?;
    Ok(())
}

/// The next message from the client, or None once it has gone.
#[tauri::command]
pub async fn mcp_read(input: State<'_, McpInput>) -> Result<Option<String>, String> {
    Ok(input.0.lock().await.recv().await)
}

/// One message to the client (a JSON-RPC line; stdout carries nothing else).
#[tauri::command]
pub fn mcp_write(line: String) -> Result<(), String> {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{}", line.replace(['\r', '\n'], " ")).and_then(|_| out.flush()).map_err(|e| e.to_string())
}

// ---------- setting Vimmi up in Claude ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSetup {
    /// What the Claude apps start: the program and its arguments.
    command: String,
    args: Vec<String>,
    /// The line to paste into a terminal for Claude Code.
    claude_code_line: String,
    claude_code_found: bool,
    /// Claude Desktop's config file, when Claude Desktop is installed.
    claude_desktop_config: Option<String>,
    in_claude_desktop: bool,
}

/// The program the Claude apps should start: a path that survives updates.
fn server_command() -> Result<String, String> {
    // An AppImage run directly: the file itself (the running binary lives in a temporary mount).
    if let Ok(img) = std::env::var("APPIMAGE") {
        if !img.is_empty() {
            return Ok(img);
        }
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // Installed by install.sh: its launcher, which keeps working when an update replaces app/.
    if let Some(home) = dirs::home_dir() {
        let launcher = home.join(".local/opt/vimmi/vimmi");
        if exe.starts_with(home.join(".local/opt/vimmi")) && launcher.exists() {
            return Ok(launcher.to_string_lossy().into_owned());
        }
    }
    Ok(exe.to_string_lossy().into_owned())
}

fn quoted(s: &str) -> String {
    if s.chars().any(|c| c.is_whitespace() || "\"'$&()".contains(c)) {
        format!("\"{s}\"")
    } else {
        s.to_string()
    }
}

/// Claude Desktop's settings folder: the Microsoft Store build keeps it in its package folder.
fn claude_desktop_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    if let Some(local) = dirs::data_local_dir() {
        if let Ok(entries) = std::fs::read_dir(local.join("Packages")) {
            for e in entries.flatten() {
                if e.file_name().to_string_lossy().starts_with("Claude_") {
                    let dir = e.path().join("LocalCache").join("Roaming").join("Claude");
                    if dir.is_dir() {
                        return Some(dir);
                    }
                }
            }
        }
    }
    let dir = dirs::config_dir()?.join("Claude");
    dir.is_dir().then_some(dir)
}

/// The Claude Code program: on PATH, or where its installers put it (a menu-started app may not
/// have ~/.local/bin on PATH).
fn claude_code() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    let mut dirs_: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        dirs_.push(home.join(".local").join("bin"));
        dirs_.push(home.join(".claude").join("local"));
    }
    dirs_.into_iter().map(|d| d.join(exe)).find(|p| p.is_file())
}

fn desktop_config_has_vimmi(file: &std::path::Path) -> bool {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .is_some_and(|v| v.pointer("/mcpServers/vimmi").is_some())
}

#[tauri::command]
pub fn mcp_setup() -> Result<McpSetup, String> {
    let command = server_command()?;
    let config = claude_desktop_dir().map(|d| d.join("claude_desktop_config.json"));
    Ok(McpSetup {
        claude_code_line: format!("claude mcp add --scope user vimmi -- {} --mcp", quoted(&command)),
        claude_code_found: claude_code().is_some(),
        in_claude_desktop: config.as_deref().is_some_and(desktop_config_has_vimmi),
        claude_desktop_config: config.map(|c| c.to_string_lossy().into_owned()),
        command,
        args: vec!["--mcp".into()],
    })
}

fn run_quiet(cmd: &mut std::process::Command) -> std::io::Result<std::process::Output> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.stdin(std::process::Stdio::null()).output()
}

/// Adds Vimmi to Claude Code for all the user's projects (replacing an older entry).
#[tauri::command]
pub async fn mcp_add_to_claude_code() -> Result<(), String> {
    let claude = claude_code().ok_or("Claude Code se nepodařilo najít. Zkopíruj příkaz a spusť ho v terminálu.")?;
    let command = server_command()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _ = run_quiet(crate::host_command(&claude).args(["mcp", "remove", "--scope", "user", "vimmi"]));
        let out = run_quiet(crate::host_command(&claude).args(["mcp", "add", "--scope", "user", "vimmi", "--"]).arg(&command).arg("--mcp"))
            .map_err(|e| format!("Claude Code se nepodařilo spustit: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            let msg = String::from_utf8_lossy(&out.stderr);
            Err(format!("Claude Code odmítl přidat Vimmi: {}", msg.trim().chars().take(300).collect::<String>()))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Adds Vimmi to Claude Desktop's config, keeping everything else in it.
#[tauri::command]
pub fn mcp_add_to_claude_desktop() -> Result<(), String> {
    let dir = claude_desktop_dir().ok_or("Claude Desktop není nainstalovaný.")?;
    let file = dir.join("claude_desktop_config.json");
    add_to_desktop_config(&file, &server_command()?)
}

fn add_to_desktop_config(file: &std::path::Path, command: &str) -> Result<(), String> {
    let mut config: serde_json::Value = match std::fs::read_to_string(file) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s)
            .map_err(|_| "Nastavení Claude Desktop (claude_desktop_config.json) není platný JSON – Vimmi ho radši neměnilo.".to_string())?,
        _ => serde_json::json!({}),
    };
    let obj = config.as_object_mut().ok_or("Nastavení Claude Desktop má neočekávaný tvar.")?;
    let servers = obj.entry("mcpServers").or_insert_with(|| serde_json::json!({}));
    let servers = servers.as_object_mut().ok_or("Nastavení Claude Desktop má neočekávaný tvar (mcpServers).")?;
    servers.insert("vimmi".into(), serde_json::json!({ "command": command, "args": ["--mcp"] }));
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    crate::vault::atomic_write(file, text.as_bytes()).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_config_keeps_other_servers() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("claude_desktop_config.json");
        std::fs::write(&file, r#"{"theme":"dark","mcpServers":{"other":{"command":"x"}}}"#).unwrap();
        add_to_desktop_config(&file, "/opt/vimmi").unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["mcpServers"]["vimmi"]["command"], "/opt/vimmi");
        assert_eq!(v["mcpServers"]["vimmi"]["args"][0], "--mcp");
        assert!(desktop_config_has_vimmi(&file));
    }

    #[test]
    fn desktop_config_created_and_broken_one_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("claude_desktop_config.json");
        add_to_desktop_config(&file, "vimmi").unwrap();
        assert!(desktop_config_has_vimmi(&file));
        std::fs::write(&file, "{ broken").unwrap();
        assert!(add_to_desktop_config(&file, "vimmi").is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ broken");
    }

    #[test]
    fn paths_with_spaces_are_quoted() {
        assert_eq!(quoted("/opt/vimmi"), "/opt/vimmi");
        assert_eq!(quoted(r"C:\Users\Jan Novák\vimmi.exe"), r#""C:\Users\Jan Novák\vimmi.exe""#);
    }
}
