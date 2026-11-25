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

export interface McpOptions {
  version: string;
  /** The open vault, or an explanation why there is none. */
  env: () => Promise<ToolEnv>;
}

const MCP_TOOLS = TOOLS.filter((t) => !APP_ONLY.has(t.name));

export function mcpToolList() {
  return MCP_TOOLS.map((t) => {
    const inputSchema = z.toJSONSchema(t.schema, { target: "draft-7" }) as Record<string, unknown>;
    delete inputSchema.$schema;
    return {
      name: t.name,
      description: t.description,
      inputSchema,
      annotations: { readOnlyHint: !t.write, destructiveHint: t.write && DESTRUCTIVE.has(t.name), openWorldHint: false },
    };
  });
}

function instructions(): string {
  return `Vimmi is the user's personal notes app: Markdown notes, tasks, projects and a calendar in a local folder (the vault). These tools read and change that vault.

${VAULT_GUIDE}

Today is ${isoDate()}. Look things up with the tools instead of guessing, read a note before editing it, prefer small edits (edit_note) and keep the user's language and style. Every change is saved in the note's history in Vimmi, so the user can undo it there.`;
}

export function createMcpServer(opts: McpOptions) {
  const tools = new Map(MCP_TOOLS.map((t) => [t.name, TOOL_MAP[t.name]]));

  const ok = (id: Id | null, result: unknown): Reply => ({ jsonrpc: "2.0", id, result });
  const fail = (id: Id | null, code: number, message: string): Reply => ({ jsonrpc: "2.0", id, error: { code, message } });
  const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

  async function call(name: unknown, args: unknown) {
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
        return ok(id, { tools: mcpToolList() });
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
