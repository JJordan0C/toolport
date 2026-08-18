import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Registry } from "@/lib/types";

const api = vi.hoisted(() => ({
  teamConnect: vi.fn(),
  teamJoinPoll: vi.fn(),
  teamSync: vi.fn(),
  teamDisconnect: vi.fn(),
  teamPushPreview: vi.fn(),
  teamPush: vi.fn(),
  teamInstructionsStatus: vi.fn().mockResolvedValue(null),
  setServerEnabled: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("@/lib/openUrl", () => ({ openExternal }));

import { TeamsView } from "./TeamsView";
import { TEAMS_CREATE_URL, TEAMS_PRICING_URL, TEAMS_SELFHOST_URL } from "@/lib/teamUrl";
import {
  TEAMS_BASE_PRICE,
  TEAMS_FREE_LINE,
  TEAMS_FREE_SEATS,
  TEAMS_PAID_LINE,
  TEAMS_SEAT_PRICE,
} from "@/lib/teamsPlan";

const registry: Registry = {
  version: 1,
  servers: [],
  profiles: [{ id: "default", name: "Default", enabledServerIds: [] }],
  activeProfileId: "default",
  team: {
    serverUrl: "https://teams.toolport.app",
    teamId: "team-1",
    role: "admin",
    lastVersion: 6,
  },
};

/** The same registry with no team on it, which is what every free user sees. */
const noTeam: Registry = { ...registry, team: null };

describe("TeamsView shared-server update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a deterministic diff and does not push until the admin confirms", async () => {
    const preview = {
      baseVersion: 7,
      localFingerprint: "preview-fingerprint",
      added: ["Alpha", "beta"],
      changed: ["GitHub"],
      removed: ["Legacy"],
    };
    api.teamPushPreview.mockResolvedValue(preview);
    api.teamPush.mockResolvedValue(8);

    render(<TeamsView registry={registry} onRegistryChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Update shared servers" }));

    expect(await screen.findByText("Added (2)")).toBeInTheDocument();
    expect(screen.getByText("Changed (1)")).toBeInTheDocument();
    expect(screen.getByText("Removed (1)")).toBeInTheDocument();
    for (const name of ["Alpha", "beta", "GitHub", "Legacy"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(api.teamPush).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Replace shared servers" }));
    await waitFor(() => expect(api.teamPush).toHaveBeenCalledWith(preview));
    expect(await screen.findByText(/now version 8/i)).toBeInTheDocument();
  });

  it("passes reviewed=true when the member confirms enabling a review server", async () => {
    const withReviewServer: Registry = {
      ...registry,
      servers: [
        {
          id: "team-tool",
          name: "Team tool",
          transport: "stdio",
          command: "npx",
          args: ["-y", "some-tool"],
          env: [],
          url: null,
          source: "team:team-1",
        },
      ] as Registry["servers"],
    };
    api.setServerEnabled.mockResolvedValue(withReviewServer);

    render(<TeamsView registry={withReviewServer} onRegistryChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Enable" }));
    // The ConfirmDialog's confirm button carries the same label as the trigger;
    // the dialog copy shows the exact command being consented to (the row also
    // renders the command, so anchor on dialog-only copy).
    expect(await screen.findByText(/recognize this command/)).toBeInTheDocument();
    const confirm = screen
      .getAllByRole("button", { name: "Enable" })
      .at(-1) as HTMLElement;
    await userEvent.click(confirm);

    // The fourth arg is the backend's consent assertion: without it the gate
    // in set_server_enabled refuses and Teams enable silently breaks.
    await waitFor(() =>
      expect(api.setServerEnabled).toHaveBeenCalledWith(
        "default",
        "team-tool",
        true,
        true,
      ),
    );
  });

  it("discards a stale confirmation and requires a fresh preview", async () => {
    const preview = {
      baseVersion: 7,
      localFingerprint: "preview-fingerprint",
      added: [],
      changed: ["GitHub"],
      removed: [],
    };
    api.teamPushPreview.mockResolvedValue(preview);
    api.teamPush.mockRejectedValue(
      new Error("The team config changed; nothing was overwritten."),
    );

    render(<TeamsView registry={registry} onRegistryChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Update shared servers" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Replace shared servers" }),
    );

    expect(
      await screen.findByText(/team config changed; nothing was overwritten/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Replace shared servers" }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Update shared servers" }));
    await waitFor(() => expect(api.teamPushPreview).toHaveBeenCalledTimes(2));
  });
});

/** The disconnected Teams tab is the only sales page Toolport Teams gets in front of a
 * free user, and it is also the join form for someone who already has a code. These
 * tests hold both halves: the pitch has to be there, and it must not have pushed the
 * form down or broken it. */
describe("TeamsView disconnected pitch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openExternal.mockClear();
  });

  it("keeps the connect form ahead of the pitch in the DOM", () => {
    render(<TeamsView registry={noTeam} onRegistryChange={vi.fn()} />);

    const form = screen.getByRole("heading", { name: "Have an invite or connect code?" });
    const pitch = screen.getByRole("heading", { name: "No team yet?" });

    // Someone who came here holding a code is the conversion this page already has. If
    // the pitch ever lands first in the DOM it also lands first on a narrow window,
    // where the lanes stack, and that person has to scroll past an ad to paste a code.
    expect(form.compareDocumentPosition(pitch)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("still connects with a pasted invite code", async () => {
    const onRegistryChange = vi.fn();
    api.teamConnect.mockResolvedValue({ status: "connected", registry: noTeam });

    render(<TeamsView registry={noTeam} onRegistryChange={onRegistryChange} />);
    await userEvent.type(
      screen.getByPlaceholderText("Paste your invite or connect code"),
      "invite-abc",
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(api.teamConnect).toHaveBeenCalledWith(
        "https://teams.toolport.app",
        "invite-abc",
        undefined,
      ),
    );
    expect(onRegistryChange).toHaveBeenCalledWith(noTeam);
  });

  it("offers a way to start a team, which the desktop app cannot do itself", async () => {
    render(<TeamsView registry={noTeam} onRegistryChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /Create a free team/ }));

    // The hosted app reads both of these: `intent` restores team creation after the
    // sign-in round trip, `from` attributes the app tab separately from the marketing
    // funnel. Dropping either silently degrades to the generic manage view.
    expect(openExternal).toHaveBeenCalledWith(TEAMS_CREATE_URL);
    expect(TEAMS_CREATE_URL).toContain("intent=create-team");
    expect(TEAMS_CREATE_URL).toContain("from=app-teams-tab");
  });

  it("states the free tier and what the paid tier actually buys", () => {
    render(<TeamsView registry={noTeam} onRegistryChange={vi.fn()} />);

    expect(screen.getByText(TEAMS_FREE_LINE)).toBeInTheDocument();
    expect(screen.getByText(TEAMS_PAID_LINE)).toBeInTheDocument();
    // Team costs the same at the free seat count as Free does; the difference is
    // governance. Quoting a per-person price on its own would read as a seat paywall.
    expect(TEAMS_PAID_LINE).toMatch(/access control/i);
    expect(TEAMS_FREE_LINE).toContain(String(TEAMS_FREE_SEATS));
  });

  it("keeps self-hosting a first-class option, not a footnote", async () => {
    render(<TeamsView registry={noTeam} onRegistryChange={vi.fn()} />);

    expect(screen.getByText(/self-hosted on your own network/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Self-host it/ }));
    expect(openExternal).toHaveBeenCalledWith(TEAMS_SELFHOST_URL);
  });

  it("links out for the authoritative price", async () => {
    render(<TeamsView registry={noTeam} onRegistryChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /Pricing/ }));
    expect(openExternal).toHaveBeenCalledWith(TEAMS_PRICING_URL);
  });

  it("shows none of the pitch once a team is connected", () => {
    render(<TeamsView registry={registry} onRegistryChange={vi.fn()} />);

    // The ask happens once, on a tab the person chose to open, and stops the moment it
    // has been answered. A member should never see marketing for the thing they joined.
    expect(screen.queryByRole("heading", { name: "No team yet?" })).toBeNull();
    expect(screen.queryByText(TEAMS_FREE_LINE)).toBeNull();
    expect(screen.queryByText(TEAMS_PAID_LINE)).toBeNull();
  });
});

/** The app quotes a price in exactly one place. This is the guard that the copy and the
 * numbers behind it cannot drift apart inside the app; toolport.app/teams#pricing stays
 * the authority for whether the numbers themselves are still right. */
describe("Teams plan copy", () => {
  it("builds its copy from the shared numbers", () => {
    expect(TEAMS_PAID_LINE).toContain(`$${TEAMS_BASE_PRICE}/month`);
    expect(TEAMS_PAID_LINE).toContain(`$${TEAMS_SEAT_PRICE} per person`);
    expect(TEAMS_PAID_LINE).toContain(`up to ${TEAMS_FREE_SEATS}`);
    expect(TEAMS_PAID_LINE).toMatch(/same price hosted or self-hosted/i);
  });

  it("uses no em dashes or en dashes", () => {
    for (const line of [TEAMS_FREE_LINE, TEAMS_PAID_LINE]) {
      expect(line).not.toMatch(/[—–]/);
    }
  });
});
