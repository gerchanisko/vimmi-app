// Images in notes: shown right in the editor (live preview), inserted from the clipboard, drag & drop
// or the gallery/camera, downscaled when they are huge, and opened full size on click.
import { type EditorState, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { MD_IMAGE, WIKI_IMAGE } from "../../shared/remote-images";
import { getState, toast } from "./store";

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

interface FoundImage {
  src: string;
  alt: string;
  width?: number;
}

function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** URL of an image referenced from a note, or "" when the file does not exist. */
export function imageSrc(target: string, notePath: string | undefined, wiki: boolean): string {
  if (/^(https?:|data:image\/)/i.test(target)) return target;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return "";
  const files = getState().snapshot?.files ?? [];
  let rel: string;
  if (wiki) {
    rel = files.find((f) => f === target || f.endsWith("/" + target)) ?? target;
  } else {
    let decoded = target;
    try {
      decoded = decodeURI(target);
    } catch {
      /* keep as written */
    }
    decoded = decoded.replace(/^\.\//, "").replace(/^\/+/, "");
    const dir = notePath ? dirOf(notePath) : "";
    const relative = dir ? `${dir}/${decoded}` : decoded;
    rel = files.includes(relative) ? relative : decoded;
  }
  return window.vimmi.vault.fileUrl(rel);
}

function imagesInLine(text: string, notePath: string | undefined): { images: FoundImage[]; only: boolean } {
  if (!text.includes("![")) return { images: [], only: false };
  const images: FoundImage[] = [];
  let rest = text;
  for (const m of text.matchAll(WIKI_IMAGE)) {
    if (!IMAGE_EXT.test(m[1].trim())) continue;
    images.push({ src: imageSrc(m[1].trim(), notePath, true), alt: m[1].trim(), width: m[2] ? Number(m[2]) : undefined });
    rest = rest.replace(m[0], "");
  }
  for (const m of text.matchAll(MD_IMAGE)) {
    const [alt, size] = m[1].split("|");
    images.push({ src: imageSrc(m[2], notePath, false), alt: alt.trim() || m[2], width: /^\d+$/.test(size ?? "") ? Number(size) : undefined });
    rest = rest.replace(m[0], "");
  }
  return { images, only: images.length > 0 && rest.trim() === "" };
}

class ImageWidget extends WidgetType {
  constructor(readonly images: FoundImage[]) {
    super();
  }
  eq(other: ImageWidget) {
    return JSON.stringify(other.images) === JSON.stringify(this.images);
  }
  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-images";
    for (const img of this.images) {
      const figure = document.createElement("span");
      figure.className = "cm-image";
      if (img.src) {
        const el = document.createElement("img");
        el.src = img.src;
        el.alt = img.alt;
        el.loading = "lazy";
        el.draggable = false;
        if (img.width) el.style.width = `${img.width}px`;
        el.addEventListener("error", () => figure.replaceChildren(missing(img.alt)));
        const zoom = document.createElement("button");
        zoom.className = "cm-image-zoom";
        zoom.type = "button";
        zoom.title = "Zobrazit celý obrázek";
        zoom.setAttribute("aria-label", "Zobrazit celý obrázek");
        zoom.textContent = "⤢";
        zoom.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openLightbox(img.src, img.alt);
        });
        figure.append(el, zoom);
      } else {
        figure.append(missing(img.alt));
      }
      box.append(figure);
    }
    // Clicking the picture puts the cursor on its line, which reveals the Markdown for editing.
    box.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest(".cm-image-zoom")) return;
      e.preventDefault();
      const pos = view.posAtDOM(box);
      view.dispatch({ selection: { anchor: view.state.doc.lineAt(Math.min(pos, view.state.doc.length)).to } });
      view.focus();
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

function missing(name: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "cm-image-missing";
  el.textContent = `Obrázek nenalezen: ${name}`;
  return el;
}

