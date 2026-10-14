// Vault actions shared by the desktop main process and the web backend.
import { isoDate, joinPath } from "./markdown";
import type { Vault } from "./vault";

export function fillTemplate(template: string, title: string, date = isoDate()): string {
  const now = new Date();
  return template
    .replace(/\{\{\s*date\s*\}\}/g, date)
    .replace(/\{\{\s*time\s*\}\}/g, now.toTimeString().slice(0, 5))
    .replace(/\{\{\s*title\s*\}\}/g, title)
    .replace(/\{\{\s*weekday\s*\}\}/g, new Date(`${date}T12:00:00`).toLocaleDateString("cs-CZ", { weekday: "long" }));
}

/** Opens (creating from the template if needed) the daily note for a date. Returns its path. */
export async function dailyNote(vault: Vault, date: string, folders: { dailyFolder: string; templatesFolder: string }): Promise<string> {
  const rel = joinPath(folders.dailyFolder, `${date}.md`);
  if (vault.has(rel)) return rel;
  const templatePath = vault.find(joinPath(folders.templatesFolder, "Denní poznámka"));
  const template = templatePath ? vault.read(templatePath) : "# {{weekday}} {{date}}\n\n## Dnes\n- [ ] \n\n## Poznámky\n\n";
  await vault.write(rel, fillTemplate(template, date, date));
  return rel;
}

export function templatePaths(vault: Vault, templatesFolder: string): string[] {
  return vault
    .metas()
    .filter((m) => m.folder === templatesFolder || m.folder.startsWith(templatesFolder + "/"))
    .map((m) => m.path);
}

export async function noteFromTemplate(vault: Vault, template: string, title: string, folder: string): Promise<string> {
  return vault.create(joinPath(folder, title), fillTemplate(vault.read(template), title));
}
