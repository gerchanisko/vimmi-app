// Entry point of the desktop app (Rust/Tauri): installs the backend, then starts the same UI.
// Until the UI is up the window says what it is doing (and startup.log records it), never a blank window.
import { installBackend, startStep } from "./backend";
import "../src/styles.css";

const root = document.getElementById("root")!;
root.innerHTML = `<p id="start-status" style="padding:24px;font:14px system-ui;color:#888">Vimmi se spouští…</p>`;

async function start() {
  await installBackend();
  const [{ StrictMode }, { createRoot }, { default: App }] = await Promise.all([import("react"), import("react-dom/client"), import("../src/App")]);
  root.innerHTML = "";
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // The UI counts as up once React has put something on the screen.
  for (let i = 0; i < 200 && !root.childElementCount; i++) await new Promise((r) => setTimeout(r, 50));
  startStep(root.childElementCount ? "ui ready" : "error: the UI did not appear");
}

start().catch((err) => {
  const message = String(err?.message ?? err);
  startStep(`error: ${message}`);
  root.innerHTML = `<p style="padding:24px;font:14px system-ui;color:#c33">Vimmi se nepodařilo spustit: ${message.replace(/</g, "&lt;")}</p>`;
});

// Errors after the start also go to startup.log.
window.addEventListener("error", (e) => startStep(`error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => startStep(`error (async): ${String(e.reason?.message ?? e.reason)}`));