function buildImages(state: EditorState, notePath: string | undefined): DecorationSet {
  const out: Range<Decoration>[] = [];
  const sel = state.selection.ranges;
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const { images, only } = imagesInLine(line.text, notePath);
    if (!images.length) continue;
    const active = sel.some((r) => r.from <= line.to && r.to >= line.from);
    const widget = new ImageWidget(images);
    // A line with just the image shows only the picture; otherwise the picture goes under the line.
    if (only && !active) out.push(Decoration.replace({ widget, block: true }).range(line.from, line.to));
    else out.push(Decoration.widget({ widget, block: true, side: 1 }).range(line.to));
  }
  return Decoration.set(out, true);
}

/** Live preview of images; `getPath` gives the note's path (for relative image links). */
export function imagePreview(getPath: () => string | undefined) {
  return StateField.define<DecorationSet>({
    create: (state) => buildImages(state, getPath()),
    update: (deco, tr) => (tr.docChanged || tr.selection ? buildImages(tr.state, getPath()) : deco),
    provide: (f) => EditorView.decorations.from(f),
  });
}

// ---------------------------------------------------------------- inserting

const MAX_SIDE = 2400;
const MAX_BYTES = 1_500_000;

/**
 * Phone photos are often 4000 px and several MB. Shrink big images before they are saved,
 * so notes stay fast and sync stays light. Small images and GIFs are kept as they are.
 */
export async function prepareImage(file: File): Promise<{ data: Uint8Array; ext: string }> {
  const ext = (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
  const original = async () => ({ data: new Uint8Array(await file.arrayBuffer()), ext });
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type)) return original();
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return original(); // e.g. HEIC where the browser cannot decode it
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const heic = /heic|heif/.test(file.type);
  if (scale === 1 && file.size <= MAX_BYTES && !heic) {
    bitmap.close();
    return original();
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // Photos become JPEG; screenshots and images with transparency become WebP (keeps transparency).
  const photo = file.type === "image/jpeg" || heic;
  const type = photo ? "image/jpeg" : "image/webp";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, photo ? 0.85 : 0.9));
  if (!blob || (blob.size >= file.size && !heic)) return original();
  return { data: new Uint8Array(await blob.arrayBuffer()), ext: photo ? "jpg" : "webp" };
}

function imageName(file: File, ext: string): string {
  const stem = file.name.replace(/\.[^.]+$/, "");
  const generic = !stem || /^image$/i.test(stem);
  return `${generic ? `Obrázek ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}` : stem}.${ext}`;
}

/** Saves images as attachments and inserts them at the cursor, each on its own line. */
export async function insertImages(view: EditorView, files: File[]): Promise<void> {
  const links: string[] = [];
  for (const file of files) {
    try {
      const { data, ext } = await prepareImage(file);
      const rel = await window.vimmi.vault.attachment(imageName(file, ext), data);
      // Readable like Obsidian: only characters that would break the Markdown link are encoded.
      links.push(`![](${rel.replace(/[ ()%<>]/g, (c) => encodeURIComponent(c))})`);
    } catch (err) {
      toast(`Obrázek se nepodařilo vložit: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }
  if (!links.length) return;
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.from);
  // After a quote or list item a blank line keeps the picture out of it.
  const before = line.text.slice(0, sel.from - line.from).trim() ? (/^\s*(>|[-*+] |\d+[.)] )/.test(line.text) ? "\n\n" : "\n") : "";
  const after = state.doc.sliceString(sel.to, line.to).trim() ? "\n" : "";
  const insert = `${before}${links.join("\n")}${after}`;
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length }, scrollIntoView: true });
  view.focus();
}

/** Opens the system picker (gallery or camera on phones) and resolves with the chosen images. */
export function pickImages(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener("cancel", () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

// ---------------------------------------------------------------- full-size view

export function openLightbox(src: string, alt = ""): void {
  const overlay = document.createElement("div");
  overlay.className = "lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", alt || "Obrázek");
  const img = document.createElement("img");
  img.src = src;
  img.alt = alt;
  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  overlay.addEventListener("click", close);
  window.addEventListener("keydown", onKey, true);
  overlay.append(img);
  document.body.append(overlay);
}
