import { invoke } from "@tauri-apps/api/core";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** Outcome of an update check. `error` is distinct from `current` so the UI can
 * tell "you're up to date" apart from "couldn't reach the update server". */
export type UpdateCheck =
  | { kind: "update"; update: Update }
  | { kind: "current" }
  | { kind: "error"; message: string };

export type UpdateProgress =
  | { phase: "downloading"; downloadedBytes: number; totalBytes?: number }
  | { phase: "installing" };

/** Check for a newer release via the Tauri updater. Never throws; failures
 * (dev build, offline, or no manifest published yet) come back as `error`. */
export async function checkForUpdate(): Promise<UpdateCheck> {
  try {
    const u = await check();
    return u?.available ? { kind: "update", update: u } : { kind: "current" };
  } catch (e) {
    return { kind: "error", message: String(e) };
  }
}

/** Download + install the update, reporting real byte progress before relaunch. */
export async function installUpdate(
  update: Update,
  onProgress?: (progress: UpdateProgress) => void,
): Promise<void> {
  let downloadedBytes = 0;
  let totalBytes: number | undefined;
  const report = (event: DownloadEvent) => {
    if (event.event === "Started") {
      downloadedBytes = 0;
      totalBytes = event.data.contentLength;
      onProgress?.({ phase: "downloading", downloadedBytes, totalBytes });
    } else if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
      onProgress?.({ phase: "downloading", downloadedBytes, totalBytes });
    }
  };
  // Keep MCP clients connected during the potentially slow download. Only stop
  // gateways once the package is local and the installer is ready to replace files.
  await update.download(report);
  onProgress?.({ phase: "installing" });
  await invoke<number>("stop_spawned_gateways");
  await update.install();
  await relaunch();
}
