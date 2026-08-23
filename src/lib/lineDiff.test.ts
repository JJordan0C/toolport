import { describe, expect, it } from "vitest";
import { lineDiff } from "./lineDiff";

describe("lineDiff", () => {
  it("marks changed, added and removed lines and keeps the rest", () => {
    const d = lineDiff("a\nb\nc\n", "a\nB\nc\nd");
    expect(d).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
  });

  it("degrades honestly past the size it would render, including one-sided inputs", () => {
    const huge = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n");
    const d = lineDiff("", huge);
    expect(d).toHaveLength(1);
    expect(d[0].kind).toBe("same");
    expect(d[0].text).toMatch(/too large.*0 lines in the set, 5000 in the file/);
    // Under the line cap, a wide-but-not-huge pair still diffs exactly.
    const many = Array.from({ length: 1_500 }, (_, i) => `l${i}`).join("\n");
    expect(lineDiff(many, many).every((l) => l.kind === "same")).toBe(true);
  });

  it("treats identical texts as all-same and empty texts as nothing", () => {
    expect(lineDiff("x\ny", "x\ny")).toEqual([
      { kind: "same", text: "x" },
      { kind: "same", text: "y" },
    ]);
    expect(lineDiff("", "")).toEqual([]);
    expect(lineDiff("", "new")).toEqual([{ kind: "add", text: "new" }]);
    expect(lineDiff("old", "")).toEqual([{ kind: "del", text: "old" }]);
  });
});
