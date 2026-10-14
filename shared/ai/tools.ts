// Tools Claude can use to work with the vault. Read tools run immediately;
// write tools describe their change first so the user can approve it.
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { addDays, basename, isoDate, joinPath, taskDisplayText } from "../markdown";
import type { Task } from "../types";
import { insertUnderHeading, Vault, VaultError } from "../vault";
import { eventBody, eventFilePath, eventFromMeta, eventMarkdown, eventsFromNotes, occurrences, REPEAT_LABELS, type CalendarEvent } from "../calendar";

export interface ToolEnv {
  vault: Vault;
  dailyFolder: string;
  calendarFolder?: string;
  openNote: (path: string) => void;
}

export interface Preview {
  summary: string;
  diff?: { path: string; before: string; after: string };
}

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  write: boolean;
  preview?: (input: z.infer<S>, env: ToolEnv) => Preview;
  run: (input: z.infer<S>, env: ToolEnv) => Promise<string> | string;
}

function def<S extends z.ZodType>(d: ToolDef<S>): ToolDef<S> {
  return d;
}

const MAX_READ = 80_000;
const priority = z.union([z.literal(1), z.literal(2), z.literal(3)]);

function existing(env: ToolEnv, p: string): string {
  const found = env.vault.find(p);
  if (!found) throw new VaultError(`Poznámka „${p}“ neexistuje. Použij search_notes nebo list_notes.`);
  return found;
}

function taskLine(t: Task): string {
  const bits = [`${t.done ? "[x]" : "[ ]"} ${taskDisplayText(t.text)}`];
  if (t.due) bits.push(`termín ${t.due}`);
  if (t.priority) bits.push(`priorita ${t.priority}`);
  if (t.project) bits.push(`projekt ${t.project}`);
  bits.push(`(${t.path}:${t.line})`);
  return bits.join(" · ");
}

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const timeField = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "HH:MM");

