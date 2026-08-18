/**
 * One-time "star us on GitHub" ask.
 *
 * Two audiences, deliberately different:
 *
 * - New install: a card right after onboarding, and (only if that card was
 *   deferred) a small chip on a later launch, once a few servers are enabled.
 * - Existing install, i.e. someone who onboarded before this prompt shipped:
 *   exactly one card, a few seconds into a launch. They have used the app for
 *   months; one ask is the polite amount, so there is no chip afterwards.
 *
 * An ask is spent when it is shown, not when it is clicked. Ignoring a prompt
 * and quitting therefore does not bring it back on the next launch, which is
 * the difference between asking and nagging.
 *
 * Deliberately in-app only: no OS notification, no toast that steals focus.
 */

export const STAR_PROMPT_KEY = "toolport.starPrompt";
export const STAR_REPO_URL = "https://github.com/tsouth89/toolport";

/** Enabled servers before the chip is allowed to appear. The point is to ask
 *  someone who got value out of the app, not someone who just installed it. */
export const CHIP_MIN_ENABLED_SERVERS = 3;

/** Enabled servers before the existing-user card appears. Only skips installs
 *  that were never actually set up. */
export const RETURNING_MIN_ENABLED_SERVERS = 1;

/**
 * What this install is owed next.
 *
 * `card` and `returning` are derived at read time and never stored: an install
 * is one or the other by whether it had onboarded before the prompt existed.
 * Only `later` and `done` are written, since those are the states that have to
 * survive a restart.
 */
export type StarStage = "card" | "returning" | "later" | "done";

function onboardedAlready(): boolean {
  return (
    localStorage.getItem("toolport.onboarded") === "1" ||
    // Pre-rename key, still present on installs that onboarded as Conduit.
    localStorage.getItem("conduit.onboarded") === "1"
  );
}

/** Resolve the stage to start this session at. */
export function readStarStage(): StarStage {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STAR_PROMPT_KEY);
  } catch {
    // Without storage a spent ask can't be remembered, so the prompt would come
    // back every launch. That is exactly the nag this feature must not be.
    return "done";
  }
  if (raw === "done" || raw === "later") return raw;
  // No record at all. An install that has already onboarded predates this
  // prompt, so it gets the single existing-user card rather than nothing.
  return onboardedAlready() ? "returning" : "card";
}

export function writeStarStage(stage: "later" | "done"): void {
  try {
    localStorage.setItem(STAR_PROMPT_KEY, stage);
  } catch {
    // Best effort. In-memory state still suppresses the prompt for this session.
  }
}
