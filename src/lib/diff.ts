// Word-level difference between two texts, for "how it is vs how it will be" on ticket updates.
export type DiffPart = { kind: "same" | "added" | "removed"; text: string };

const MAX_TOKENS = 2500;

/** Split into words and the whitespace after them, so joining the parts gives the text back. */
function tokens(s: string): string[] {
  return s.match(/\s+|[^\s]+/g) ?? [];
}

/** The parts of `after` and `before`, in order: unchanged, removed (from before) and added (in after). */
export function diffWords(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ kind: "same", text: before }] : [];
  let a = tokens(before);
  let b = tokens(after);
  // Shared start and end are cheap to skip and keep the table small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const head = a.slice(0, start).join("");
  const tail = a.slice(a.length - end).join("");
  a = a.slice(start, a.length - end);
  b = b.slice(start, b.length - end);

  let middle: DiffPart[];
  if (a.length * b.length > MAX_TOKENS * MAX_TOKENS || a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    middle = [
      { kind: "removed", text: a.join("") },
      { kind: "added", text: b.join("") },
    ];
  } else {
    // Longest common subsequence over tokens.
    const n = a.length;
    const m = b.length;
    const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    middle = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        middle.push({ kind: "same", text: a[i] });
        i++;
        j++;
      } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
        middle.push({ kind: "added", text: b[j++] });
      } else {
        middle.push({ kind: "removed", text: a[i++] });
      }
    }
  }
  return merge([{ kind: "same", text: head }, ...middle, { kind: "same", text: tail }]);
}

/**
 * Tidy the parts for reading: in each run of changes, everything removed comes first, then
 * everything added; a lone space between two changes belongs to both.
 */
function merge(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  let removed = "";
  let added = "";
  const push = (kind: DiffPart["kind"], text: string) => {
    if (!text) return;
    const last = out.at(-1);
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  const flush = () => {
    push("removed", removed);
    push("added", added);
    removed = added = "";
  };
  parts.forEach((p, i) => {
    if (p.kind === "removed") removed += p.text;
    else if (p.kind === "added") added += p.text;
    else if ((removed || added) && /^\s+$/.test(p.text) && parts[i + 1] && parts[i + 1].kind !== "same") {
      removed += p.text;
      added += p.text;
    } else {
      flush();
      push("same", p.text);
    }
  });
  flush();
  return out;
}

/** True when the update changes nothing. */
export const unchanged = (parts: DiffPart[]) => parts.every((p) => p.kind === "same");