function plusHour(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${String(Math.min(23, h + 1)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function czechDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("cs-CZ", { weekday: "long", day: "numeric", month: "numeric", year: "numeric" });
}

function describeOccurrence(date: string, e: CalendarEvent): string {
  const when = e.allDay ? "celý den" : `${e.start}–${e.end}`;
  const parts = [`${czechDate(date)} ${when}: ${e.title}`];
  if (e.location) parts.push(`místo ${e.location}`);
  if (e.repeat) parts.push(REPEAT_LABELS[e.repeat].toLowerCase());
  return parts.join(" · ");
}

function describeInput(i: { title: string; date: string; start?: string; end?: string; location?: string; repeat?: string }): string {
  const when = i.start ? `${i.start}${i.end ? `–${i.end}` : ""}` : "celý den";
  return `${i.title}, ${czechDate(i.date)} ${when}${i.location ? `, ${i.location}` : ""}${i.repeat ? ` (${REPEAT_LABELS[i.repeat as keyof typeof REPEAT_LABELS]?.toLowerCase() ?? i.repeat})` : ""}`;
}

function existingEvent(env: ToolEnv, input: string): { path: string; event: CalendarEvent } {
  const path = existing(env, input);
  const meta = env.vault.meta(path);
  const event = meta ? eventFromMeta(meta) : null;
  if (!event) throw new VaultError(`„${input}“ není událost v kalendáři. Najdi ji přes list_events.`);
  return { path, event };
}

export const TOOLS = [
  def({
    name: "list_notes",
    description:
      "List notes in the vault with their path, tags and last-modified date. Optionally filter by folder or tag. Use it to get an overview before reading.",
    schema: z.object({
      folder: z.string().optional().describe("Only notes inside this folder, e.g. 'Projekty'."),
      tag: z.string().optional().describe("Only notes with this tag, without '#'."),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum number of notes (default 100)."),
    }),
    write: false,
    run: ({ folder, tag, limit }, { vault }) => {
      let notes = vault.metas();
      if (folder) notes = notes.filter((n) => n.folder === folder || n.folder.startsWith(folder + "/"));
      if (tag) notes = notes.filter((n) => n.tags.includes(tag.replace(/^#/, "").toLowerCase()));
      notes.sort((a, b) => b.mtime - a.mtime);
      const shown = notes.slice(0, limit ?? 100);
      if (!shown.length) return "Žádné poznámky neodpovídají.";
      const lines = shown.map(
        (n) =>
          `- ${n.path}${n.tags.length ? ` [${n.tags.map((t) => "#" + t).join(" ")}]` : ""} · upraveno ${isoDate(new Date(n.mtime))} · ${n.words} slov${n.type ? ` · typ ${n.type}` : ""}`,
      );
      return `${notes.length} poznámek${notes.length > shown.length ? ` (zobrazeno ${shown.length})` : ""}:\n${lines.join("\n")}`;
    },
  }),
  def({
    name: "read_note",
    description: "Read the full Markdown content of a note, including its frontmatter. Accepts a path or a note title.",
    schema: z.object({ path: z.string().describe("Note path like 'Projekty/Web.md' or just the title 'Web'.") }),
    write: false,
    run: ({ path }, env) => {
      const p = existing(env, path);
      const content = env.vault.read(p);
      const body = content.length > MAX_READ ? content.slice(0, MAX_READ) + "\n\n[… zkráceno …]" : content;
      return `Cesta: ${p}\n\n${body}`;
    },
  }),
  def({
    name: "search_notes",
    description:
      "Full-text search across notes and tasks (accent-insensitive). Supports '#tag' and 'path:folder' filters inside the query. Returns matching notes with snippets.",
    schema: z.object({
      query: z.string().describe("Search words, optionally with #tag or path:folder filters."),
      kind: z.enum(["all", "note", "task", "project"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    write: false,
    run: ({ query, kind, limit }, { vault }) => {
      const hits = vault.search(query, { kind, limit: limit ?? 20 });
      if (!hits.length) return "Nic nenalezeno.";
      return hits
        .map((h) => {
          const head = h.kind === "task" ? `ÚKOL ${taskLine(h.task!)}` : `${h.kind === "project" ? "PROJEKT" : "POZNÁMKA"} ${h.path}`;
          const snips = h.kind === "task" ? "" : h.snippets.map((s) => `\n    ř. ${s.line + 1}: ${s.text}`).join("");
          return `- ${head}${snips}`;
        })
        .join("\n");
    },
  }),
  def({
    name: "get_connections",
    description:
      "Show how a note is connected: notes linking to it (backlinks), notes it links to, and related notes by shared tags/links/project.",
    schema: z.object({ path: z.string() }),
    write: false,
    run: ({ path }, env) => {
      const p = existing(env, path);
      const meta = env.vault.meta(p)!;
      const back = env.vault.backlinks(p);
      const out = [...new Set(meta.links.map((l) => l.resolved ?? `${l.target} (neexistuje)`))];
      const rel = env.vault.related(p, 10);
      return [
        `Poznámka: ${p}`,
        `Tagy: ${meta.tags.map((t) => "#" + t).join(" ") || "–"}`,
        `Odkazují sem (${back.length}): ${back.map((b) => b.path).join(", ") || "–"}`,
        `Odkazuje na (${out.length}): ${out.join(", ") || "–"}`,
        `Související: ${rel.map((r) => `${r.path} (skóre ${r.score})`).join(", ") || "–"}`,
      ].join("\n");
    },
  }),
  def({
    name: "list_tags",
    description: "List all tags in the vault with the number of notes using each.",
    schema: z.object({}),
    write: false,
    run: (_input, { vault }) => {
      const tags = vault.tagCounts();
      return tags.length ? tags.map((t) => `#${t.tag} (${t.count})`).join(", ") : "Trezor zatím nemá žádné tagy.";
    },
  }),
  def({
    name: "list_tasks",
    description:
      "List tasks (Markdown checkboxes) from all notes. Filter by status, due date window, project or tag. Each task shows path:line, which set_task_status needs.",
    schema: z.object({
      status: z.enum(["open", "done", "all"]).optional().describe("Default 'open'."),
      due: z.enum(["any", "today", "overdue", "week", "none"]).optional().describe("'today' includes overdue tasks."),
      project: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    write: false,
    run: ({ status = "open", due = "any", project, tag, limit }, { vault }) => {
      const today = isoDate();
      const week = addDays(today, 7);
      let tasks = vault.allTasks();
      if (status !== "all") tasks = tasks.filter((t) => t.done === (status === "done"));
      if (due === "today") tasks = tasks.filter((t) => t.due && t.due <= today);
      if (due === "overdue") tasks = tasks.filter((t) => t.due && t.due < today);
      if (due === "week") tasks = tasks.filter((t) => t.due && t.due <= week);
      if (due === "none") tasks = tasks.filter((t) => !t.due);
      if (project) tasks = tasks.filter((t) => t.project?.toLowerCase() === project.toLowerCase());
      if (tag) tasks = tasks.filter((t) => t.tags.includes(tag.replace(/^#/, "").toLowerCase()));
      tasks.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.priority ?? 4) - (b.priority ?? 4));
      const shown = tasks.slice(0, limit ?? 100);
      if (!shown.length) return "Žádné úkoly neodpovídají.";
      return `Dnes je ${today}. ${tasks.length} úkolů:\n${shown.map((t) => "- " + taskLine(t)).join("\n")}`;
    },
  }),
  def({
    name: "list_projects",
    description: "List projects (notes with `type: project` in frontmatter) with their status and open task counts.",
    schema: z.object({}),
    write: false,
    run: (_input, { vault }) => {
      const notes = vault.metas();
      const projects = notes.filter((n) => n.type === "project" || n.type === "projekt");
      if (!projects.length) return "Zatím žádné projekty. Projekt je poznámka s `type: project` ve frontmatter.";
      return projects
        .map((p) => {
          const tasks = vault.allTasks().filter((t) => t.project === p.title);
          const open = tasks.filter((t) => !t.done).length;
          const linked = notes.filter((n) => n.project === p.title && n.path !== p.path).length;
          return `- ${p.path} · stav ${String(p.frontmatter.status ?? "aktivní")} · ${open} otevřených z ${tasks.length} úkolů · ${linked} poznámek`;
        })
        .join("\n");
    },
  }),
  def({
    name: "get_daily_note",
    description: "Get the daily journal note for a date (default today). Says if it doesn't exist yet.",
    schema: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    write: false,
    run: ({ date }, env) => {
      const d = date ?? isoDate();
      const p = joinPath(env.dailyFolder, `${d}.md`);
      return env.vault.has(p) ? `Cesta: ${p}\n\n${env.vault.read(p)}` : `Denní poznámka ${p} zatím neexistuje.`;
    },
  }),
  def({
    name: "open_note",
    description: "Open a note in the editor so the user sees it. Use after creating a note or when pointing the user to one.",
    schema: z.object({ path: z.string() }),
    write: false,
    run: ({ path }, env) => {
      const p = existing(env, path);
      env.openNote(p);
      return `Otevřeno: ${p}`;
    },
  }),

  // ----- write tools (need approval) -----
  def({
    name: "create_note",
    description:
      "Create a new Markdown note. Use [[wikilinks]] to connect it to other notes and #tags where useful. Add YAML frontmatter `type: project` to make a project, or `project: Name` to attach a note to a project.",
    schema: z.object({
      path: z.string().describe("Path relative to the vault, e.g. 'Nápady/Aplikace na rozpočet.md'."),
      content: z.string().describe("Full Markdown content."),
    }),
    write: true,
    preview: ({ path, content }, env) => {
      const p = env.vault.uniquePath(path);
      return { summary: `Vytvořit poznámku ${p}`, diff: { path: p, before: "", after: content } };
    },
    run: async ({ path, content }, env) => {
      const p = await env.vault.create(env.vault.notePath(path), content);
      env.openNote(p);
      return `Vytvořeno: ${p}`;
    },
  }),
  def({
    name: "edit_note",
    description:
      "Replace an exact piece of text in a note. `old_text` must appear exactly once (include enough surrounding text to be unique). To rewrite a whole note, pass its full current content as old_text.",
    schema: z.object({
      path: z.string(),
      old_text: z.string().min(1),
      new_text: z.string(),
    }),
    write: true,
    preview: ({ path, old_text, new_text }, env) => {
      const p = existing(env, path);
      const before = env.vault.read(p);
      const count = before.split(old_text).length - 1;
      if (count === 0) throw new VaultError("old_text se v poznámce nenachází. Přečti si poznámku znovu (read_note).");
      if (count > 1) throw new VaultError(`old_text se v poznámce vyskytuje ${count}×, přidej víc okolního textu.`);
      return { summary: `Upravit ${p}`, diff: { path: p, before, after: before.replace(old_text, () => new_text) } };
    },
    run: async (input, env) => {
      const { diff } = TOOL_MAP.edit_note.preview!(input as never, env);
      await env.vault.write(diff!.path, diff!.after);
      return `Upraveno: ${diff!.path}`;
    },
  }),
  def({
    name: "append_to_note",
    description:
      "Append Markdown to the end of a note, or to the end of a section when `heading` is given (the section is created if missing). Creates the note if it doesn't exist.",
    schema: z.object({
      path: z.string(),
      text: z.string(),
      heading: z.string().optional().describe("Section heading text, without '#'."),
    }),
    write: true,
    preview: ({ path, text, heading }, env) => {
      const p = env.vault.find(path) ?? env.vault.notePath(path);
      const before = env.vault.has(p) ? env.vault.read(p) : "";
      return { summary: `Doplnit do ${p}`, diff: { path: p, before, after: insertUnderHeading(before, text, heading) } };
    },
    run: async ({ path, text, heading }, env) => {
      const p = env.vault.find(path) ?? env.vault.notePath(path);
      await env.vault.append(p, text, heading);
      return `Doplněno do ${p}`;
    },
  }),
  def({
    name: "add_task",
    description:
      "Add a task (checkbox) to a note. Default note is 'Úkoly.md'. Due date and priority (1 high, 2 medium, 3 low) are stored as '@YYYY-MM-DD' and '!1' in the task line.",
    schema: z.object({
      text: z.string().min(1),
      note: z.string().optional().describe("Note to add the task to (path or title)."),
      due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      priority: priority.optional(),
      heading: z.string().optional(),
    }),
    write: true,
    preview: ({ text, note, due, priority: prio }, env) => {
      const p = note ? (env.vault.find(note) ?? env.vault.notePath(note)) : "Úkoly.md";
      const bits = [due && `termín ${due}`, prio && `priorita ${prio}`].filter(Boolean).join(", ");
      return { summary: `Přidat úkol „${text}“ do ${p}${bits ? ` (${bits})` : ""}` };
    },
    run: async ({ text, note, due, priority: prio, heading }, env) => {
      const p = await env.vault.addTask(text, { path: note, due, priority: prio, heading });
      return `Úkol přidán do ${p}`;
    },
  }),
  def({
    name: "set_task_status",
    description: "Mark a task done or not done. Needs the note path and the 0-based line from list_tasks / search_notes.",
    schema: z.object({ path: z.string(), line: z.number().int().min(0), done: z.boolean() }),
    write: true,
    preview: ({ path, line, done }, env) => {
      const p = existing(env, path);
      const task = env.vault.meta(p)?.tasks.find((t) => t.line === line);
      if (!task) throw new VaultError(`Na řádku ${line} v ${p} není úkol.`);
      return { summary: `${done ? "Splnit" : "Znovu otevřít"} úkol „${taskDisplayText(task.text)}“` };
    },
    run: async ({ path, line, done }, env) => {
      const p = existing(env, path);
      await env.vault.toggleTask(p, line, done);
      return `Úkol ${done ? "splněn" : "znovu otevřen"}.`;
    },
  }),
  def({
    name: "rename_note",
    description: "Rename or move a note. All [[links]] pointing to it are updated automatically.",
    schema: z.object({ from: z.string(), to: z.string().describe("New path, e.g. 'Archiv/Starý projekt.md'.") }),
    write: true,
    preview: ({ from, to }, env) => {
      const p = existing(env, from);
      const links = env.vault.backlinks(p).length;
      return { summary: `Přejmenovat ${p} → ${env.vault.notePath(to)}${links ? ` (opraví odkazy v ${links} poznámkách)` : ""}` };
    },
    run: async ({ from, to }, env) => {
      const p = await env.vault.rename(existing(env, from), to);
      return `Přejmenováno na ${p}`;
    },
  }),
  def({
    name: "delete_note",
    description: "Move a note to the vault's trash (.trash folder). It can be restored from there.",
    schema: z.object({ path: z.string() }),
    write: true,
    preview: ({ path }, env) => {
      const p = existing(env, path);
      return { summary: `Přesunout ${p} do koše`, diff: { path: p, before: env.vault.read(p), after: "" } };
    },
    run: async ({ path }, env) => {
      const p = existing(env, path);
      await env.vault.trash(p);
      return `${basename(p)} je v koši.`;
    },
  }),
  // ----- calendar -----
  def({
    name: "list_events",
    description:
      "List calendar events between two dates (inclusive), including repeating events. Defaults to the next 7 days. Each line shows the note path needed by update_event / delete_event.",
    schema: z.object({
      from: dateField.optional().describe("YYYY-MM-DD, default today."),
      to: dateField.optional().describe("YYYY-MM-DD, default from + 7 days."),
    }),
    write: false,
    run: ({ from, to }, { vault }) => {
      const start = from ?? isoDate();
      const end = to ?? addDays(start, 7);
      const occ = occurrences(eventsFromNotes(vault.metas()), start, end);
      if (!occ.length) return `V kalendáři mezi ${start} a ${end} nic není.`;
      return occ.map((o) => `- ${describeOccurrence(o.date, o.event)} (${o.event.path})`).join("\n");
    },
  }),
  def({
    name: "add_event",
    description:
      "Add an event to the calendar (doctor, meeting, birthday, trip…). Omit start/end for an all-day event. end_date makes a multi-day all-day event. repeat makes it recurring.",
    schema: z.object({
      title: z.string().min(1),
      date: dateField,
      start: timeField.optional().describe("HH:MM, 24h"),
      end: timeField.optional().describe("HH:MM; default one hour after start"),
      end_date: dateField.optional(),
      location: z.string().optional(),
      description: z.string().optional(),
      repeat: z.enum(["daily", "weekly", "monthly", "yearly"]).optional(),
      until: dateField.optional(),
      remind: z.number().int().min(0).max(10080).optional().describe("Minutes before start to remind (timed events). Default 15."),
    }),
    write: true,
    preview: (input) => ({ summary: `Přidat do kalendáře: ${describeInput(input)}` }),
    run: async (input, env) => {
      const folder = env.calendarFolder ?? "Kalendář";
      const timed = Boolean(input.start);
      const content = eventMarkdown({
        title: input.title,
        date: input.date,
        endDate: input.end_date,
        start: input.start,
        end: input.end ?? (input.start ? plusHour(input.start) : undefined),
        allDay: !timed,
        location: input.location,
        description: input.description,
        repeat: input.repeat,
        until: input.until,
        remind: timed ? (input.remind ?? 15) : undefined,
      });
      const p = await env.vault.create(eventFilePath(folder, input), content);
      return `Přidáno do kalendáře: ${describeInput(input)} (${p})`;
    },
  }),
  def({
    name: "update_event",
    description: "Change a calendar event: move it to another date or time, rename it, change place, repeat or reminder. Pass only the fields that change.",
    schema: z.object({
      path: z.string(),
      title: z.string().optional(),
      date: dateField.optional(),
      start: timeField.optional(),
      end: timeField.optional(),
      all_day: z.boolean().optional(),
      location: z.string().optional(),
      description: z.string().optional(),
      repeat: z.enum(["daily", "weekly", "monthly", "yearly", "none"]).optional(),
      remind: z.number().int().min(0).max(10080).optional(),
    }),
    write: true,
    preview: (input, env) => {
      const { event } = existingEvent(env, input.path);
      return { summary: `Upravit událost „${event.title}“ (${describeOccurrence(event.date, event)})` };
    },
    run: async (input, env) => {
      const { path, event } = existingEvent(env, input.path);
      const allDay = input.all_day ?? (input.start ? false : event.allDay);
      const start = allDay ? undefined : (input.start ?? event.start ?? "09:00");
      const content = eventMarkdown(
        {
          title: input.title ?? event.title,
          date: input.date ?? event.date,
          endDate: event.endDate,
          start,
          end: allDay ? undefined : (input.end ?? (input.start && !input.end ? plusHour(input.start) : event.end)),
          allDay,
          location: input.location ?? event.location,
          repeat: input.repeat === "none" ? undefined : (input.repeat ?? event.repeat),
          until: event.until,
          remind: input.remind ?? event.remind,
          color: event.color,
        },
        input.description !== undefined ? `\n${input.description}\n` : eventBody(env.vault.read(path)),
      );
      await env.vault.write(path, content);
      return `Událost upravena (${path}).`;
    },
  }),
  def({
    name: "delete_event",
    description: "Remove a calendar event (moves its note to the trash).",
    schema: z.object({ path: z.string() }),
    write: true,
    preview: (input, env) => {
      const { event } = existingEvent(env, input.path);
      return { summary: `Smazat událost „${event.title}“ (${describeOccurrence(event.date, event)})` };
    },
    run: async (input, env) => {
      const { path, event } = existingEvent(env, input.path);
      await env.vault.trash(path);
      return `Událost „${event.title}“ je smazaná.`;
    },
  }),
];

export type ToolName = (typeof TOOLS)[number]["name"];
export const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t])) as Record<string, ToolDef<z.ZodType>>;

/** Provider-neutral tool descriptions: name, description and JSON Schema parameters. */
export function functionSchemas(): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.schema, { target: "draft-7" }) as Record<string, unknown>;
    delete schema.$schema;
    return {
      name: t.name,
      description: t.description + (t.write ? " The user approves this change before it runs." : ""),
      parameters: schema,
    };
  });
}

/** Tool definitions in the shape the Claude Messages API expects. */
export function toolDefinitions(): Anthropic.Beta.BetaToolUnion[] {
  return functionSchemas().map((f) => ({
    name: f.name,
    description: f.description,
    input_schema: f.parameters as Anthropic.Beta.BetaTool.InputSchema,
    eager_input_streaming: true,
  }));
}
