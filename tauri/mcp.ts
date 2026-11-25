// The hidden window of `vimmi --mcp`: answers MCP messages from Claude Code / Claude Desktop with the
// vault tools (shared/ai/mcp.ts). Rust passes stdin lines in (mcp_read) and replies out (mcp_write).
import { invoke } from "@tauri-apps/api/core";
import { createMcpServer, type OpenContext } from "../shared/ai/mcp";
import type { ToolEnv } from "../shared/ai/tools";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types";
import { Vault } from "../shared/vault";
import { TauriStorage } from "./storage";

async function openVault(): Promise<ToolEnv> {
  const stored = await invoke<{ json: string | null }>("settings_read");
  let settings: Settings = DEFAULT_SETTINGS;
  try {
    settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(stored.json ?? "{}") as Partial<Settings>) };
  } catch {
    // Unreadable settings: same as none.
  }
  if (!settings.vaultPath) throw new Error("Ve Vimmi zatím není vybraná složka s poznámkami. Otevři Vimmi a vyber nebo vytvoř trezor.");
  const vault = new Vault(await TauriStorage.open(settings.vaultPath));
  vault.templatesFolder = settings.templatesFolder;
  await vault.load();
  return { vault, dailyFolder: settings.dailyFolder, calendarFolder: settings.calendarFolder, openNote: () => {} };
}

let env: Promise<ToolEnv> | undefined;
const server = createMcpServer({
  version: (await invoke<{ version: string }>("env_info")).version,
  // Opened on the first tool call; a failed open is tried again on the next one.
  env: () =>
    (env ??= openVault().catch((err: unknown) => {
      env = undefined;
      throw err;
    })),
  // What the Vimmi window has open (null when Vimmi is not running).
  openContext: async () => {
    const json = await invoke<string | null>("claude_context_get");
    return json ? (JSON.parse(json) as OpenContext) : null;
  },
});

const inFlight = new Set<Promise<unknown>>();
for (;;) {
  const line = await invoke<string | null>("mcp_read");
  if (line === null) break;
  const job = server
    .handleLine(line)
    .then((reply) => reply && invoke("mcp_write", { line: reply }))
    .catch((err: unknown) => console.error(err));
  inFlight.add(job);
  void job.finally(() => inFlight.delete(job));
}
// The client closed stdin: finish the answers still in progress, then end.
await Promise.allSettled([...inFlight]);
await invoke("mcp_done");
