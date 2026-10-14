// Types shared by the Electron main process and the renderer.
import type { ProviderId } from "./providers";

export type Priority = 1 | 2 | 3;

export interface Task {
  /** Note path relative to the vault root, e.g. "Projekty/Web.md". */
  path: string;
  /** 0-based line number inside the note. */
  line: number;
  text: string;
  done: boolean;
  due?: string; // YYYY-MM-DD
  priority?: Priority;
  tags: string[];
  /** Project name the task belongs to (from the note's frontmatter or the note itself). */
  project?: string;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface LinkRef {
  /** Raw link target as written, e.g. "Nápady" or "Projekty/Web#Cíle". */
  target: string;
  /** Resolved vault path, or undefined when the note does not exist yet. */
  resolved?: string;
  line: number;
}

export interface NoteMeta {
  path: string;
  title: string;
  folder: string;
  tags: string[];
  links: LinkRef[];
  headings: Heading[];
  tasks: Task[];
  frontmatter: Record<string, unknown>;
  /** "project" when frontmatter says type: project. */
  type?: string;
  project?: string;
  mtime: number;
  ctime: number;
  words: number;
  /** First ~200 characters of body text, for previews. */
  excerpt: string;
}

export interface VaultSnapshot {
  root: string;
  name: string;
  notes: NoteMeta[];
  folders: string[];
  /** Non-markdown files (attachments), relative paths. */
  files: string[];
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  /** Matching line snippets. */
  snippets: { line: number; text: string }[];
  kind: "note" | "task" | "project";
  task?: Task;
}

export type ModelId = "claude-sonnet-5-5" | "claude-opus-5-5" | "claude-haiku-5-5";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ApprovalMode = "ask" | "auto";

export interface Settings {
  vaultPath?: string;
  recentVaults: string[];
  theme: "system" | "light" | "dark";
  /** Active AI provider. */
  provider: ProviderId;
  /** Chosen model per provider (empty = provider default). */
  models: Partial<Record<ProviderId, string>>;
  /** Server address for providers where it can be changed (Ollama, custom). */
  baseUrls: Partial<Record<ProviderId, string>>;
  effort: Effort;
  quickEffort: Effort;
  approvalMode: ApprovalMode;
  webSearch: boolean;
  showThinking: boolean;
  dailyFolder: string;
  calendarFolder: string;
  attachmentsFolder: string;
  templatesFolder: string;
  fontSize: number;
  readableWidth: boolean;
  spellcheck: boolean;
  vimMode: boolean;
  livePreview: boolean;
  customInstructions: string;
  /** GitHub sync of the vault (the token is stored separately, encrypted). */
  sync: SyncSettings;
  /** Install new versions automatically. */
  autoUpdate: boolean;
  /** Derived: the active provider has a key (or needs none). */
  hasApiKey: boolean;
  /** Derived: which providers have a stored key. */
  keys: Partial<Record<ProviderId, boolean>>;
  /** Derived: a GitHub token is stored for sync. */
  hasSyncToken: boolean;
}

export interface SyncSettings {
  enabled: boolean;
  owner: string;
  repo: string;
  branch?: string;
}

export interface UpdateStatus {
  state: "idle" | "checking" | "latest" | "available" | "downloading" | "installing" | "ready" | "error";
  /** auto = electron-updater, script = Linux install.sh, reload = web app, none = development build */
  method: "auto" | "script" | "reload" | "none";
  current: string;
  version?: string;
  progress?: number;
  message?: string;
  lastCheck?: number;
}

export interface SyncStatus {
  state: "off" | "idle" | "syncing" | "error";
  lastSync?: number;
  message?: string;
  /** Summary of the last sync that changed something. */
  lastChange?: { pulled: number; pushed: number; deleted: number; conflicts: string[]; at: number };
}

export const DEFAULT_SETTINGS: Settings = {
  recentVaults: [],
  theme: "system",
  provider: "anthropic",
  models: {},
  baseUrls: {},
  effort: "medium",
  quickEffort: "low",
  approvalMode: "auto",
  webSearch: false,
  showThinking: true,
  dailyFolder: "Deník",
  calendarFolder: "Kalendář",
  attachmentsFolder: "Přílohy",
  templatesFolder: "Šablony",
  fontSize: 16,
  readableWidth: true,
  spellcheck: false,
  vimMode: false,
  livePreview: true,
  customInstructions: "",
  sync: { enabled: false, owner: "", repo: "vimmi-poznamky" },
  autoUpdate: true,
  hasApiKey: false,
  keys: {},
  hasSyncToken: false,
};

// ---- AI chat ----

export interface ChatContext {
  activePath?: string;
  selection?: string;
  openPaths?: string[];
}

export type AiEvent =
  | { type: "turn_start"; convId: string }
  | { type: "text"; convId: string; delta: string }
  | { type: "thinking"; convId: string; delta: string }
  | { type: "block_end"; convId: string }
  | { type: "tool_start"; convId: string; id: string; name: string }
  | { type: "tool_input"; convId: string; id: string; input: unknown }
  | {
      type: "approval";
      convId: string;
      id: string;
      name: string;
      input: unknown;
      summary: string;
      diff?: { path: string; before: string; after: string };
    }
  | { type: "tool_result"; convId: string; id: string; ok: boolean; result: string }
  | { type: "web_search"; convId: string; query: string }
  | { type: "usage"; convId: string; input: number; output: number; cacheRead: number; costUsd: number | null }
  | { type: "notice"; convId: string; message: string }
  | { type: "error"; convId: string; message: string }
  | { type: "done"; convId: string; stopReason: string | null };

export interface ChatSummary {
  id: string;
  title: string;
  updated: number;
}

/** A displayable message stored for the UI (the raw API history is kept separately in main). */
export type ChatPart =
  /** `closed` marks a finished streaming block, so the next delta starts a new one. */
  | { kind: "text"; text: string; closed?: boolean }
  | { kind: "thinking"; text: string; closed?: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      input?: unknown;
      status: "running" | "waiting" | "ok" | "error" | "declined";
      result?: string;
      summary?: string;
      diff?: { path: string; before: string; after: string };
    }
  | { kind: "search"; query: string }
  | { kind: "notice"; text: string };

export interface ChatMessage {
  role: "user" | "assistant";
  parts: ChatPart[];
  context?: ChatContext;
}

export interface Chat {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: ChatMessage[];
}

export type QuickAction =
  | "summarize"
  | "improve"
  | "shorten"
  | "expand"
  | "translate_en"
  | "translate_cs"
  | "continue"
  | "extract_tasks"
  | "suggest_title"
  | "suggest_tags"
  | "explain"
  | "fix_grammar"
  | "outline"
  | "custom";

export interface QuickRequest {
  id: string;
  action: QuickAction;
  text: string;
  notePath?: string;
  instruction?: string;
}

export type QuickEvent =
  | { type: "delta"; id: string; delta: string }
  | { type: "done"; id: string; text: string }
  | { type: "error"; id: string; message: string };
