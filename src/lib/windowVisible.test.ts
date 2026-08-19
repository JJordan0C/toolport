import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useModalOpen, useWindowVisible } from "./windowVisible";

const mainWindowVisible = vi.fn();
vi.mock("@/lib/api", () => ({
  mainWindowVisible: () => mainWindowVisible(),
}));

/** Handlers registered for the Rust show/hide event, so a test can fire it. */
let handlers: Array<(e: { payload: boolean }) => void> = [];
/** Set by a test to simulate running outside the desktop shell entirely. */
let listenFails = false;
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (e: { payload: boolean }) => void) => {
    if (listenFails) return Promise.reject(new Error("no tauri"));
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

/** jsdom reports `document.hasFocus()` as "something is focused", not "this
 *  window has focus", so the real signal has to be stubbed to model a window
 *  that is on screen while the user works in another app. */
let focused = true;
Object.defineProperty(document, "hasFocus", {
  value: () => focused,
  configurable: true,
});

function setWindowFocused(next: boolean) {
  focused = next;
  act(() => {
    window.dispatchEvent(new Event(next ? "focus" : "blur"));
  });
}

/** Stands in for react-remove-scroll, which counts modal layers on <body>. */
function setModalOpen(open: boolean) {
  if (open) document.body.setAttribute("data-scroll-locked", "1");
  else document.body.removeAttribute("data-scroll-locked");
}

beforeEach(() => {
  handlers = [];
  listenFails = false;
  mainWindowVisible.mockReset();
  mainWindowVisible.mockResolvedValue(true);
  focused = true;
  setDocumentHidden(false);
  setModalOpen(false);
});

afterEach(() => {
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  focused = true;
  setModalOpen(false);
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

  it("does not let a slow seed overwrite a newer event", async () => {
    // The seed is a snapshot of when the effect ran. If the window is hidden
    // between then and the answer, the event is the truth and must win.
    let resolveSeed: (v: boolean) => void = () => {};
    mainWindowVisible.mockReturnValue(
      new Promise<boolean>((r) => {
        resolveSeed = r;
      }),
    );
    const { result } = renderHook(() => useWindowVisible());
    await waitFor(() => expect(handlers).toHaveLength(1));

    emitVisible(false);
    expect(result.current).toBe(false);

    await act(async () => {
      resolveSeed(true); // stale: taken before the window was hidden
    });
    expect(result.current).toBe(false);
  });

  it("survives a listener that never registers", async () => {
    // Outside the desktop shell there is no native event stream at all. The
    // hook must fall back to the webview signal instead of throwing.
    listenFails = true;
    const { result, unmount } = renderHook(() => useWindowVisible());

    await waitFor(() => expect(result.current).toBe(true));
    setDocumentHidden(true);
    expect(result.current).toBe(false);

    expect(() => unmount()).not.toThrow();
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

  it("does not count a window the user has alt-tabbed away from", async () => {
    // document.hidden stays false on every desktop platform for a window that
    // is merely unfocused or fully covered, so focus is the only signal that
    // says nobody is looking at what we just rendered.
    const { result } = renderHook(() => useWindowVisible());
    await waitFor(() => expect(result.current).toBe(true));

    setWindowFocused(false);
    expect(result.current).toBe(false);

    setWindowFocused(true);
    expect(result.current).toBe(true);
  });

  it("stays hidden when the window was never focused at launch", async () => {
    // A launch that opens behind the editor must not read as on screen just
    // because no blur has fired yet.
    focused = false;
    const { result } = renderHook(() => useWindowVisible());

    await waitFor(() => expect(mainWindowVisible).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("stays hidden when the page is already hidden at mount", async () => {
    // A minimized window: no visibilitychange will ever fire, so the very first
    // reading has to fold in document.hidden rather than wait for an event.
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    const { result } = renderHook(() => useWindowVisible());

    await waitFor(() => expect(mainWindowVisible).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("stops listening for focus on unmount", async () => {
    // React swallows a setState on an unmounted component, so a leaked focus
    // listener is silent. Watch the removal itself instead.
    const remove = vi.spyOn(window, "removeEventListener");
    const { result, unmount } = renderHook(() => useWindowVisible());
    await waitFor(() => expect(result.current).toBe(true));

    unmount();
    const removed = remove.mock.calls.map(([event]) => event);
    expect(removed).toContain("focus");
    expect(removed).toContain("blur");
  });
});

describe("useModalOpen", () => {
  it("reports a modal layer that was already up at mount", () => {
    setModalOpen(true);
    const { result } = renderHook(() => useModalOpen());
    expect(result.current).toBe(true);
  });

  it("tracks a modal layer opening and closing", async () => {
    const { result } = renderHook(() => useModalOpen());
    expect(result.current).toBe(false);

    act(() => setModalOpen(true));
    await waitFor(() => expect(result.current).toBe(true));

    act(() => setModalOpen(false));
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("stops observing on unmount", () => {
    // Same trap as the focus listener: an observer left attached to <body> for
    // every mount is invisible from the hook's own return value.
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const { unmount } = renderHook(() => useModalOpen());
    expect(disconnect).not.toHaveBeenCalled();

    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
