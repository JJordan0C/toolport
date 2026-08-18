import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { mainWindowVisible } from "@/lib/api";

/**
 * Whether the main window is actually on screen.
 *
 * The webview's own Page Visibility API is not enough: on Windows, hiding a
 * Tauri window to the tray does not flip `document.hidden`, so a purely
 * web-based gate thinks a tray'd app is being looked at. The source of truth is
 * the Rust side, which emits `team-window-visible` on every show/hide, plus a
 * `mainWindowVisible()` pull to seed a launch that goes straight to the tray.
 * `document.hidden` is folded in as a secondary signal for the platforms where
 * it does fire, such as a real minimize.
 *
 * Starts pessimistic (hidden) so a tray'd launch cannot briefly count as
 * on-screen before the seed answers. If the seed fails, which is anything that
 * is not the desktop app, it falls back to the webview signal.
 *
 * The team-sync loop in App.tsx tracks the same two signals imperatively,
 * because it parks a long-poll rather than rendering. Same event, different
 * shape; this hook is for components.
 */
export function useWindowVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let shown = false;
    // A live show/hide event always beats the seed. The seed is a snapshot of
    // the moment the effect ran, so once an event has spoken, a seed resolving
    // afterwards is stale and would put the hook back on the wrong answer.
    let eventArrived = false;
    const apply = () => {
      if (!cancelled) setVisible(shown && !document.hidden);
    };
    const seed = (v: boolean) => {
      if (eventArrived) return;
      shown = v;
      apply();
    };

    void mainWindowVisible()
      .then(seed)
      // Not the desktop app (a browser, a test): trust the webview alone.
      .catch(() => seed(true));

    const unlisten = listen<boolean>("team-window-visible", (e) => {
      eventArrived = true;
      shown = e.payload;
      apply();
    }).catch(() => {
      // No native event stream, so there is nothing to unsubscribe. The webview
      // signal still applies, and the seed above has already had its say.
      return () => {};
    });
    document.addEventListener("visibilitychange", apply);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", apply);
      void unlisten.then((f) => f());
    };
  }, []);

  return visible;
}
