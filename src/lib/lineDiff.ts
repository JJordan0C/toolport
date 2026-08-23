/**
 * A line-level diff of two texts, for showing how a rules block on disk differs from the set it
 * was written from (SBS-1036). Plain LCS over lines: exact, tiny, and more than enough for a
 * rules file. Past `MAX_CELLS` the quadratic table is not worth building and the result degrades
 * honestly to "all of A removed, all of B added".
 */
export interface DiffLine {
  kind: "same" | "del" | "add";
  text: string;
}

const MAX_CELLS = 4_000_000;
/** Past this many output lines the caller renders one DOM node per line; say so instead. */
const MAX_LINES = 4_000;

function splitLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  // The table below is (a+1) x (b+1); a one-sided input must not slip past the guard because
  // the other side is empty, and the fallback must not hand back more lines than anyone could
  // render or read.
  if (a.length + b.length > MAX_LINES) {
    return [
      {
        kind: "same",
        text: `(too large to show line by line: ${a.length} lines in the set, ${b.length} in the file)`,
      },
    ];
  }
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out;
}
