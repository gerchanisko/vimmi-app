// Prevents an extra console window on Windows in release; `--features gui` gives test builds the same
// (a GUI program must still pass stdio to `vimmi --mcp`).
#![cfg_attr(any(not(debug_assertions), feature = "gui"), windows_subsystem = "windows")]

fn main() {
    vimmi_lib::run();
}
