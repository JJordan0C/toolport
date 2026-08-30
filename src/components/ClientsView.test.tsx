import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DetectedClient } from "@/lib/types";
import { ClientsView } from "./ClientsView";

function client(overrides: Partial<DetectedClient> = {}): DetectedClient {
  return {
    id: "cursor",
    name: "Cursor",
    usesConnectors: false,
    configPath: "/tmp/cursor.json",
    configExists: true,
    appPresent: true,
    servers: [],
    pluginServers: [],
    gatewayInstalled: false,
    entryState: "absent",
    error: null,
    ...overrides,
  };
}

describe("ClientsView", () => {
  it("groups connected clients before clients available to connect", () => {
    render(
      <ClientsView
        clients={[
          client({ id: "cursor", name: "Cursor" }),
          client({
            id: "claude-desktop",
            name: "Claude Desktop",
            gatewayInstalled: true,
            entryState: "managed",
          }),
        ]}
        registry={null}
        onSelectClient={vi.fn()}
      />,
    );

    expect(screen.getByText("Connected to Toolport")).toBeInTheDocument();
    expect(screen.getByText("Available to connect")).toBeInTheDocument();
    const rows = screen.getAllByRole("button");
    expect(rows[0]).toHaveTextContent("Claude Desktop");
    expect(rows[0]).toHaveTextContent("Connected");
    expect(rows[1]).toHaveTextContent("Cursor");
    expect(rows[1]).toHaveTextContent("Ready to connect");
  });

  it("does not describe a customized gateway entry as connected", () => {
    render(
      <ClientsView
        clients={[
          client({
            gatewayInstalled: true,
            entryState: "customized",
          }),
        ]}
        registry={null}
        onSelectClient={vi.fn()}
      />,
    );

    expect(screen.getByText("Custom configuration")).toBeInTheDocument();
    expect(screen.getByText("Available to connect")).toBeInTheDocument();
    expect(
      screen.queryByText("Your installed clients are connected to Toolport."),
    ).not.toBeInTheDocument();
  });

  it("mentions config-read errors alongside connected clients", () => {
    render(
      <ClientsView
        clients={[
          client({
            id: "claude-desktop",
            name: "Claude Desktop",
            gatewayInstalled: true,
            entryState: "managed",
          }),
          client({
            id: "cursor",
            name: "Cursor",
            error: "invalid JSON",
          }),
        ]}
        registry={null}
        onSelectClient={vi.fn()}
      />,
    );

    expect(screen.getByText("Connected to Toolport")).toBeInTheDocument();
    expect(screen.getByText("Available to connect")).toBeInTheDocument();
    expect(
      screen.queryByText("Your installed clients are connected to Toolport."),
    ).not.toBeInTheDocument();
  });

  it("opens the selected client", async () => {
    const onSelectClient = vi.fn();
    render(
      <ClientsView
        clients={[client()]}
        registry={null}
        onSelectClient={onSelectClient}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /cursor/i }));
    expect(onSelectClient).toHaveBeenCalledWith("cursor");
  });

  it("keeps clients that are not installed behind a disclosure", async () => {
    render(
      <ClientsView
        clients={[
          client(),
          client({
            id: "zed",
            name: "Zed",
            appPresent: false,
            configExists: false,
            configPath: "",
          }),
        ]}
        registry={null}
        onSelectClient={vi.fn()}
      />,
    );

    const toggle = screen.getByRole("button", { name: /not installed/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /zed/i })).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /zed/i })).toHaveTextContent(
      "Not installed",
    );
  });

  it("shows an honest empty state when detection returns nothing", () => {
    render(<ClientsView clients={[]} registry={null} onSelectClient={vi.fn()} />);

    expect(screen.getByText("No AI clients detected")).toBeInTheDocument();
    expect(screen.getByText(/install claude desktop/i)).toBeInTheDocument();
  });

  it("shows loading placeholders before client detection completes", () => {
    render(<ClientsView clients={[]} registry={null} loading onSelectClient={vi.fn()} />);

    expect(screen.getByLabelText("Loading AI clients")).toBeInTheDocument();
    expect(screen.queryByText("No AI clients detected")).not.toBeInTheDocument();
  });

  it("explains an inventory containing only clients that are not installed", () => {
    render(
      <ClientsView
        clients={[
          client({
            id: "zed",
            name: "Zed",
            appPresent: false,
            configExists: false,
            configPath: "",
          }),
        ]}
        registry={null}
        onSelectClient={vi.fn()}
      />,
    );

    expect(screen.getByText("No supported clients installed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /not installed/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
