// End-to-end test of the Rust desktop app (Tauri beta) through WebDriver (tauri-driver + WebKitWebDriver):
// a temporary vault and settings, a mock AI server, a fake GitHub; clicks through the main features.
// Usage: npx tauri build --debug --no-bundle && node scripts/build-electron.mjs && node test/tauri-smoke.mjs [binary]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apiUrl, chatRequests, server } from "./mock-ai.mjs";
import { FakeGitHub, serveFakeGitHub } from "../dist-electron/fake-github-for-test.mjs";
import { sampleNotes } from "../dist-electron/sample-for-test.cjs";

const binary = path.resolve(process.argv[2] ?? "src-tauri/target/debug/vimmi-beta");
const shots = path.resolve("test/screenshots-tauri");
fs.mkdirSync(shots, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vimmi-tauri-"));
const userData = path.join(tmp, "user-data");
const vaultDir = path.join(tmp, "Trezor");
fs.mkdirSync(userData, { recursive: true });
for (const [rel, content] of Object.entries(sampleNotes(new Date().toISOString().slice(0, 10)))) {
  fs.mkdirSync(path.dirname(path.join(vaultDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, rel), content);
}
const read = (rel) => fs.readFileSync(path.join(vaultDir, rel), "utf8");

const gh = new FakeGitHub();
const ghApi = await serveFakeGitHub(gh);
fs.writeFileSync(
  path.join(userData, "settings.json"),
  JSON.stringify({
    vaultPath: vaultDir,
    recentVaults: [vaultDir],
    theme: "light",
    approvalMode: "auto",
    provider: "custom",
    baseUrls: { custom: `${apiUrl}/v1` },
    models: { custom: "mock-model" },
    sync: { enabled: true, owner: "me", repo: "notes" },
  }),
);

// ---------- tiny WebDriver client ----------
const port = 4444 + Math.floor(Math.random() * 500);
const driver = spawn(path.join(os.homedir(), ".cargo/bin/tauri-driver"), ["--port", String(port)], {
  env: { ...process.env, VIMMI_USER_DATA: userData, VIMMI_NO_KEYRING: "1", VIMMI_GITHUB_TOKEN: "t", VIMMI_GITHUB_API: ghApi.url },
  stdio: ["ignore", "ignore", "pipe"],
});
let driverLog = "";
driver.stderr.on("data", (d) => (driverLog += d));
const base = `http://127.0.0.1:${port}`;
async function wd(method, url, body) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (json.value && json.value.error) throw new Error(`${json.value.error}: ${json.value.message}`);
  return json.value;
}
for (let i = 0; i < 100; i++) {
  try {
    await fetch(`${base}/status`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
const session = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: binary } } } });
const sid = session.sessionId;
const S = (u) => `/session/${sid}${u}`;
const js = (script, ...args) => wd("POST", S("/execute/sync"), { script, args });
const jsAsync = (script, ...args) => wd("POST", S("/execute/async"), { script, args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn().catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}
const waitFor = (sel, ms) => until(sel, () => js("return !!document.querySelector(arguments[0])", sel), ms);
const elementKey = "element-6066-11e4-a52e-4f735466cecf";
/** Clicks the first element matching the selector (and containing the text, if given) like a user. */
async function click(sel, text) {
  let el;
  await until(`${sel} ${text ?? ""}`, async () => {
    el = await js(
      "const t = arguments[1]; return [...document.querySelectorAll(arguments[0])].find((e) => e.offsetParent !== null && (!t || e.textContent.includes(t))) || null",
      sel,
      text ?? null,
    );
    return Boolean(el);
  });
  await js("arguments[0].scrollIntoView({block: 'center'})", el);
  await wd("POST", S(`/element/${el[elementKey]}/click`), {});
}
const KEYS = { Control: "", Enter: "", End: "", Home: "", Escape: "", Shift: "" };
/** Presses a combination like "Control+k" or types text. */
async function press(combo) {
  const parts = combo.split("+").map((k) => KEYS[k] ?? k);
  const down = parts.map((value) => ({ type: "keyDown", value }));
  const up = [...parts].reverse().map((value) => ({ type: "keyUp", value }));
  await wd("POST", S("/actions"), { actions: [{ type: "key", id: "kb", actions: [...down, ...up] }] });
  await wd("DELETE", S("/actions"));
}
async function type(text) {
  const actions = [];
  for (const ch of text) {
    const value = ch === "\n" ? KEYS.Enter : ch;
    actions.push({ type: "keyDown", value }, { type: "keyUp", value });
  }
  await wd("POST", S("/actions"), { actions: [{ type: "key", id: "kb", actions }] });
}
async function shot(name) {
  const b64 = await wd("GET", S("/screenshot"));
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(b64, "base64"));
}
const api = (body, ...args) => jsAsync(`const done = arguments[arguments.length - 1]; (async () => { ${body} })().then(done, (e) => done({ __error: String(e && e.message || e) }))`, ...args);
async function apiOk(body, ...args) {
  const r = await api(body, ...args);
  if (r && r.__error) throw new Error(r.__error);
  return r;
}

