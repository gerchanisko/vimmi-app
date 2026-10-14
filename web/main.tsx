// Entry point of the web app (PWA): installs the browser backend, then starts the same UI as the desktop app.
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

// Offline support: cache the app after the first visit.
if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => void navigator.serviceWorker.register("./sw.js"));
}
