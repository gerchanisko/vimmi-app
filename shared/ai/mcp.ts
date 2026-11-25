// Vimmi as an MCP server: Claude Code, Claude Desktop or another MCP client works with the vault
// through the same tools the in-app AI uses. The client runs on the user's own Claude account; Vimmi
// only answers tool calls. Transport-free: handle() takes one JSON-RPC message and returns the reply.
import { z } from "zod";
import { isoDate } from "../markdown";
import { VaultError } from "../vault";
import { TOOL_MAP, TOOLS, VAULT_GUIDE, type ToolEnv } from "./tools";

/** Protocol versions this server speaks, newest first. */
export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** Tools that only make sense inside the app window. */
const APP_ONLY = new Set(["open_note"]);
/** Write tools that change or remove what is already there (the others only add). */
const DESTRUCTIVE = new Set(["edit_note", "rename_note", "delete_note", "update_event", "delete_event"]);

type Id = string | number;
interface Message {
  jsonrpc?: string;
  id?: Id | null;
  method?: string;
  params?: Record<string, unknown>;
}
type Reply = { jsonrpc: "2.0"; id: Id | null } & ({ result: unknown } | { error: { code: number; message: string } });

/** What is open in the Vimmi window (written by the app, see src/lib/claude-context.ts). */
export interface OpenContext {
  vault: string | null;
  activePath: string | null;
  selection: string | null;
  openPaths: string[];
  /** Seconds since Vimmi wrote it. */
  age_s?: number;
}

export interface McpOptions {
  version: string;
  /** The open vault, or an explanation why there is none. */
  env: () => Promise<ToolEnv>;
  /** What is open in the Vimmi window, or null when Vimmi is not running. */
  openContext?: () => Promise<OpenContext | null>;
}

/** The tool that only the MCP server has: the note the user is looking at in Vimmi. */
const OPEN_NOTE_TOOL = {
  name: "get_open_note",
  description:
    "The note the user has open in the Vimmi window right now, with its content, the text they selected in it and the other open notes. Use it when the user means the note they are looking at (\"this note\", \"tahle poznámka\", \"tady\").",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const MAX_OPEN_NOTE = 80_000;

const MCP_TOOLS = TOOLS.filter((t) => !APP_ONLY.has(t.name));

export function mcpToolList(withOpenNote = false) {
  const vaultTools = MCP_TOOLS.map((t) => {
    const inputSchema = z.toJSONSchema(t.schema, { target: "draft-7" }) as Record<string, unknown>;
    delete inputSchema.$schema;
    return {
      name: t.name,
      description: t.description,
      inputSchema,
      annotations: { readOnlyHint: !t.write, destructiveHint: t.write && DESTRUCTIVE.has(t.name), openWorldHint: false },
    };
  });
  return withOpenNote ? [OPEN_NOTE_TOOL, ...vaultTools] : vaultTools;
}

function instructions(): string {
  return `Vimmi is the user's personal notes app: Markdown notes, tasks, projects and a calendar in a local folder (the vault). These tools read and change that vault.

${VAULT_GUIDE}

When the user talks about "this note" or what they have open, call get_open_note.

Today is ${isoDate()}. Look things up with the tools instead of guessing, read a note before editing it, prefer small edits (edit_note) and keep the user's language and style. Every change is saved in the note's history in Vimmi, so the user can undo it there.`;
}

export function createMcpServer(opts: McpOptions) {
  const tools = new Map(MCP_TOOLS.map((t) => [t.name, TOOL_MAP[t.name]]));

  const ok = (id: Id | null, result: unknown): Reply => ({ jsonrpc: "2.0", id, result });
  const fail = (id: Id | null, code: number, message: string): Reply => ({ jsonrpc: "2.0", id, error: { code, message } });
  const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

  async function openNote() {
    const ctx = await opts.openContext!().catch(() => null);
    if (!ctx) return text("Vimmi teď neběží, takže nevím, co má uživatel otevřené. Zeptej se ho, o kterou poznámku jde.");
    const env = await opts.env();
    if (ctx.vault && env.vault.root !== ctx.vault) return text(`Ve Vimmi je otevřený jiný trezor (${ctx.vault}) než ten, se kterým pracují tyhle nástroje.`);
    const lines: string[] = [];
    const others = ctx.openPaths.filter((p) => p !== ctx.activePath);
    if (!ctx.activePath) lines.push("Ve Vimmi teď není otevřená žádná poznámka (je otevřený jiný pohled, např. Dnes nebo Kalendář).");
    else lines.push(`Otevřená poznámka: ${ctx.activePath}`);
    if (others.length) lines.push(`Další otevřené karty: ${others.join(", ")}`);
    if (ctx.selection) lines.push(`Vybraný text:\n"""\n${ctx.selection}\n"""`);
    if (ctx.activePath) {
      let content: string | null = null;
      try {
        content = env.vault.read(ctx.activePath);
      } catch {
        // Renamed or deleted since.
      }
      if (content === null) lines.push("(Poznámku se nepodařilo přečíst – možná byla mezitím přejmenovaná nebo smazaná.)");
      else lines.push(`Obsah:\n${content.length > MAX_OPEN_NOTE ? content.slice(0, MAX_OPEN_NOTE) + "\n…(zkráceno)" : content}`);
    }
    return text(lines.join("\n\n"));
  }

  async function call(name: unknown, args: unknown) {
    if (name === OPEN_NOTE_TOOL.name && opts.openContext) {
      try {
        return await openNote();
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
    }
    const tool = typeof name === "string" ? tools.get(name) : undefined;
    if (!tool) return text(`Neznámý nástroj: ${String(name)}`, true);
    const parsed = tool.schema.safeParse(args ?? {});
    if (!parsed.success) return text(`Špatné parametry: ${z.prettifyError(parsed.error)}`, true);
    try {
      const env = await opts.env();
      const out = tool.write ? await env.vault.as("ai", () => tool.run(parsed.data, env)) : await tool.run(parsed.data, env);
      return text(out);
    } catch (err) {
      const message = err instanceof VaultError || err instanceof Error ? err.message : String(err);
      return text(message, true);
    }
  }

  /** Handles one JSON-RPC message; returns the reply, or null for notifications and replies. */
  async function handle(msg: Message): Promise<Reply | null> {
    const id = msg.id ?? null;
    const isRequest = msg.id !== undefined && msg.id !== null && typeof msg.method === "string";
    if (!isRequest) return null;
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        const protocolVersion = typeof asked === "string" && MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0];
        return ok(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "vimmi", title: "Vimmi", version: opts.version },
          instructions: instructions(),
        });
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: mcpToolList(Boolean(opts.openContext)) });
      case "tools/call":
        return ok(id, await call(msg.params?.name, msg.params?.arguments));
      case "resources/list":
        return ok(id, { resources: [] });
      case "prompts/list":
        return ok(id, { prompts: [] });
      default:
        return fail(id, -32601, `Method not found: ${msg.method}`);
    }
  }

  /** One line of the stdio transport in, the reply line out (or null). */
  async function handleLine(line: string): Promise<string | null> {
    if (!line.trim()) return null;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return JSON.stringify(fail(null, -32700, "Parse error"));
    }
    if (Array.isArray(msg)) {
      const replies = (await Promise.all(msg.map((m) => handle(m as Message)))).filter(Boolean);
      return replies.length ? JSON.stringify(replies) : null;
    }
    if (!msg || typeof msg !== "object") return JSON.stringify(fail(null, -32600, "Invalid request"));
    const reply = await handle(msg as Message);
    return reply ? JSON.stringify(reply) : null;
  }

  return { handle, handleLine };
}