const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  await fn();
  console.log("ok");
};
let failed = false;

try {
  await step("the window opens the vault from the settings, as a desktop app", async () => {
    await waitFor(".workspace", 30000);
    await waitFor(".cm-content");
    const info = await js("return { kind: window.vimmi.app.kind, platform: window.vimmi.app.platform, title: document.title }");
    if (info.kind !== "desktop" || info.platform !== "linux") throw new Error(JSON.stringify(info));
    const version = await apiOk("return window.vimmi.app.version()");
    if (!/beta/.test(version)) throw new Error(`version ${version}`);
    await sleep(400);
    await shot("01-welcome");
  });

  await step("editing autosaves to disk (through Rust)", async () => {
    await click(".tab-pane:not([hidden]) .cm-content");
    await press("Control+End");
    await type("\nNapsáno v Rust betě [[Nápady]] #test");
    await until("saved", async () => read("Vítej ve Vimmi.md").includes("Napsáno v Rust betě"));
  });

  await step("wikilink autocomplete", async () => {
    await type("\n[[Ces");
    await waitFor(".cm-tooltip-autocomplete");
    await press("Enter");
    await until("completion saved", async () => read("Vítej ve Vimmi.md").includes("[[Cesty]]"));
  });

  await step("spotlight search (Ctrl+K)", async () => {
    await press("Control+k");
    await waitFor(".palette");
    await type("krkonose");
    await sleep(400);
    await shot("02-spotlight");
    await press("Enter");
    await until("note opened", async () => /Cesty|Nápady/.test(await js("return document.querySelector('.tab.active .tab-label')?.textContent || ''")));
  });

  await step("reading mode renders links", async () => {
    await press("Control+e");
    await waitFor(".tab-pane:not([hidden]) article.markdown a.wikilink");
    await press("Control+e");
  });

  await step("Today view + toggling a task writes the file", async () => {
    await click(".side-nav *", "Dnes");
    await waitFor(".tab-pane:not([hidden]) .today-view");
    await shot("03-today");
    await click(".side-nav *", "Úkoly");
    await waitFor(".tab-pane:not([hidden]) .task-row");
    const box = await js(
      "const row = [...document.querySelectorAll('.tab-pane:not([hidden]) .task-row')].find((r) => r.textContent.includes('Napsat sekci')); return row && row.querySelector('input[type=checkbox]')",
    );
    await wd("POST", S(`/element/${box[elementKey]}/click`), {});
    await until("task toggled", async () => /- \[x\] Napsat sekci Časté otázky/.test(read("Projekty/Web Vimmi.md")));
  });

  await step("projects and graph views", async () => {
    await click(".side-nav *", "Projekty");
    await waitFor(".tab-pane:not([hidden]) .project-card");
    await click(".side-nav *", "Graf");
    await waitFor(".tab-pane:not([hidden]) .graph-canvas canvas");
    await sleep(1200);
    await shot("04-graph");
  });

  await step("images: binary save through Rust and display through vimmi-file://", async () => {
    const saved = await apiOk(`
      const c = document.createElement("canvas"); c.width = 640; c.height = 400;
      const g = c.getContext("2d"); g.fillStyle = "#0d7480"; g.fillRect(0, 0, 640, 400);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      return window.vimmi.vault.attachment("Fotka z testu.png", new Uint8Array(await blob.arrayBuffer()));
    `);
    const bytes = fs.readFileSync(path.join(vaultDir, saved));
    if (bytes.subarray(1, 4).toString() !== "PNG") throw new Error(`not a PNG at ${saved}`);
    const size = await apiOk(
      `const img = new Image(); img.src = window.vimmi.vault.fileUrl(arguments[0]); await img.decode(); return [img.naturalWidth, img.naturalHeight];`,
      saved,
    );
    if (size[0] !== 640 || size[1] !== 400) throw new Error(`image shows as ${size}`);
    const blocked = await api(`const img = new Image(); img.src = window.vimmi.vault.fileUrl("../../etc/passwd"); await img.decode(); return "loaded";`);
    if (blocked === "loaded") throw new Error("a file outside the vault was served");
  });

  await step("a file changed outside the app shows up (Rust file watcher)", async () => {
    fs.writeFileSync(path.join(vaultDir, "Z venku.md"), "# Z venku\n\nNapsáno jiným editorem.\n");
    await until("outside note listed", async () => apiOk("return (await window.vimmi.vault.snapshot()).notes.some((n) => n.path === 'Z venku.md')"));
  });

  await step("rename and trash keep the vault consistent", async () => {
    await apiOk(`await window.vimmi.vault.rename("Z venku.md", "Archiv/Z venku.md")`);
    if (!fs.existsSync(path.join(vaultDir, "Archiv", "Z venku.md"))) throw new Error("not renamed");
    await apiOk(`await window.vimmi.vault.trash("Archiv/Z venku.md")`);
    if (fs.existsSync(path.join(vaultDir, "Archiv", "Z venku.md"))) throw new Error("not trashed");
    if (!fs.readdirSync(path.join(vaultDir, ".trash")).some((f) => f.endsWith("Z venku.md"))) throw new Error("not in .trash");
    const escaped = await api(`await window.vimmi.vault.write("../mimo.md", "x"); return "written"`);
    if (escaped === "written" || fs.existsSync(path.join(tmp, "mimo.md"))) throw new Error("wrote outside the vault");
  });

  await step("Google Calendar subscription downloads through Rust (no CORS)", async () => {
    await press("Control+,");
    await click(".settings-nav *", "Kalendář");
    await click("input[aria-label='Název kalendáře']");
    await type("Google");
    await click("input[aria-label='Adresa kalendáře']");
    await type(`${apiUrl}/private-secret/basic.ics`);
    await click("button", "Přidat kalendář");
    await until("calendar downloaded", () => js("return [...document.querySelectorAll('.cal-sub')].some((e) => e.textContent.includes('1 událostí'))"), 15000);
    await shot("05-calendar-settings");
    const file = path.join("Kalendář", "Odebírané", "Google.ics");
    if (!read(file).includes("Porada z Googlu")) throw new Error("calendar not saved into the vault");
    if (read(file).includes("private-secret")) throw new Error("secret address leaked into the vault");
    await press("Escape");
  });

  await step("AI chat streams through Rust and its tool writes the note", async () => {
    await press("Control+j");
    await waitFor(".chat-input textarea");
    await click(".ai-chat button[title='Nový chat']");
    await click(".chat-input textarea");
    await type("Přidej úkol koupit mapu\n");
    await until("AI answer", () => js("return document.body.innerText.includes('Hotovo (compat)')"), 20000);
    await shot("06-ai-chat");
    if (!/- \[ \] Koupit mapu Krkonoš !2/.test(read("Cesty.md"))) throw new Error("AI tool not applied");
    if (!chatRequests.some((r) => r.messages.some((m) => m.role === "tool"))) throw new Error("tool result not sent back");
  });

  await step("history: the AI edit can be restored", async () => {
    const versions = await apiOk(`return window.vimmi.vault.versions("Cesty.md")`);
    const before = versions.find((v) => v.source === "ai");
    if (!before) throw new Error(`no version before the AI edit: ${JSON.stringify(versions.map((v) => v.source))}`);
    const text = await apiOk(`return window.vimmi.vault.version("Cesty.md", arguments[0])`, before.id);
    await apiOk(`await window.vimmi.vault.restore("Cesty.md", arguments[0])`, text);
    if (read("Cesty.md").includes("Koupit mapu Krkonoš")) throw new Error("not restored");
  });

  await step("AI keys: saved privately, never in the vault or settings", async () => {
    await apiOk(`await window.vimmi.settings.setKey("gemini", "AIza-test-key")`);
    const s = await apiOk(`return window.vimmi.settings.get()`);
    if (!s.keys.gemini) throw new Error("key not reported");
    const stored = JSON.parse(fs.readFileSync(path.join(userData, "secrets.json"), "utf8"));
    if (stored.gemini !== "AIza-test-key") throw new Error("key not stored");
    if ((fs.statSync(path.join(userData, "secrets.json")).mode & 0o777) !== 0o600) throw new Error("key file readable by others");
    if (fs.readFileSync(path.join(userData, "settings.json"), "utf8").includes("AIza")) throw new Error("key in settings.json");
    await apiOk(`await window.vimmi.settings.setKey("gemini", null)`);
    if (fs.existsSync(path.join(userData, "secrets.json")) && JSON.parse(fs.readFileSync(path.join(userData, "secrets.json"), "utf8")).gemini) throw new Error("key not removed");
  });

  await step("GitHub sync: uploads the vault and brings a change from another device", async () => {
    await until("notes in the repository", async () => Boolean(gh.snapshot()["Projekty/Web Vimmi.md"]), 30000);
    if (gh.snapshot()["Nápady.md"] !== read("Nápady.md")) throw new Error("content differs");
    await gh.externalCommit("Z telefonu.md", "# Z telefonu\n\nNapsáno na iPhonu.\n");
    await apiOk("await window.vimmi.sync.now()");
    await until("phone note on disk", async () => fs.existsSync(path.join(vaultDir, "Z telefonu.md")), 30000);
  });

  await step("phone calendar: a secret gist is created", async () => {
    const st = await apiOk("return window.vimmi.calendar.feedEnable()");
    if (gh.gists.size !== 1 || [...gh.gists.values()][0].public) throw new Error(`secret gist not created: ${JSON.stringify(st)}`);
  });

  await step("settings persist on disk and dark theme switches", async () => {
    await press("Control+,");
    await click(".settings-nav *", "Obecné");
    await click("button", "Tmavý");
    await until("dark theme applied", () => js("return document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.body).backgroundColor !== 'rgb(255, 255, 255)'"));
    await press("Escape");
    await sleep(500);
    await shot("07-dark");
    const saved = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
    if (saved.theme !== "dark" || saved.provider !== "custom") throw new Error("settings not saved");
  });

  const errs = await js("return [...document.querySelectorAll('.error, .toast.error')].map((e) => e.textContent).filter(Boolean)");
  if (errs.length) console.log("UI errors shown:", errs);
} catch (err) {
  failed = true;
  console.log("FAILED");
  console.error(err);
  await shot("failure").catch(() => {});
} finally {
  await wd("DELETE", `/session/${sid}`).catch(() => {});
  driver.kill();
  server.close();
  ghApi.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) {
  if (driverLog) console.error(driverLog.slice(-2000));
  process.exit(1);
}
console.log(`Tauri smoke test passed. Screenshots: ${shots}`);
process.exit(0);
