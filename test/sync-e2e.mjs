// End-to-end sync test: the desktop app and the web app (at iPhone size) sync through a fake GitHub.
// Usage: npm run build && npm run build:web && node test/sync-e2e.mjs [screenshot-dir]
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { preview } from "vite";
import { FakeGitHub, serveFakeGitHub } from "../dist-electron/fake-github-for-test.mjs";
import { sampleNotes } from "../dist-electron/sample-for-test.cjs";

const shots = path.resolve(process.argv[2] ?? "test/screenshots");
fs.mkdirSync(shots, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vimmi-sync-e2e-"));
const vaultDir = path.join(tmp, "Trezor");
const desktopData = path.join(tmp, "desktop-data");
const phoneData = path.join(tmp, "phone-data");
fs.mkdirSync(desktopData, { recursive: true });
for (const [rel, content] of Object.entries(sampleNotes(new Date().toISOString().slice(0, 10)))) {
  fs.mkdirSync(path.dirname(path.join(vaultDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, rel), content);
}
const read = (rel) => fs.readFileSync(path.join(vaultDir, rel), "utf8");
const noSandbox = process.env.CI && process.platform === "linux" ? ["--no-sandbox"] : [];

// Minimal OpenAI-compatible AI server (with CORS, as the phone calls it straight from the browser).
const aiServer = http.createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  if (req.url.endsWith("/models")) return res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "mock", object: "model" }] }));
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = JSON.parse(body);
    const done = json.messages.at(-1).role === "tool";
    res.writeHead(200, { ...cors, "Content-Type": "text/event-stream" });
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (done) {
      chunk({ role: "assistant", content: "Hotovo – úkol je v [[Úkoly]]." });
      chunk({}, "stop");
    } else {
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "add_task", arguments: JSON.stringify({ text: "Koupit mléko", priority: 2 }) } }] });
      chunk({}, "tool_calls");
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => aiServer.listen(0, "127.0.0.1", r));
const aiUrl = `http://127.0.0.1:${aiServer.address().port}/v1`;

const gh = new FakeGitHub();
const api = await serveFakeGitHub(gh);
const web = await preview({ configFile: "vite.web.config.mts", preview: { port: 0, strictPort: false, open: false }, logLevel: "error" });
const webUrl = web.resolvedUrls.local[0];

async function until(what, fn, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for: ${what}`);
}
const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  await fn();
  console.log("ok");
};

fs.writeFileSync(
  path.join(desktopData, "settings.json"),
  JSON.stringify({ vaultPath: vaultDir, recentVaults: [vaultDir], theme: "light", sync: { enabled: true, owner: "me", repo: "notes" } }),
);
const desktop = await electron.launch({
  args: [".", ...noSandbox],
  env: { ...process.env, VIMMI_USER_DATA: desktopData, VIMMI_GITHUB_TOKEN: "t", VIMMI_GITHUB_API: api.url },
});
const phone = await electron.launch({
  args: [path.resolve("test/browser-main.cjs"), ...noSandbox],
  env: {
    ...process.env,
    URL: webUrl,
    UD: phoneData,
    W: "390",
    H: "844",
    UA: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
});
const pc = await desktop.firstWindow();
const ph = await phone.firstWindow();
await ph.setViewportSize({ width: 390, height: 844 });
const errors = [];
for (const [name, page] of [["desktop", pc], ["phone", ph]]) {
  page.on("pageerror", (e) => errors.push(`${name}: ${e}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(`${name}: ${m.text()}`));
}

