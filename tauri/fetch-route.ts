/** Web requests to other sites go through Rust (no browser CORS), like Electron's main process did. */
export function routedThroughRust(url: string, pageOrigin: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const u = new URL(url);
  // Tauri's own addresses (Windows: http://ipc.localhost for every command, http://tauri.localhost for
  // the page, http://vimmi-file.localhost for images) must stay in the page: routing them through Rust
  // would send the request through the same IPC again, forever, and the app would never start.
  if (u.hostname.endsWith(".localhost")) return false;
  return u.origin !== pageOrigin;
}
