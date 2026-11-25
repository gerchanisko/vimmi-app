//! The Claude Code panel: a terminal inside Vimmi running the user's own, unmodified `claude`
//! program. The user signs in to Claude there themselves; Vimmi only shows the terminal (a pseudo
//! terminal: ConPTY on Windows) and never sees their Claude account. Vimmi's notes tools come along
//! through `--mcp-config` (`vimmi --mcp`, see mcp.rs).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    next: AtomicU32,
    open: Arc<Mutex<HashMap<u32, Term>>>,
}

/// What Claude is told about where it runs (added to Claude Code's own system prompt).
const CONTEXT: &str = "You run inside Vimmi, the user's notes app, in its Claude Code panel. The user's notes, tasks, projects and calendar are in their Vimmi vault: use the vimmi tools (mcp__vimmi__*) for them; changes show up in Vimmi right away. Reply in the user's language (usually Czech).";

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { cols: cols.clamp(20, 500), rows: rows.clamp(5, 300), pixel_width: 0, pixel_height: 0 }
}

/// The arguments for `claude`: Vimmi's MCP server and where it runs.
pub(crate) fn claude_args(server: &str) -> Vec<String> {
    let config = serde_json::json!({ "mcpServers": { "vimmi": { "command": server, "args": ["--mcp"] } } });
    vec!["--mcp-config".into(), config.to_string(), "--append-system-prompt".into(), CONTEXT.into()]
}

/// Starts Claude Code in a new terminal; its output goes to `on_data`, its exit code to `on_exit`.
#[tauri::command]
pub fn terminal_open(
    terms: State<Terminals>,
    app: State<crate::AppState>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let claude = crate::mcp::claude_code().ok_or("Claude Code tady není nainstalovaný.")?;
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&claude);
    cmd.args(claude_args(&crate::mcp::server_command()?));
    // Claude Code works in the open vault (or the home folder), with the system's environment.
    let cwd = app.root().ok().or_else(dirs::home_dir);
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    let vars: Vec<(String, String)> = std::env::vars().collect();
    for (k, v) in crate::host_env(&vars) {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("Claude Code se nepodařilo spustit: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = terms.next.fetch_add(1, Ordering::Relaxed) + 1;
    terms.open.lock().unwrap().insert(id, Term { master: pair.master, writer, killer: child.clone_killer() });

    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    });
    // Waiting separately: on Windows the output only ends once the terminal is closed.
    let open = terms.open.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
        open.lock().unwrap().remove(&id);
        let _ = on_exit.send(code);
    });
    Ok(id)
}

#[tauri::command]
pub fn terminal_write(terms: State<Terminals>, id: u32, data: String) -> Result<(), String> {
    let mut open = terms.open.lock().unwrap();
    let term = open.get_mut(&id).ok_or("Terminál už neběží.")?;
    term.writer.write_all(data.as_bytes()).and_then(|_| term.writer.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_resize(terms: State<Terminals>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let open = terms.open.lock().unwrap();
    let Some(term) = open.get(&id) else { return Ok(()) };
    term.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn terminal_close(terms: State<Terminals>, id: u32) {
    if let Some(mut term) = terms.open.lock().unwrap().remove(&id) {
        let _ = term.killer.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_gets_vimmi_as_mcp_server() {
        let args = claude_args(r"C:\Users\Jan Novák\AppData\Local\Vimmi\vimmi.exe");
        assert_eq!(args[0], "--mcp-config");
        let config: serde_json::Value = serde_json::from_str(&args[1]).unwrap();
        assert_eq!(config["mcpServers"]["vimmi"]["command"], r"C:\Users\Jan Novák\AppData\Local\Vimmi\vimmi.exe");
        assert_eq!(config["mcpServers"]["vimmi"]["args"][0], "--mcp");
        assert_eq!(args[2], "--append-system-prompt");
    }

    #[test]
    fn a_pseudo_terminal_runs_a_program() {
        // The same pieces as terminal_open, with a shell instead of Claude Code.
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        let mut cmd = if cfg!(windows) { CommandBuilder::new("cmd.exe") } else { CommandBuilder::new("sh") };
        if cfg!(windows) {
            cmd.args(["/C", "echo vimmi-pty-ok"]);
        } else {
            cmd.args(["-c", "echo vimmi-pty-ok"]);
        }
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut all = Vec::new();
            let mut buf = [0u8; 1024];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                all.extend_from_slice(&buf[..n]);
                if String::from_utf8_lossy(&all).contains("vimmi-pty-ok") {
                    let _ = tx.send(true);
                    return;
                }
            }
        });
        assert!(rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap_or(false));
        child.wait().unwrap();
    }
}