try {
  await step("desktop uploads the vault on start", async () => {
    await pc.waitForSelector(".workspace", { timeout: 20000 });
    await until("notes in the repository", () => Boolean(gh.snapshot()["Projekty/Web Vimmi.md"]));
    if (gh.snapshot()["Nápady.md"] !== read("Nápady.md")) throw new Error("content differs");
    await pc.locator(".tabbar .sync-indicator.state-idle").waitFor();
  });

  await step("phone connects to GitHub through the settings wizard and downloads the notes", async () => {
    await ph.waitForSelector(".welcome", { timeout: 20000 });
    await ph.evaluate((u) => localStorage.setItem("vimmi:dev-github-api", u), api.url);
    await ph.reload();
    await ph.click("text=Mám poznámky na GitHubu");
    await ph.waitForSelector(".sync-steps");
    await ph.fill("input[placeholder='github_pat_…']", "t");
    await ph.click(".sync-steps >> text=Uložit");
    await ph.waitForSelector("text=Token funguje");
    await ph.fill("input[aria-label='Repozitář']", "me/notes");
    await ph.screenshot({ path: path.join(shots, "sync-01-phone-wizard.png") });
    await ph.click(".sync-steps >> text=Zapnout");
    await ph.waitForSelector("text=Synchronizace je zapnutá.", { timeout: 20000 });
    await ph.screenshot({ path: path.join(shots, "sync-02-phone-connected.png") });
    await ph.keyboard.press("Escape");
    await ph.click(".mobile-top button[aria-label=Menu]");
    await ph.locator(".drawer >> text=Web Vimmi").waitFor();
    await ph.screenshot({ path: path.join(shots, "sync-03-phone-notes.png") });
  });

  await step("an edit on the phone reaches the desktop file", async () => {
    await ph.click(".drawer >> text=Nápady");
    await ph.locator(".tab-pane:not([hidden]) .cm-content").click();
    await ph.keyboard.press("Control+End");
    await ph.keyboard.type("\nNapsáno na iPhonu");
    await ph.waitForTimeout(900);
    await ph.click(".mobile-top .sync-indicator");
    await until("phone edit in the repository", () => gh.snapshot()["Nápady.md"]?.includes("Napsáno na iPhonu"));
    await pc.click(".tabbar .sync-indicator");
    await until("phone edit on the desktop disk", () => read("Nápady.md").includes("Napsáno na iPhonu"));
  });

  await step("a note created on the desktop appears on the phone", async () => {
    fs.writeFileSync(path.join(vaultDir, "Z počítače.md"), "# Z počítače\n\nNapsáno na počítači.");
    await until("desktop picks up the new file", () => pc.evaluate(() => window.vimmi.vault.snapshot().then((s) => s.notes.some((n) => n.title === "Z počítače"))));
    await pc.click(".tabbar .sync-indicator");
    await until("new note in the repository", () => Boolean(gh.snapshot()["Z počítače.md"]));
    await ph.click(".mobile-top .sync-indicator");
    await ph.click(".mobile-top button[aria-label=Menu]");
    await ph.locator(".drawer >> text=Z počítače").waitFor({ timeout: 15000 });
    await ph.keyboard.press("Escape");
  });

  await step("AI on the phone (called from the browser) adds a task that syncs to the desktop", async () => {
    await ph.click(".mobile-top button[aria-label=Menu]");
    await ph.click(".drawer >> text=Nastavení");
    await ph.click(".settings-nav >> text=AI");
    await ph.click(".provider-card >> text=Vlastní");
    await ph.fill(".provider-settings .url-input >> nth=0", aiUrl);
    await ph.fill(".provider-settings .url-input >> nth=1", "mock");
    await ph.locator(".provider-settings .url-input >> nth=0").focus();
    await ph.waitForTimeout(300);
    await ph.keyboard.press("Escape");
    await ph.click(".bottom-bar >> text=AI");
    await ph.fill(".chat-input textarea", "Přidej úkol koupit mléko");
    await ph.keyboard.press("Enter");
    await ph.waitForSelector("text=Hotovo – úkol je v", { timeout: 20000 });
    await ph.screenshot({ path: path.join(shots, "sync-05-phone-ai.png") });
    const text = await ph.evaluate(() => window.vimmi.vault.read("Úkoly.md"));
    if (!text.includes("- [ ] Koupit mléko !2")) throw new Error("task not written on phone");
    await ph.click(".right-panel button[aria-label='Zavřít panel']");
    await ph.click(".mobile-top .sync-indicator");
    await until("phone task in the repository", () => gh.snapshot()["Úkoly.md"]?.includes("Koupit mléko"));
    await pc.click(".tabbar .sync-indicator");
    await until("phone task on the desktop disk", () => fs.existsSync(path.join(vaultDir, "Úkoly.md")) && read("Úkoly.md").includes("Koupit mléko"));
  });

  await step("phone keeps notes after reopening the app (offline storage)", async () => {
    await ph.evaluate(() => localStorage.setItem("vimmi:dev-github-api", "http://127.0.0.1:9/offline"));
    await ph.reload();
    await ph.waitForSelector(".workspace", { timeout: 20000 });
    await ph.click(".mobile-top button[aria-label=Menu]");
    await ph.locator(".drawer >> text=Z počítače").waitFor();
    await ph.screenshot({ path: path.join(shots, "sync-04-phone-offline.png") });
  });

  await step("phone notices a new deploy and reloads into it", async () => {
    await ph.evaluate(() => localStorage.setItem("vimmi:dev-update-check", "1"));
    await ph.route("**/version.json*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ version: "9.9.9", build: "novy-build" }) }));
    await ph.evaluate(() => window.vimmi.update.check());
    await ph.waitForSelector(".update-banner >> text=Je k dispozici nová verze Vimmi.");
    await ph.screenshot({ path: path.join(shots, "sync-06-phone-update.png") });
    await ph.unroute("**/version.json*");
    await Promise.all([ph.waitForEvent("load"), ph.click(".update-banner >> text=Obnovit")]);
    await ph.waitForSelector(".workspace", { timeout: 20000 });
  });

  const unexpected = errors.filter((e) => !/127\.0\.0\.1:9|ERR_CONNECTION_REFUSED|Failed to fetch/.test(e));
  if (unexpected.length) throw new Error(`page errors:\n${unexpected.join("\n")}`);
  console.log(`\nAll good. Screenshots in ${shots}`);
} catch (err) {
  await ph.screenshot({ path: path.join(shots, "sync-failure-phone.png") }).catch(() => {});
  await pc.screenshot({ path: path.join(shots, "sync-failure-desktop.png") }).catch(() => {});
  console.error("\nFAILED:", err.message);
  if (errors.length) console.error(errors.join("\n"));
  process.exitCode = 1;
} finally {
  await desktop.close().catch(() => {});
  await phone.close().catch(() => {});
  await web.close();
  api.close();
  aiServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
