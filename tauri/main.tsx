// Entry point of the Rust desktop app (Tauri beta): installs the backend, then starts the same UI.
import { installBackend } from "./backend";
import "../src/styles.css";

async function start() {
  await installBackend();
  const [{ StrictMode }, { createRoot }, { default: App }] = await Promise.all([import("react"), import("react-dom/client"), import("../src/App")]);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

start().catch((err) => {
  document.getElementById("root")!.innerHTML = `<p style="padding:24px;font-family:system-ui">Vimmi se nepodařilo spustit: ${String(err?.message ?? err)}</p>`;
});
