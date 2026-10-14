// Takes clean marketing screenshots of the real app with a demo vault and a scripted AI chat.
// Usage: npm run build && node scripts/screenshots.mjs <output-dir> [scale]
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { preview } from "vite";

const out = path.resolve(process.argv[2] ?? "docs/screenshots");
const scale = process.argv[3] ?? "1.5";
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vimmi-shots-"));
const userData = path.join(tmp, "user-data");
const vault = path.join(tmp, "Moje poznámky");
fs.mkdirSync(userData, { recursive: true });

const iso = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const weekday = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString("cs-CZ", { weekday: "long" });
};

// ---------- demo vault ----------
const notes = {
  "Vítej ve Vimmi.md": `# Vítej ve Vimmi\n\nKlidné místo pro poznámky, úkoly a projekty. Začni třeba [[Cíle 2026]] nebo dnešním [[${iso()}|deníkem]].\n\n- [x] Projít úvodní poznámku #začínáme\n`,
  "Projekty/Web Vimmi.md": `---\ntype: project\nstatus: aktivní\ntags: [web, design]\n---\n# Web Vimmi\n\nNový web, který ukáže skutečnou aplikaci – klidně, bez zbytečností.\n\n## Cíle\n- Jasně vysvětlit, co Vimmi umí\n- Instalace **jedním příkazem**\n- Rychlé načítání, žádné zbytečné skripty\n\n## Úkoly\n- [x] Navrhnout novou úvodní stránku ✅ ${iso(-2)}\n- [x] Nafotit snímky aplikace ✅ ${iso(-1)}\n- [ ] Napsat texty k funkcím @${iso()} !1\n- [ ] Sekce o soukromí a datech @${iso(1)} !2\n- [ ] Zkontrolovat přístupnost @${iso(3)} !3\n- [ ] Připravit náhled pro sociální sítě @${iso(4)}\n\n## Poznámky\nInspirace v [[Nápady]] a ze [[Schůzka – web|schůzky s týmem]]. Barvy podle [[Design systém]].\n\n> Méně chaosu. Více prostoru pro to důležité.\n`,
  "Projekty/Schůzka – web.md": `---\nproject: Web Vimmi\ntags: [schůzka]\n---\n# Schůzka – web\n\n**Datum:** ${iso(-1)}\n**Účastníci:** Tereza, Ondra, já\n\n## Body\n- Hlavní sdělení: méně chaosu, více prostoru pro to důležité\n- Ukázat skutečné snímky aplikace místo ilustrací\n- Instalace musí být na jeden příkaz\n\n## Úkoly\n- [ ] Poslat Tereze texty ke kontrole @${iso(2)} !2\n`,
  "Projekty/Design systém.md": `---\nproject: Web Vimmi\ntags: [design]\n---\n# Design systém\n\nAkcent \`#6D63FF\`, písmo Inter, hodně prostoru. Používá se na [[Web Vimmi]] i v aplikaci.\n`,
  "Projekty/Stěhování.md": `---\ntype: project\nstatus: aktivní\ntags: [osobní]\n---\n# Stěhování\n\n- [x] Objednat stěhováky ✅ ${iso(-3)}\n- [ ] Přehlásit adresu na úřadě @${iso(2)} !1\n- [ ] Zabalit knihovnu @${iso(5)}\n- [ ] Rozloučit se se sousedy\n`,
  "Projekty/Kniha receptů.md": `---\ntype: project\nstatus: nápad\ntags: [vaření]\n---\n# Kniha receptů\n\nSbírka rodinných receptů. Začít u [[Babiččin štrúdl]].\n\n- [ ] Sepsat 10 nejoblíbenějších receptů !3\n- [x] Vyfotit štrúdl ✅ ${iso(-6)}\n`,
  "Recepty/Babiččin štrúdl.md": `---\nproject: Kniha receptů\ntags: [vaření, recept]\n---\n# Babiččin štrúdl\n\n- 6 jablek, skořice, rozinky, listové těsto\n- Péct 40 minut na 180 °C\n`,
  "Nápady.md": `---\ntags: [nápady]\n---\n# Nápady\n\n- Vimmi pro tým – sdílené projekty\n- Víkend v Krkonoších, viz [[Krkonoše]]\n- Přečíst [[Hluboká práce]] znovu\n- Rodinná [[Kniha receptů]]\n`,
  "Cesty/Krkonoše.md": `---\ntags: [cestování]\n---\n# Krkonoše\n\nSněžka, Luční bouda, Pec pod Sněžkou.\n\n- [ ] Rezervovat chatu @${iso(6)} !2\n`,
  "Čtení/Hluboká práce.md": `---\ntags: [knihy, produktivita]\n---\n# Hluboká práce\n\nCal Newport. Soustředění je dovednost, kterou lze trénovat.\n\n> Jasnost toho, co dělat, je polovina práce.\n\nSouvisí s [[Cíle 2026]].\n`,
  "Čtení/Atomové návyky.md": `---\ntags: [knihy, produktivita]\n---\n# Atomové návyky\n\nMalé změny, velké výsledky. Viz [[Cíle 2026]].\n`,
  "Osobní/Cíle 2026.md": `---\ntags: [osobní]\n---\n# Cíle 2026\n\n- Méně obrazovky, víc čtení – [[Hluboká práce]], [[Atomové návyky]]\n- Dokončit [[Stěhování]]\n- Vydat [[Web Vimmi]]\n`,
  [`Deník/${iso(-1)}.md`]: `# ${weekday(-1)} ${iso(-1)}\n\n## Dnes\n- [x] Schůzka k webu ✅ ${iso(-1)}\n- [x] Nafotit aplikaci ✅ ${iso(-1)}\n\n## Poznámky\nDobrý den. Viz [[Schůzka – web]].\n`,
  [`Deník/${iso()}.md`]: `# ${weekday()} ${iso()}\n\n## Dnes\n- [ ] Napsat texty k funkcím pro [[Web Vimmi]] !1\n- [x] Ranní procházka ✅ ${iso()}\n- [ ] Zavolat kvůli [[Stěhování]]\n\n## Poznámky\nRáno nejvíc soustředění. Telefon do jiné místnosti – tip z [[Hluboká práce]].\n\n## Vděčnost\n- Klidné ráno a dobrá káva ☕\n`,
};
for (const [rel, content] of Object.entries(notes)) {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), content);
}

