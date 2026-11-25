// `vimmi --mcp` end to end, the way Claude Code starts it: JSON-RPC lines over stdin/stdout.
//   node test/mcp-stdio.mjs [path to vimmi binary]   (default: the debug build)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const exe = process.argv[2] ?? path.resolve("src-tauri/target/debug", process.platform === "win32" ? "vimmi.exe" : "vimmi");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vimmi-mcp-"));
const vaultDir = path.join(tmp, "Trezor");
fs.mkdirSync(vaultDir, { recursive: true });
fs.mkdirSync(path.join(tmp, "cfg"));
fs.writeFileSync(path.join(vaultDir, "Nákup.md"), "# Nákup\n- [ ] Mléko @2026-11-26\n");
fs.writeFileSync(path.join(tmp, "cfg", "settings.json"), JSON.stringify({ vaultPath: vaultDir }));

const child = spawn(exe, ["--mcp"], { env: { ...process.env, VIMMI_USER_DATA: path.join(tmp, "cfg") }, stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
const stray = [];
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    stray.push(line);
    return;
  }
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});
let next = 1;
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => reject(new Error(`no reply to ${method} within 60 s`)), 60_000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const check = (ok, what) => {
  if (!ok) throw new Error(what);
  console.log(`ok  ${what}`);
};

try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  check(init.result?.serverInfo?.name === "vimmi", `initialize (Vimmi ${init.result?.serverInfo?.version})`);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await rpc("tools/list");
  check(list.result.tools.some((t) => t.name === "add_task"), `tools/list (${list.result.tools.length} tools)`);
  const tasks = await rpc("tools/call", { name: "list_tasks", arguments: {} });
  check(tasks.result.content[0].text.includes("Mléko"), "list_tasks reads the vault");
  const add = await rpc("tools/call", { name: "add_task", arguments: { text: "Chleba", note: "Nákup" } });
  check(!add.result.isError && fs.readFileSync(path.join(vaultDir, "Nákup.md"), "utf8").includes("- [ ] Chleba"), "add_task writes the note");
  check(stray.length === 0, "stdout carries only JSON-RPC");
  // Closing stdin (the client quits) ends the server.
  const exited = new Promise((r) => child.on("exit", r));
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 15_000))]);
  check(code !== "timeout", "exits when the client closes stdin");
  console.log("MCP server works.");
} catch (err) {
  console.error(`FAIL ${err.message}`);
  if (stray.length) console.error("stray stdout:", stray.slice(0, 5));
  child.kill();
  process.exitCode = 1;
} finally {
  setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 500);
}
