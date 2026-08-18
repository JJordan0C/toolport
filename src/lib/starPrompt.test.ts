import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readStarStage, writeStarStage, STAR_PROMPT_KEY } from "./starPrompt";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("readStarStage", () => {
  it("starts a brand-new install at the onboarding card", () => {
    expect(readStarStage()).toBe("card");
  });

  it("starts an install that predates the prompt at the one-off card", () => {
    localStorage.setItem("toolport.onboarded", "1");
    expect(readStarStage()).toBe("returning");
  });

  it("honours the pre-rename onboarding key", () => {
    localStorage.setItem("conduit.onboarded", "1");
    expect(readStarStage()).toBe("returning");
  });

  it("prefers a recorded stage over the predates-the-prompt guess", () => {
    // Otherwise an existing user would get the one-off card on every launch.
    localStorage.setItem("toolport.onboarded", "1");
    writeStarStage("done");
    expect(readStarStage()).toBe("done");
  });

  it("round-trips the two stages that are written", () => {
    writeStarStage("later");
    expect(readStarStage()).toBe("later");
    writeStarStage("done");
    expect(readStarStage()).toBe("done");
  });

  it("ignores a garbage value", () => {
    localStorage.setItem(STAR_PROMPT_KEY, "yes-please");
    expect(readStarStage()).toBe("card");
  });

  it("stays silent when storage is unavailable", () => {
    // A spent ask that can't be recorded would mean asking on every launch.
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readStarStage()).toBe("done");
  });

  it("does not throw when a write is refused", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => writeStarStage("done")).not.toThrow();
  });
});
