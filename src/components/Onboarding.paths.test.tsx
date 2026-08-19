import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Onboarding } from "./Onboarding";
import type { DetectedClient, Registry } from "@/lib/types";

/** A fresh install: no servers, nothing connected. The state SBS-826 is about. */
const emptyRegistry = {
  version: 1,
  servers: [],
  profiles: [{ id: "default", name: "Default", enabledServerIds: [] }],
  activeProfileId: "default",
} as unknown as Registry;

const detected = {
  id: "claude-code",
  name: "Claude Code",
  appPresent: true,
  gatewayInstalled: false,
  servers: [],
  pluginServers: [],
} as unknown as DetectedClient;

const connected = { ...detected, gatewayInstalled: true } as DetectedClient;

function props(over: Record<string, unknown> = {}) {
  return {
    clients: [detected],
    registry: emptyRegistry,
    onRegistryChange: vi.fn(),
    onClientsRefresh: vi.fn(),
    onBrowseCatalog: vi.fn(),
    onProbe: vi.fn().mockResolvedValue([]),
    onOpenPlayground: vi.fn(),
    onOpenRules: vi.fn(),
    onFinish: vi.fn(),
    ...over,
  };
}

describe("Onboarding first-run paths (SBS-826)", () => {
  it("offers a non-MCP door on the first screen", async () => {
    render(<Onboarding {...props()} />);

    expect(
      screen.getByRole("button", { name: /Set up MCP servers/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Write rules for my agents/ }),
    ).toBeInTheDocument();
    // The promise that makes the second door worth offering at all.
    expect(screen.getByText(/No MCP server needed/)).toBeInTheDocument();
  });

  it("reaches client detection without ever asking for a server", async () => {
    const user = userEvent.setup();
    render(<Onboarding {...props()} />);

    await user.click(screen.getByRole("button", { name: /Write rules for my agents/ }));

    // Straight to Connect: the "Add your first servers" step is not on this path.
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Connect a client");
    expect(screen.queryByText(/Add your first servers/)).not.toBeInTheDocument();
  });

  it("does not tell a rules user they still have to add a server", async () => {
    const user = userEvent.setup();
    render(<Onboarding {...props({ clients: [connected] })} />);

    await user.click(screen.getByRole("button", { name: /Write rules for my agents/ }));
    await user.click(screen.getByRole("button", { name: /Skip for now/ }));

    // The bounce this ticket exists to remove: zero servers is the POINT of this path, so
    // judging the setup by server count would report unfinished work that does not exist.
    expect(screen.queryByText(/added a server/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "You're set up" })).toBeInTheDocument();
  });

  it("does not send a rules user with no client back to add servers", async () => {
    const user = userEvent.setup();
    // No connected client, so the step reports what is still missing. On the rules path
    // the only missing thing is the client - the MCP wording sent them to add the very
    // thing they just declined, and said "do both" for a single item (SBS-826 review).
    render(<Onboarding {...props()} />);

    await user.click(screen.getByRole("button", { name: /Write rules for my agents/ }));
    await user.click(screen.getByRole("button", { name: /Skip for now/ }));

    expect(screen.getByText(/You haven't connected a client yet/)).toBeInTheDocument();
    expect(screen.queryByText(/add\s+or import servers/)).not.toBeInTheDocument();
    expect(screen.queryByText(/do both/)).not.toBeInTheDocument();
  });

  it("never probes for servers a rules user does not have", async () => {
    const user = userEvent.setup();
    const onProbe = vi.fn().mockResolvedValue([]);
    render(<Onboarding {...props({ clients: [connected], onProbe })} />);

    await user.click(screen.getByRole("button", { name: /Write rules for my agents/ }));
    await user.click(screen.getByRole("button", { name: /Skip for now/ }));

    // The health check is about servers, and this path has none. The related first-paint
    // flash of the "Checking server health…" live region is fixed by gating the
    // verification states on `serverCount`, but it cannot be asserted here: `render`
    // flushes effects inside `act`, so the pre-effect paint a real user sees never
    // reaches the DOM this test reads.
    expect(onProbe).not.toHaveBeenCalled();
    expect(screen.queryByText(/Checking server health/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Checking your setup" })).toBeNull();
  });

  it("hands a finished rules user to the Rules tab, and marks onboarding done", async () => {
    const user = userEvent.setup();
    const onOpenRules = vi.fn();
    render(<Onboarding {...props({ clients: [connected], onOpenRules })} />);

    await user.click(screen.getByRole("button", { name: /Write rules for my agents/ }));
    await user.click(screen.getByRole("button", { name: /Skip for now/ }));
    await user.click(screen.getByRole("button", { name: /Set up agent rules/ }));

    expect(onOpenRules).toHaveBeenCalled();
  });

  it("does not ask a rules user to prove an MCP call they cannot make", async () => {
    const user = userEvent.setup();
    render(<Onboarding {...props({ clients: [connected] })} />);

    await user.click(screen.getByRole("button", { name: /Write rules for my agents/ }));
    await user.click(screen.getByRole("button", { name: /Skip for now/ }));

    // With no servers there is nothing to call, so the verify-a-call block would ask for a
    // demonstration that cannot succeed.
    expect(screen.queryByText(/List the tools you can use through Toolport/)).toBeNull();
  });

  it("counts only the steps this path actually has", async () => {
    const user = userEvent.setup();
    render(<Onboarding {...props()} />);

    expect(screen.getByRole("progressbar")).toHaveAccessibleName("Setup step 1 of 4");

    await user.click(screen.getByRole("button", { name: /Write rules for my agents/ }));

    // Three steps on this path, not four with one silently skipped.
    expect(screen.getByRole("progressbar")).toHaveAccessibleName("Setup step 2 of 3");
  });

  it("leaves the MCP path exactly as it was", async () => {
    const user = userEvent.setup();
    render(<Onboarding {...props()} />);

    await user.click(screen.getByRole("button", { name: /Set up MCP servers/ }));

    expect(screen.getByRole("dialog")).toHaveAccessibleName("Add your first servers");
    expect(screen.getByRole("progressbar")).toHaveAccessibleName("Setup step 2 of 4");
  });
});
