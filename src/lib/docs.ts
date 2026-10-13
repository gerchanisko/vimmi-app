// Open-document cache with debounced autosave and reload on outside edits.
import { errorText, toast } from "./store";

interface Doc {
  content: string;
  saved: string;
  timer?: number;
  saving?: Promise<void>;
}

const docs = new Map<string, Doc>();
const listeners = new Map<string, Set<(content: string) => void>>();

export async function loadDoc(path: string): Promise<string> {
  const cached = docs.get(path);
  if (cached) return cached.content;
  const content = await window.vimmi.vault.read(path);
  docs.set(path, { content, saved: content });
  return content;
}

export function updateDoc(path: string, content: string): void {
  const doc = docs.get(path) ?? { content, saved: "" };
  doc.content = content;
  docs.set(path, doc);
  clearTimeout(doc.timer);
  doc.timer = window.setTimeout(() => void saveDoc(path), 500);
}

export async function saveDoc(path: string): Promise<void> {
  const doc = docs.get(path);
  if (!doc) return;
  clearTimeout(doc.timer);
  await doc.saving;
  if (doc.content === doc.saved) return;
  const content = doc.content;
  doc.saving = window.vimmi.vault
    .write(path, content)
    .then(() => {
      doc.saved = content;
    })
    .catch((err) => toast(`Uložení selhalo: ${errorText(err)}`, "error"));
  await doc.saving;
}

export async function flushAll(): Promise<void> {
  await Promise.all([...docs.keys()].map(saveDoc));
}

export function isDirty(path: string): boolean {
  const d = docs.get(path);
  return Boolean(d && d.content !== d.saved);
}

export function subscribeDoc(path: string, cb: (content: string) => void): () => void {
  if (!listeners.has(path)) listeners.set(path, new Set());
  listeners.get(path)!.add(cb);
  return () => listeners.get(path)?.delete(cb);
}

/** Called when a file changed outside the editor (disk, AI, task toggles). */
export async function reloadDoc(path: string): Promise<void> {
  const doc = docs.get(path);
  if (!doc) return;
  if (doc.content !== doc.saved) return; // keep unsaved typing; it will overwrite on save
  try {
    const content = await window.vimmi.vault.read(path);
    if (content === doc.content) return;
    doc.content = content;
    doc.saved = content;
    for (const cb of listeners.get(path) ?? []) cb(content);
  } catch {
    docs.delete(path);
  }
}

export function forgetDoc(path: string): void {
  docs.delete(path);
}

/** Drops cached documents at a path or under a folder (after rename, move or trash). */
export function forgetPrefix(path: string): void {
  for (const key of [...docs.keys()]) {
    if (key === path || key.startsWith(path + "/")) {
      clearTimeout(docs.get(key)?.timer);
      docs.delete(key);
    }
  }
}
