import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitHubStarPrompt } from "./GitHubStarPrompt";
import { STAR_PROMPT_KEY, STAR_REPO_URL } from "@/lib/starPrompt";

const openExternal = vi.fn();
vi.mock("@/lib/openUrl", () => ({
  openExternal: (...a: unknown[]) => openExternal(...a),
}));

// Toolport lives in the tray. The prompt must show nothing, and spend nothing,
// while the window is hidden; see windowVisible.test.ts for the signal itself.
let windowVisible = true;
vi.mock("@/lib/windowVisible", () => ({ useWindowVisible: () => windowVisible }));

/** Both cards are delayed: one waits out the closing wizard, the other leaves a
 *  returning user alone for a few seconds after launch. */
async function flushDelays() {
  await act(async () => {
    vi.advanceTimersByTime(15000);
  });
}

const onboardingCard = () => screen.queryByText(/you.re all set/i);
const returningCard = () => screen.queryByText(/enjoying toolport/i);
const chip = () => screen.queryByRole("button", { name: /star toolport on github/i });
const starButton = () => screen.getByRole("button", { name: /^star on github$/i });

/** Marks the install as one that onboarded before this prompt shipped. */
function existingInstall() {
  localStorage.setItem("toolport.onboarded", "1");
}

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

beforeEach(() => {
  openExternal.mockReset();
  localStorage.clear();
  windowVisible = true;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

describe("a new install", () => {
  it("shows nothing until onboarding is finished", async () => {
    const { rerender } = render(
      <GitHubStarPrompt justOnboarded={false} enabledCount={9} />,
    );
    await flushDelays();
    expect(onboardingCard()).toBeNull();
    // 9 servers is past the chip threshold, but a fresh user must not get both
    // asks, and must never get the existing-user card.
    expect(chip()).toBeNull();
    expect(returningCard()).toBeNull();

    rerender(<GitHubStarPrompt justOnboarded={true} enabledCount={9} />);
    await flushDelays();
    expect(onboardingCard()).not.toBeNull();
  });

  it("opens the repo and never asks again once starred", async () => {
    const u = user();
    render(<GitHubStarPrompt justOnboarded={true} enabledCount={0} />);
    await flushDelays();

    await u.click(starButton());

    expect(openExternal).toHaveBeenCalledWith(STAR_REPO_URL);
    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBe("done");
    expect(onboardingCard()).toBeNull();
  });

  it("does not hand off to the chip in the same session", async () => {
    // Onboarding adds servers, so an immediate chip would read as nagging.
    const u = user();
    const { rerender } = render(
      <GitHubStarPrompt justOnboarded={true} enabledCount={6} />,
    );
    await flushDelays();
    await u.click(screen.getByRole("button", { name: /^later$/i }));

    rerender(<GitHubStarPrompt justOnboarded={true} enabledCount={7} />);
    expect(chip()).toBeNull();
  });

  it("hands off to the chip on the next launch, once enough servers are on", async () => {
    const u = user();
    const first = render(<GitHubStarPrompt justOnboarded={true} enabledCount={6} />);
    await flushDelays();
    await u.click(screen.getByRole("button", { name: /^later$/i }));
    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBe("later");
    first.unmount();

    const { rerender } = render(
      <GitHubStarPrompt justOnboarded={false} enabledCount={1} />,
    );
    await flushDelays();
    expect(chip()).toBeNull(); // still under the threshold

    rerender(<GitHubStarPrompt justOnboarded={false} enabledCount={6} />);
    expect(chip()).not.toBeNull();
    expect(onboardingCard()).toBeNull();
  });

  it("closing the chip ends the prompt for good", async () => {
    const u = user();
    localStorage.setItem(STAR_PROMPT_KEY, "later");
    const first = render(<GitHubStarPrompt justOnboarded={false} enabledCount={5} />);
    await u.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBe("done");
    first.unmount();

    render(<GitHubStarPrompt justOnboarded={false} enabledCount={5} />);
    await flushDelays();
    expect(chip()).toBeNull();
  });

  it("opens the repo from the chip", async () => {
    const u = user();
    localStorage.setItem(STAR_PROMPT_KEY, "later");
    render(<GitHubStarPrompt justOnboarded={false} enabledCount={3} />);

    await u.click(chip()!);

    expect(openExternal).toHaveBeenCalledWith(STAR_REPO_URL);
    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBe("done");
    expect(chip()).toBeNull();
  });
});

describe("an install that predates the prompt", () => {
  it("gets one card a few seconds into the launch, not at second zero", async () => {
    existingInstall();
    render(<GitHubStarPrompt justOnboarded={false} enabledCount={4} />);
    expect(returningCard()).toBeNull();

    await flushDelays();
    expect(returningCard()).not.toBeNull();
    // Worded for a months-old install, not with onboarding wording.
    expect(onboardingCard()).toBeNull();
  });

  it("stays quiet on an install that was never set up", async () => {
    existingInstall();
    const { rerender } = render(
      <GitHubStarPrompt justOnboarded={false} enabledCount={0} />,
    );
    await flushDelays();
    expect(returningCard()).toBeNull();
    // Nothing was spent, so the ask is still owed once they enable a server.
    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBeNull();

    rerender(<GitHubStarPrompt justOnboarded={false} enabledCount={1} />);
    expect(returningCard()).not.toBeNull();
  });

  it("never follows the card with a chip", async () => {
    const u = user();
    existingInstall();
    const first = render(<GitHubStarPrompt justOnboarded={false} enabledCount={8} />);
    await flushDelays();
    await u.click(screen.getByRole("button", { name: /^no thanks$/i }));
    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBe("done");
    first.unmount();

    render(<GitHubStarPrompt justOnboarded={false} enabledCount={8} />);
    await flushDelays();
    expect(chip()).toBeNull();
    expect(returningCard()).toBeNull();
  });

  it("opens the repo when starred", async () => {
    const u = user();
    existingInstall();
    render(<GitHubStarPrompt justOnboarded={false} enabledCount={2} />);
    await flushDelays();

    await u.click(starButton());

    expect(openExternal).toHaveBeenCalledWith(STAR_REPO_URL);
    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBe("done");
    expect(returningCard()).toBeNull();
  });
});

describe("an ask is spent when it is shown", () => {
  it("does not re-show a card that was ignored and then quit", async () => {
    existingInstall();
    const first = render(<GitHubStarPrompt justOnboarded={false} enabledCount={3} />);
    await flushDelays();
    expect(returningCard()).not.toBeNull();
    first.unmount(); // quit without answering

    render(<GitHubStarPrompt justOnboarded={false} enabledCount={3} />);
    await flushDelays();
    expect(returningCard()).toBeNull();
  });

  it("still owes the chip when the onboarding card was ignored", async () => {
    const first = render(<GitHubStarPrompt justOnboarded={true} enabledCount={5} />);
    await flushDelays();
    expect(onboardingCard()).not.toBeNull();
    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBe("later");
    first.unmount();

    render(<GitHubStarPrompt justOnboarded={false} enabledCount={5} />);
    expect(chip()).not.toBeNull();
  });
});

describe("while the app sits in the tray", () => {
  it("shows nothing and spends nothing", async () => {
    windowVisible = false;
    existingInstall();
    render(<GitHubStarPrompt justOnboarded={false} enabledCount={4} />);
    await flushDelays();

    expect(returningCard()).toBeNull();
    // The single ask is still owed, not burned on an empty screen.
    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBeNull();
  });

  it("does not let a backgrounded server toggle burn the chip", async () => {
    // The gateway can enable servers while the window is hidden.
    windowVisible = false;
    localStorage.setItem(STAR_PROMPT_KEY, "later");
    render(<GitHubStarPrompt justOnboarded={false} enabledCount={5} />);
    await flushDelays();

    expect(chip()).toBeNull();
    expect(localStorage.getItem(STAR_PROMPT_KEY)).toBe("later");
  });

  it("starts the wait over when the window is opened", async () => {
    windowVisible = false;
    existingInstall();
    const { rerender } = render(
      <GitHubStarPrompt justOnboarded={false} enabledCount={4} />,
    );
    await flushDelays();
    expect(returningCard()).toBeNull();

    windowVisible = true;
    rerender(<GitHubStarPrompt justOnboarded={false} enabledCount={4} />);
    expect(returningCard()).toBeNull(); // the delay runs from the open, not the launch

    await flushDelays();
    expect(returningCard()).not.toBeNull();
  });
});

describe("the toast-offset callback", () => {
  it("reports the surface on screen, and clears it on unmount", async () => {
    const u = user();
    const onVisibleChange = vi.fn();
    const first = render(
      <GitHubStarPrompt
        justOnboarded={true}
        enabledCount={4}
        onVisibleChange={onVisibleChange}
      />,
    );
    await flushDelays();
    expect(onVisibleChange).toHaveBeenLastCalledWith("card");

    await u.click(screen.getByRole("button", { name: /^later$/i }));
    expect(onVisibleChange).toHaveBeenLastCalledWith(null);
    first.unmount();

    onVisibleChange.mockClear();
    const second = render(
      <GitHubStarPrompt
        justOnboarded={false}
        enabledCount={4}
        onVisibleChange={onVisibleChange}
      />,
    );
    expect(onVisibleChange).toHaveBeenLastCalledWith("chip");

    second.unmount();
    expect(onVisibleChange).toHaveBeenLastCalledWith(null);
  });

  it("reports the existing-user card too", async () => {
    const onVisibleChange = vi.fn();
    existingInstall();
    render(
      <GitHubStarPrompt
        justOnboarded={false}
        enabledCount={2}
        onVisibleChange={onVisibleChange}
      />,
    );
    await flushDelays();
    expect(onVisibleChange).toHaveBeenLastCalledWith("returning");
  });
});