// ---------- scripted Claude reply (mock Anthropic API) ----------
const answer = `Tento týden tě čeká hlavně **[[Web Vimmi]]** a **[[Stěhování]]**:

**Dnes**
- Napsat texty k funkcím – nejvyšší priorita

**Zítra a dál**
- Sekce o soukromí a datech (zítra)
- Přehlásit adresu na úřadě (za 2 dny) – ⚠ priorita 1
- Poslat Tereze texty ke kontrole

Doporučuji začít texty k webu ráno, kdy máš podle deníku nejvíc soustředění. Mám ti z toho udělat plán do dnešní poznámky?`;

function sse(res, blocks, stop) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  send({ type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 2100, output_tokens: 0, cache_read_input_tokens: 1800 } } });
  blocks.forEach((b, index) => {
    if (b.type === "thinking") {
      send({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      send({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.text } });
      send({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "s" } });
    } else if (b.type === "text") {
      send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      send({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else {
      send({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    send({ type: "content_block_stop", index });
  });
  send({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 240 } });
  send({ type: "message_stop" });
  res.end();
}
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = JSON.parse(body || "{}");
    const last = json.messages?.at(-1);
    const toolResult = Array.isArray(last?.content) && last.content.find((c) => c.type === "tool_result");
    if (!toolResult) {
      sse(res, [
        { type: "thinking", text: "Projdu otevřené úkoly s termínem do konce týdne a seřadím je podle priority." },
        { type: "tool_use", id: "t1", name: "list_tasks", input: { status: "open", due: "week" } },
      ], "tool_use");
    } else sse(res, [{ type: "text", text: answer }], "end_turn");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

// ---------- run ----------
fs.writeFileSync(
  path.join(userData, "settings.json"),
  JSON.stringify({ vaultPath: vault, recentVaults: [vault], theme: "light", approvalMode: "auto", provider: "anthropic" }),
);
const app = await electron.launch({
  args: [".", `--force-device-scale-factor=${scale}`],
  env: { ...process.env, VIMMI_USER_DATA: userData, ANTHROPIC_API_KEY: "sk-ant-demo", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` },
});
const win = await app.browserWindow(await app.firstWindow());
await win.evaluate((w) => {
  w.setSize(1440, 900);
  w.center();
});
const page = await app.firstWindow();
const shot = async (name) => {
  await win.evaluate((w) => w.setSize(1440, 900));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log("✓", name);
};
const visible = (sel) => page.locator(`.tab-pane:not([hidden]) ${sel}`).first();
const setTheme = (t) => page.evaluate((theme) => (document.documentElement.dataset.theme = theme), t);

try {
  await page.waitForSelector(".workspace", { timeout: 20000 });
  await page.evaluate(() => localStorage.clear());

  // 1) Editor with live preview + AI chat answer
  await page.click(".side-scroll >> text=Web Vimmi");
  await visible(".cm-content").waitFor();
  await page.keyboard.press("Control+j");
  await page.fill(".chat-input textarea", "Co mě čeká tento týden?");
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=Mám ti z toho udělat plán", { timeout: 15000 });
  await page.click(".side-scroll >> text=Web Vimmi"); // move focus off the input
  await page.locator(".tab-pane:not([hidden]) .note-head").click();
  await shot("editor-ai");
  await setTheme("dark");
  await shot("editor-ai-dark");
  await setTheme("light");

  // 2) Today
  await page.keyboard.press("Control+j");
  await page.click(".side-nav >> text=Dnes");
  await visible(".today-view").waitFor();
  await shot("today");

  // 3) Projects
  await page.click(".side-nav >> text=Projekty");
  await visible(".project-card").waitFor();
  await shot("projects");

  // 4) Graph
  await page.click(".side-nav >> text=Graf");
  await visible(".graph-canvas canvas").waitFor();
  await page.click(".graph-toolbar >> text=Tagy");
  await page.waitForTimeout(2500);
  await shot("graph");

  // 5) Search
  await page.keyboard.press("Control+k");
  await page.keyboard.type("soustředění");
  await page.waitForTimeout(500);
  await shot("search");
  await page.keyboard.press("Escape");

  // 6) Dark: daily note in reading mode
  await setTheme("dark");
  await page.keyboard.press("Control+d");
  await visible(".cm-content").waitFor();
  await page.locator(".tab-pane:not([hidden]) .note-head").click();
  await shot("dark");
  await setTheme("light");
} finally {
  await app.close().catch(() => {});
  server.close();
}

// ---------- phone (web app at iPhone size; needs `npm run build:web`) ----------
if (fs.existsSync("dist-web/index.html")) {
  const web = await preview({ configFile: "vite.web.config.mts", preview: { port: 0, strictPort: false }, logLevel: "error" });
  const phoneApp = await electron.launch({
    args: [path.resolve("test/browser-main.cjs"), `--force-device-scale-factor=3`],
    env: {
      ...process.env,
      URL: web.resolvedUrls.local[0],
      UD: path.join(tmp, "phone"),
      W: "390",
      H: "844",
      UA: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    },
  });
  const ph = await phoneApp.firstWindow();
  const phoneShot = async (name) => {
    await ph.waitForTimeout(600);
    await ph.screenshot({ path: path.join(out, `${name}.png`) });
    console.log("✓", name);
  };
  try {
    await ph.waitForSelector(".welcome", { timeout: 20000 });
    await ph.evaluate(() => localStorage.setItem("vimmi:settings", JSON.stringify({ theme: "light" })));
    await ph.click("text=Začít psát");
    await ph.waitForSelector(".workspace");
    await ph.evaluate(async (all) => {
      for (const [p, text] of Object.entries(all)) await window.vimmi.vault.write(p, text);
    }, notes);
    await ph.reload();
    await ph.waitForSelector(".workspace");
    await ph.click(".bottom-bar >> text=Dnes");
    await phoneShot("phone-today");
    await ph.click(".mobile-top button[aria-label=Menu]");
    await ph.waitForTimeout(400);
    await phoneShot("phone-drawer");
    await ph.click(".drawer >> text=Web Vimmi");
    await ph.waitForTimeout(400);
    await phoneShot("phone-note");
    await ph.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    await ph.click(".bottom-bar >> text=Úkoly");
    await phoneShot("phone-tasks-dark");
  } finally {
    await phoneApp.close().catch(() => {});
    await web.close();
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
