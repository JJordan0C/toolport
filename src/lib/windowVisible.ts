import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { mainWindowVisible } from "@/lib/api";

/**
 * Whether the main window is actually on screen and being looked at.
 *
 * Three signals, because no one of them is enough:
 *
 * - The Rust `team-window-visible` event, plus a `mainWindowVisible()` pull to
 *   seed a launch that goes straight to the tray. On Windows, hiding a Tauri
 *   window to the tray does not flip `document.hidden`, so a purely web-based
 *   gate thinks a tray'd app is being looked at.
 * - `document.hidden`, folded in for the platforms where it does fire, such as
 *   a real minimize.
 * - Window focus. `document.hidden` stays false on every desktop platform when
 *   the window is merely unfocused or completely covered by another app, so
 *   without this an alt-tab straight after launch would let a prompt render
 *   behind the editor and count as shown.
 *
 * Starts pessimistic (hidden) so a tray'd launch cannot briefly count as
 * on-screen before the seed answers. If the seed fails, which is anything that
 * is not the desktop app, it falls back to the webview signals.
 *
 * The team-sync loop in App.tsx tracks the native signals imperatively, because
 * it parks a long-poll rather than rendering. Same event, different shape; this
 * hook is for components.
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
      if (!cancelled) setVisible(shown && !document.hidden && document.hasFocus());
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
    window.addEventListener("focus", apply);
    window.addEventListener("blur", apply);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", apply);
      window.removeEventListener("focus", apply);
      window.removeEventListener("blur", apply);
      void unlisten.then((f) => f());
    };
  }, []);

  return visible;
}

/**
 * Set on `<body>` by react-remove-scroll for as long as a modal layer is up.
 * Every Radix modal primitive this app uses (Dialog, DropdownMenu, Select)
 * mounts it, so one attribute answers for all of them.
 */
const SCROLL_LOCK_ATTRIBUTE = "data-scroll-locked";

/**
 * Whether a modal layer is covering the app.
 *
 * A modal dialog paints a blurred overlay above everything, focus-traps into
 * itself and marks the rest of the document `aria-hidden`. Anything rendered
 * outside it is therefore dimmed, unclickable and invisible to a screen reader,
 * even though it is still mounted. A corner prompt that treats being mounted as
 * being seen would spend its one ask on something nobody could reach.
 *
 * The counted body attribute is the signal rather than app state, because it is
 * already correct for nested and stacked layers and needs no dialog in the app
 * to opt in. It is watched instead of polled so the answer changes the moment
 * the last layer closes.
 */
export function useModalOpen(): boolean {
  const [open, setOpen] = useState(modalLayerOpen);

  useEffect(() => {
    const sync = () => setOpen(modalLayerOpen());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: [SCROLL_LOCK_ATTRIBUTE],
    });
    return () => observer.disconnect();
  }, []);

  return open;
}

/**
 * The same answer without the subscription, for code that has to decide against
 * the DOM as it is right now rather than as of the last render. Radix mounts a
 * dialog's overlay through a portal, which lands on a later commit than the one
 * that rendered the dialog, so a neighbour rendering in the same beat sees no
 * lock at all until the DOM has settled. Anything that has to be right about a
 * covered screen must re-read it rather than trust what it rendered with.
 */
export function modalLayerOpen(): boolean {
  return document.body.hasAttribute(SCROLL_LOCK_ATTRIBUTE);
}
