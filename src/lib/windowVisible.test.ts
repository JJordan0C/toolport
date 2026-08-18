import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useWindowVisible } from "./windowVisible";

const mainWindowVisible = vi.fn();
vi.mock("@/lib/api", () => ({
  mainWindowVisible: () => mainWindowVisible(),
}));

/** Handlers registered for the Rust show/hide event, so a test can fire it. */
let handlers: Array<(e: { payload: boolean }) => void> = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (e: { payload: boolean }) => void) => {
    handlers.push(handler);
    return Promise.resolve(() => {
      handlers = handlers.filter((h) => h !== handler);
    });
  },
}));

function emitVisible(payload: boolean) {
  act(() => {
    for (const h of handlers) h({ payload });
  });
}

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  handlers = [];
  mainWindowVisible.mockReset();
  mainWindowVisible.mockResolvedValue(true);
  setDocumentHidden(false);
});

afterEach(() => {
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

describe("useWindowVisible", () => {
  it("starts hidden and only reports visible once the seed answers", async () => {
    // A launch straight to the tray must never read as on screen, not even for
    // the render or two before the seed resolves.
    mainWindowVisible.mockResolvedValue(false);
    const { result } = renderHook(() => useWindowVisible());

    expect(result.current).toBe(false);
    await waitFor(() => expect(mainWindowVisible).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("reports a window that was already on screen at launch", async () => {
    const { result } = renderHook(() => useWindowVisible());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("tracks show and hide from the Rust side", async () => {
    const { result } = renderHook(() => useWindowVisible());
    await waitFor(() => expect(result.current).toBe(true));

    // Hiding to the tray does not flip document.hidden on Windows, so this
    // event is the only signal that says the window went away.
    emitVisible(false);
    expect(result.current).toBe(false);

    emitVisible(true);
    expect(result.current).toBe(true);
  });

  it("folds in the webview signal for a real minimize", async () => {
    const { result } = renderHook(() => useWindowVisible());
    await waitFor(() => expect(result.current).toBe(true));

    setDocumentHidden(true);
    expect(result.current).toBe(false);

    setDocumentHidden(false);
    expect(result.current).toBe(true);
  });

  it("falls back to the webview when there is no desktop shell", async () => {
    mainWindowVisible.mockRejectedValue(new Error("no tauri"));
    const { result } = renderHook(() => useWindowVisible());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("stops listening on unmount", async () => {
    const { unmount } = renderHook(() => useWindowVisible());
    await waitFor(() => expect(handlers).toHaveLength(1));

    unmount();
    await waitFor(() => expect(handlers).toHaveLength(0));
  });
});
