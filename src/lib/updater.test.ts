import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Update } from "@tauri-apps/plugin-updater";

const invoke = vi.fn();
const relaunch = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => relaunch(...args),
}));

import { installUpdate, type UpdateProgress } from "./updater";

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(1);
  relaunch.mockReset().mockResolvedValue(undefined);
});

describe("installUpdate", () => {
  it("downloads with progress before disconnecting gateways and installing", async () => {
    const calls: string[] = [];
    const download = vi.fn(async (onEvent: (event: unknown) => void) => {
      calls.push("download");
      onEvent({ event: "Started", data: { contentLength: 10 } });
      onEvent({ event: "Progress", data: { chunkLength: 4 } });
      onEvent({ event: "Progress", data: { chunkLength: 6 } });
      onEvent({ event: "Finished" });
    });
    const install = vi.fn(async () => {
      calls.push("install");
    });
    invoke.mockImplementation(async () => {
      calls.push("stop");
      return 1;
    });
    relaunch.mockImplementation(async () => {
      calls.push("relaunch");
    });
    const progress: UpdateProgress[] = [];

    await installUpdate({ download, install } as unknown as Update, (event) => {
      progress.push(event);
    });

    expect(calls).toEqual(["download", "stop", "install", "relaunch"]);
    expect(progress).toEqual([
      { phase: "downloading", downloadedBytes: 0, totalBytes: 10 },
      { phase: "downloading", downloadedBytes: 4, totalBytes: 10 },
      { phase: "downloading", downloadedBytes: 10, totalBytes: 10 },
      { phase: "installing" },
    ]);
    expect(invoke).toHaveBeenCalledWith("stop_spawned_gateways");
  });
});
