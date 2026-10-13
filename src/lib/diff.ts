// Line diff (LCS) for showing the user what an AI edit changes.
export type DiffLine = { type: "same" | "add" | "del"; text: string };

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  // Trim common prefix/suffix so the LCS table stays small for typical edits.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ type: "same", text }));

  if (midA.length * midB.length > 4_000_000) {
    out.push(...midA.map((text) => ({ type: "del" as const, text })), ...midB.map((text) => ({ type: "add" as const, text })));
  } else {
    const n = midA.length;
    const m = midB.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ type: "same", text: midA[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ type: "del", text: midA[i++] });
      else out.push({ type: "add", text: midB[j++] });
    }
    while (i < n) out.push({ type: "del", text: midA[i++] });
    while (j < m) out.push({ type: "add", text: midB[j++] });
  }
  out.push(...a.slice(endA).map((text) => ({ type: "same" as const, text })));
  return out;
}

/** Keeps changed lines plus `context` lines around them; gaps become null. */
export function collapseDiff(lines: DiffLine[], context = 2): (DiffLine | null)[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.type === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.at(-1) !== null) out.push(null);
  });
  return out;
}
