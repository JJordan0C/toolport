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
