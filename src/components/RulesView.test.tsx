import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RulesView as RulesViewData } from "@/lib/types";

const api = vi.hoisted(() => ({
  rulesView: vi.fn(),
  rulesSaveSet: vi.fn(),
  rulesDeleteSet: vi.fn(),
  rulesSetActive: vi.fn(),
  rulesSetClientEnabled: vi.fn(),
  rulesPreview: vi.fn(),
  rulesApply: vi.fn(),
  rulesApplyClient: vi.fn(),
  rulesProjectAdd: vi.fn(),
  rulesProjectRemove: vi.fn(),
  rulesProjectSetSet: vi.fn(),
  rulesProjectSetFileEnabled: vi.fn(),
  rulesProjectApply: vi.fn(),
  rulesProjectPreview: vi.fn(),
  rulesImportCandidates: vi.fn(),
  rulesImportFile: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

import { clearRulesDraftCache, setRulesDraft } from "@/lib/rulesDraftCache";
import { RulesView } from "./RulesView";

function view(over: Partial<RulesViewData> = {}): RulesViewData {
  return {
    sets: [{ id: "work", name: "Work", content: "Always run tests.", revision: 2 }],
    activeSetId: "work",
    clients: [
      {
        id: "codex",
        name: "Codex",
        enabled: true,
        path: "/home/a/.codex/AGENTS.md",
        state: "applied",
      },
      {
        id: "claude-code",
        name: "Claude Code",
        enabled: false,
        path: "/home/a/.claude/rules/toolport-rules.md",
        state: "stale",
      },
      {
        id: "cursor",
        name: "Cursor",
        enabled: false,
        state: "unsupported",
        projectCovered: true,
      },
    ],
    projects: [],
    ...over,
  };
}

describe("RulesView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Held drafts are module state, so they outlive a component and would otherwise leak from one
    // case into the next as phantom unsaved text.
    clearRulesDraftCache();
    api.rulesView.mockResolvedValue(view());
  });

  it("loads the active set into the editor and shows per-client state", async () => {
    render(<RulesView />);
    expect(await screen.findByLabelText("Rules")).toHaveValue("Always run tests.");
    expect(screen.getByLabelText("Rule set name")).toHaveValue("Work");

    // An opted-in client shows its state; an opted-out one does not claim to be applied.
    expect(screen.getByLabelText("Codex")).toBeChecked();
    expect(screen.getByText("Applied")).toBeInTheDocument();
    expect(screen.getByLabelText("Claude Code")).not.toBeChecked();
    expect(screen.queryByText("Not applied yet")).not.toBeInTheDocument();
  });

  it("names the clients it cannot write instead of hiding them", async () => {
    api.rulesView.mockResolvedValue(
      view({
        clients: [
          {
            id: "cursor",
            name: "Cursor",
            enabled: false,
            state: "unsupported",
            projectCovered: true,
          },
          {
            id: "claude-desktop",
            name: "Claude Desktop",
            enabled: false,
            state: "unsupported",
          },
          { id: "opencode", name: "OpenCode", enabled: false, state: "unsupported" },
        ],
      }),
    );
    render(<RulesView />);
    await screen.findByLabelText("Rules");
    // Cursor reads project AGENTS.md: pointed at Projects, not written off as unsupported.
    expect(screen.getByText(/No global rules file for/)).toHaveTextContent("Cursor");
    expect(screen.getByText(/add a folder under Projects below/)).toBeInTheDocument();
    // Claude Desktop is the chat app; saying "unsupported" reads as Claude Code being missed.
    expect(screen.getByText(/Claude Desktop is the chat app/)).toBeInTheDocument();
    // A client with rules nowhere is still called out, not silently dropped, or the user
    // thinks their rules reached it.
    expect(screen.getByText(/No rules file Toolport can write for/)).toHaveTextContent(
      "OpenCode",
    );
    expect(screen.queryByLabelText("Cursor")).not.toBeInTheDocument();
  });

  it("saves only once the draft differs, and sends the edited text", async () => {
    api.rulesSaveSet.mockResolvedValue(
      view({ sets: [{ id: "work", name: "Work", content: "Be brief.", revision: 3 }] }),
    );
    render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");

    // Nothing to save yet.
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();

    await userEvent.clear(editor);
    await userEvent.type(editor, "Be brief.");
    await userEvent.click(screen.getByRole("button", { name: "Save and apply" }));

    await waitFor(() =>
      expect(api.rulesSaveSet).toHaveBeenCalledWith("Work", "Be brief.", "work"),
    );
  });

  it("refuses to save generated Toolport markers pasted from a preview", async () => {
    render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");

    await userEvent.clear(editor);
    await userEvent.type(
      editor,
      "<!-- toolport:rules:start set=work v=2 -->\nAlways run tests.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save and apply" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Remove Toolport's generated markers/,
    );
    expect(api.rulesSaveSet).not.toHaveBeenCalled();
  });

  it("toggling a client off calls through with false", async () => {
    api.rulesSetClientEnabled.mockResolvedValue(view());
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    await userEvent.click(screen.getByLabelText("Codex"));
    await waitFor(() =>
      expect(api.rulesSetClientEnabled).toHaveBeenCalledWith("codex", false),
    );
  });

  it("preview shows the exact bytes and writes nothing", async () => {
    api.rulesPreview.mockResolvedValue({
      clientId: "codex",
      path: "/home/a/.codex/AGENTS.md",
      strategy: "sentinelBlock",
      before: "# Mine\n",
      after: "# Mine\n\n<!-- toolport:rules:start -->\nAlways run tests.\n",
      state: "stale",
    });
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[0]);

    expect(await screen.findByText(/toolport:rules:start/)).toBeInTheDocument();
    expect(screen.getByText(/owns only the marked block/)).toBeInTheDocument();
    expect(api.rulesApply).not.toHaveBeenCalled();
    expect(api.rulesSaveSet).not.toHaveBeenCalled();
  });

  it("preview says so when the write would be refused, instead of just showing bytes", async () => {
    // Windsurf's cap is a refusal, not a truncation. A preview that looks like any other write,
    // followed by nothing landing, reads as a bug rather than a documented limit.
    api.rulesPreview.mockResolvedValue({
      clientId: "codex",
      path: "/home/a/.codex/AGENTS.md",
      strategy: "sentinelBlock",
      before: "# Mine\n",
      after: "# Mine\n\nAlways run tests.\n",
      state: "too_long",
    });
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[0]);

    expect(
      await screen.findByText(/will not be written to this client/),
    ).toHaveTextContent(/hard limit/);
  });

  it("preview shows no warning when the write would land", async () => {
    api.rulesPreview.mockResolvedValue({
      clientId: "codex",
      path: "/home/a/.codex/AGENTS.md",
      strategy: "sentinelBlock",
      before: "# Mine\n",
      after: "# Mine\n\nAlways run tests.\n",
      state: "stale",
    });
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[0]);

    expect(await screen.findByText(/owns only the marked block/)).toBeInTheDocument();
    expect(
      screen.queryByText(/will not be written to this client/),
    ).not.toBeInTheDocument();
  });

  it("switching sets saves an unsaved draft first, so edits are never dropped", async () => {
    api.rulesView.mockResolvedValue(
      view({
        sets: [
          { id: "work", name: "Work", content: "Always run tests.", revision: 2 },
          { id: "personal", name: "Personal", content: "Be brief.", revision: 1 },
        ],
      }),
    );
    api.rulesSaveSet.mockResolvedValue(view());
    api.rulesSetActive.mockResolvedValue(view());
    render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");

    await userEvent.type(editor, " And lint.");
    await userEvent.click(screen.getByRole("button", { name: "Personal" }));

    await waitFor(() =>
      expect(api.rulesSaveSet).toHaveBeenCalledWith(
        "Work",
        "Always run tests. And lint.",
        "work",
      ),
    );
    expect(api.rulesSetActive).toHaveBeenCalledWith("personal");
  });

  it("a block edited on disk is reported with a diff, and Pull into set makes it the draft", async () => {
    api.rulesView.mockResolvedValue(
      view({
        clients: [
          {
            id: "codex",
            name: "Codex",
            enabled: true,
            path: "/home/a/.codex/AGENTS.md",
            state: "drifted",
            onDisk: "Always run tests.\nAnd lint.",
          },
        ],
      }),
    );
    render(<RulesView />);
    await screen.findByLabelText("Rules");
    expect(screen.getByText("Edited on disk")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View diff" }));
    // The card shows the set as saved against the file, line by line.
    expect(screen.getByText("Edited on disk: Codex")).toBeInTheDocument();
    expect(screen.getByText(/^\+ And lint\.$/)).toBeInTheDocument();

    // Pull into set: the file's text becomes the unsaved draft. Nothing is written.
    await userEvent.click(screen.getByRole("button", { name: "Pull into set" }));
    expect(screen.getByLabelText("Rules")).toHaveValue("Always run tests.\nAnd lint.");
    expect(screen.getByRole("button", { name: "Save and apply" })).toBeEnabled();
    expect(api.rulesApply).not.toHaveBeenCalled();
    expect(api.rulesSaveSet).not.toHaveBeenCalled();
    expect(screen.queryByText("Edited on disk: Codex")).not.toBeInTheDocument();
  });

  it("Pull into set asks before replacing unsaved edits", async () => {
    api.rulesView.mockResolvedValue(
      view({
        clients: [
          {
            id: "codex",
            name: "Codex",
            enabled: true,
            path: "/home/a/.codex/AGENTS.md",
            state: "drifted",
            onDisk: "From the file.",
          },
        ],
      }),
    );
    render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");
    await userEvent.type(editor, " Typed but unsaved.");
    await userEvent.click(screen.getByRole("button", { name: "View diff" }));
    await userEvent.click(screen.getByRole("button", { name: "Pull into set" }));
    // Nothing replaced yet: the confirm is up and the typed text is intact.
    expect(screen.getByText("Replace your unsaved edits?")).toBeInTheDocument();
    expect(editor).toHaveValue("Always run tests. Typed but unsaved.");
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(editor).toHaveValue("From the file.");
    expect(api.rulesApply).not.toHaveBeenCalled();
  });

  it("Overwrite this file re-applies the set over the edited block of that client only", async () => {
    api.rulesView.mockResolvedValue(
      view({
        clients: [
          {
            id: "codex",
            name: "Codex",
            enabled: true,
            path: "/home/a/.codex/AGENTS.md",
            state: "drifted",
            onDisk: "Something else.",
          },
        ],
      }),
    );
    api.rulesApplyClient.mockResolvedValue(view());
    render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");
    // An unsaved content edit must NOT be saved (and so applied everywhere) by this.
    await userEvent.type(editor, " Unsaved.");
    await userEvent.click(screen.getByRole("button", { name: "View diff" }));
    await userEvent.click(screen.getByRole("button", { name: "Overwrite this file" }));
    await waitFor(() => expect(api.rulesApplyClient).toHaveBeenCalledWith("codex"));
    expect(api.rulesApply).not.toHaveBeenCalled();
    expect(api.rulesSaveSet).not.toHaveBeenCalled();
    expect(editor).toHaveValue("Always run tests. Unsaved.");
    // The refreshed view says Applied and the diff card is gone; the draft survived.
    expect(await screen.findByText("Applied")).toBeInTheDocument();
    expect(screen.queryByText("Edited on disk: Codex")).not.toBeInTheDocument();
  });

  it("a registered project lists its files with the clients that read them, and nothing writes until Apply", async () => {
    const project = {
      id: "repo",
      path: "/home/a/code/repo",
      name: "repo",
      setId: "work",
      files: [
        {
          key: "agents-md",
          relPath: "AGENTS.md",
          path: "/home/a/code/repo/AGENTS.md",
          clients: ["Codex", "Cursor"],
          enabled: false,
          state: "stale" as const,
        },
        {
          key: "claude-rules",
          relPath: ".claude/rules/toolport-rules.md",
          path: "/home/a/code/repo/.claude/rules/toolport-rules.md",
          clients: ["Claude Code"],
          enabled: true,
          state: "applied" as const,
        },
      ],
    };
    api.rulesView.mockResolvedValue(view({ projects: [project] }));
    api.rulesProjectSetFileEnabled.mockResolvedValue(view({ projects: [project] }));
    api.rulesProjectApply.mockResolvedValue(view({ projects: [project] }));
    api.rulesProjectSetSet.mockResolvedValue(view({ projects: [project] }));

    render(<RulesView />);
    await screen.findByLabelText("Rules");
    expect(screen.getByText("/home/a/code/repo")).toBeInTheDocument();
    expect(screen.getByText("for Codex, Cursor")).toBeInTheDocument();
    expect(screen.getByLabelText("Rule set for repo")).toHaveValue("work");
    // Switching a file on is a registry change only; the call says so and nothing applies.
    await userEvent.click(screen.getByLabelText("AGENTS.md in repo"));
    await waitFor(() =>
      expect(api.rulesProjectSetFileEnabled).toHaveBeenCalledWith(
        "repo",
        "agents-md",
        true,
      ),
    );
    expect(api.rulesProjectApply).not.toHaveBeenCalled();
    // Apply is the explicit write, per project.
    await userEvent.click(screen.getByRole("button", { name: "Apply to repo" }));
    await waitFor(() => expect(api.rulesProjectApply).toHaveBeenCalledWith("repo"));
    // Changing the set is also just a registry change.
    await userEvent.selectOptions(screen.getByLabelText("Rule set for repo"), "");
    await waitFor(() =>
      expect(api.rulesProjectSetSet).toHaveBeenCalledWith("repo", undefined),
    );
    // The global editor was not disturbed by any of this.
    expect(screen.getByLabelText("Rules")).toHaveValue("Always run tests.");
  });

  it("a failed action still refreshes the view, so a partial apply shows its true state", async () => {
    const before = view({
      projects: [
        {
          id: "repo",
          path: "/home/a/code/repo",
          name: "repo",
          setId: "work",
          files: [
            {
              key: "agents-md",
              relPath: "AGENTS.md",
              path: "/home/a/code/repo/AGENTS.md",
              clients: ["Codex"],
              enabled: true,
              state: "stale" as const,
            },
          ],
        },
      ],
    });
    const after = view({
      projects: [
        {
          ...before.projects[0],
          files: [{ ...before.projects[0].files[0], state: "applied" as const }],
        },
      ],
    });
    api.rulesView.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    api.rulesProjectApply.mockRejectedValue(
      new Error(
        "/home/a/code/repo/GEMINI.md was not written: it could not be read or written.",
      ),
    );
    render(<RulesView />);
    await screen.findByLabelText("Rules");
    expect(screen.getByText("Not applied yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Apply to repo" }));
    // The error is shown AND the row reflects what actually happened on disk.
    expect(await screen.findByRole("alert")).toHaveTextContent("was not written");
    // Codex's global row was already Applied; the project row joins it after the refresh.
    await waitFor(() => expect(screen.getAllByText("Applied")).toHaveLength(2));
    expect(screen.queryByText("Not applied yet")).not.toBeInTheDocument();
    expect(api.rulesView).toHaveBeenCalledTimes(2);
  });

  it("deleting a set a project uses says the project's folder is cleaned too", async () => {
    api.rulesView.mockResolvedValue(
      view({
        sets: [
          { id: "work", name: "Work", content: "Always run tests.", revision: 2 },
          { id: "side", name: "Side", content: "Side rules.", revision: 1 },
        ],
        projects: [
          {
            id: "repo",
            path: "/home/a/code/repo",
            name: "repo",
            setId: "side",
            files: [],
          },
        ],
      }),
    );
    render(<RulesView />);
    await screen.findByLabelText("Rules");
    await userEvent.click(screen.getByRole("button", { name: "Delete Side" }));
    expect(
      screen.getByText(/also applied to the project \u201Crepo\u201D/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/This unused rule set is deleted/)).not.toBeInTheDocument();
  });

  it("adding a project goes through the folder picker and registers the picked path", async () => {
    dialog.open.mockResolvedValue("/home/a/code/other");
    api.rulesProjectAdd.mockResolvedValue(
      view({
        projects: [{ id: "other", path: "/home/a/code/other", name: "other", files: [] }],
      }),
    );
    render(<RulesView />);
    await screen.findByLabelText("Rules");
    expect(screen.getByText(/No project folders registered/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add a project folder" }));
    await waitFor(() =>
      expect(api.rulesProjectAdd).toHaveBeenCalledWith("/home/a/code/other"),
    );
    expect(dialog.open).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true }),
    );
    expect(await screen.findByText("/home/a/code/other")).toBeInTheDocument();
  });

  it("starts a new set from an existing rules file without selecting (and so applying) it", async () => {
    api.rulesImportCandidates.mockResolvedValue([
      {
        clientId: "codex",
        clientName: "Codex",
        path: "/home/a/.codex/AGENTS.md",
        bytes: 2048,
      },
    ]);
    api.rulesImportFile.mockResolvedValue({
      path: "/home/a/.codex/AGENTS.md",
      name: "Imported from Codex",
      content: "Be terse.",
      strippedOurs: true,
    });
    const withNew = view({
      sets: [
        { id: "work", name: "Work", content: "Always run tests.", revision: 2 },
        { id: "imp", name: "Imported from Codex", content: "Be terse.", revision: 1 },
      ],
    });
    api.rulesSaveSet.mockResolvedValue(withNew);

    render(<RulesView />);
    await screen.findByLabelText("Rules");
    await userEvent.click(screen.getByRole("button", { name: "Start from a file" }));
    // The panel lists the client's own file with its size, and says the file is not changed.
    const candidate = await screen.findByRole("button", {
      name: /Codex .*AGENTS\.md.*2\.0 KB/,
    });
    expect(screen.getByText(/the file is not\s+changed/)).toBeInTheDocument();
    await userEvent.click(candidate);

    // The set is created WITH the text and not selected: selecting applies, and that is the
    // user's call. The editor still shows the set that was active; the new chip is there.
    await waitFor(() =>
      expect(api.rulesSaveSet).toHaveBeenCalledWith("Imported from Codex", "Be terse."),
    );
    expect(api.rulesImportFile).toHaveBeenCalledWith("/home/a/.codex/AGENTS.md", "Codex");
    expect(api.rulesSetActive).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("button", { name: "Imported from Codex" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Rules")).toHaveValue("Always run tests.");
    // It says what happened: Toolport's own block was left out, and nothing applied yet.
    expect(
      screen.getByText(/block Toolport had written there was left out/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Pick it above to edit and apply it/)).toBeInTheDocument();
    expect(dialog.open).not.toHaveBeenCalled();
  });

  it("an import that becomes the first applied set is not overwritten by a stale held draft", async () => {
    // Nothing selected: the backend selects the new set. A draft left behind by an earlier,
    // deleted set that had the same id must not be restored over the imported text.
    api.rulesView.mockResolvedValue(view({ sets: [], activeSetId: undefined }));
    api.rulesImportCandidates.mockResolvedValue([]);
    dialog.open.mockResolvedValue("/home/a/.codex/AGENTS.md");
    api.rulesImportFile.mockResolvedValue({
      path: "/home/a/.codex/AGENTS.md",
      name: "Imported from Codex",
      content: "Be terse.",
      strippedOurs: false,
    });
    api.rulesSaveSet.mockResolvedValue(
      view({
        sets: [
          {
            id: "imported-from-codex",
            name: "Imported from Codex",
            content: "Be terse.",
            revision: 1,
          },
        ],
        activeSetId: "imported-from-codex",
      }),
    );
    setRulesDraft("imported-from-codex", {
      name: "Imported from Codex",
      content: "OLD STALE TEXT",
    });

    render(<RulesView />);
    await screen.findByText(/No rule set yet/);
    await userEvent.click(screen.getByRole("button", { name: "Start from a file" }));
    await userEvent.click(await screen.findByRole("button", { name: "Choose a file…" }));
    await waitFor(() => expect(screen.getByLabelText("Rules")).toHaveValue("Be terse."));
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
    expect(screen.getByText(/It is now your applied set/)).toBeInTheDocument();
  });

  it("the file picker feeds the same import, and a failed import is surfaced", async () => {
    api.rulesImportCandidates.mockResolvedValue([]);
    dialog.open.mockResolvedValue("/tmp/mine.md");
    api.rulesImportFile.mockRejectedValue(new Error("/tmp/mine.md is not UTF-8 text"));

    render(<RulesView />);
    await screen.findByLabelText("Rules");
    await userEvent.click(screen.getByRole("button", { name: "Start from a file" }));
    expect(await screen.findByText(/No rules files found/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Choose a file…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not UTF-8");
    expect(api.rulesImportFile).toHaveBeenCalledWith("/tmp/mine.md", undefined);
    // Nothing was created for a file that could not be read.
    expect(api.rulesSaveSet).not.toHaveBeenCalled();
    // The editor still shows the set that was there before.
    expect(screen.getByLabelText("Rules")).toHaveValue("Always run tests.");
  });

  it("creating a set switches to it, so the editor is not still on the old one", async () => {
    // The backend only auto-activates a new set when nothing else is active, so without an
    // explicit select this button would look like it did nothing.
    const created = view({
      sets: [
        { id: "work", name: "Work", content: "Always run tests.", revision: 2 },
        { id: "new-rules", name: "New rules", content: "", revision: 1 },
      ],
    });
    api.rulesSaveSet.mockResolvedValue(created);
    api.rulesSetActive.mockResolvedValue({ ...created, activeSetId: "new-rules" });
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    await userEvent.click(screen.getByRole("button", { name: "New set" }));

    await waitFor(() => expect(api.rulesSetActive).toHaveBeenCalledWith("new-rules"));
    expect(screen.getByLabelText("Rules")).toHaveValue("");
    expect(screen.getByLabelText("Rule set name")).toHaveValue("New rules");
  });

  it("creating a set saves an unsaved draft first, so edits are never dropped", async () => {
    const created = view({
      sets: [
        { id: "work", name: "Work", content: "Always run tests. And lint.", revision: 3 },
        { id: "new-rules", name: "New rules", content: "", revision: 1 },
      ],
    });
    api.rulesSaveSet.mockResolvedValue(created);
    api.rulesSetActive.mockResolvedValue({ ...created, activeSetId: "new-rules" });
    render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");

    await userEvent.type(editor, " And lint.");
    await userEvent.click(screen.getByRole("button", { name: "New set" }));

    await waitFor(() =>
      expect(api.rulesSaveSet).toHaveBeenCalledWith(
        "Work",
        "Always run tests. And lint.",
        "work",
      ),
    );
    expect(api.rulesSaveSet).toHaveBeenCalledWith("New rules", "");
  });

  /**
   * "Type your rules, then switch a client on" is the first thing anyone does. Every action that
   * refreshes the view reseats the editor from the SAVED set, so any of them that forgets to
   * flush first silently replaces what the user typed with the old text.
   */
  // Preview is deliberately NOT in this list: it must not save, because saving applies to every
  // opted-in client. It sends the draft to the backend instead, covered separately below.
  it.each([
    ["toggling a client", () => screen.getByLabelText("Claude Code")],
    ["Re-apply", () => screen.getByRole("button", { name: "Re-apply" })],
  ])("%s saves an unsaved draft instead of discarding it", async (_label, target) => {
    const saved = view({
      sets: [
        { id: "work", name: "Work", content: "Always run tests. And lint.", revision: 3 },
      ],
    });
    api.rulesSaveSet.mockResolvedValue(saved);
    api.rulesSetClientEnabled.mockResolvedValue(saved);
    api.rulesApply.mockResolvedValue(saved);
    api.rulesPreview.mockResolvedValue(null);
    render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");

    await userEvent.type(editor, " And lint.");
    await userEvent.click(target());

    await waitFor(() =>
      expect(api.rulesSaveSet).toHaveBeenCalledWith(
        "Work",
        "Always run tests. And lint.",
        "work",
      ),
    );
    expect(screen.getByLabelText("Rules")).toHaveValue("Always run tests. And lint.");
  });

  it("scrolls the preview into view and names the client it belongs to", async () => {
    // The card renders after the clients list, so on a short window it opens below the fold and
    // Preview reads as a dead button. `src/test/setup.ts` stubs scrollIntoView as a no-op, so
    // swap in a spy for the length of this test and put the stub back afterwards.
    const scrollIntoView = vi.fn();
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      api.rulesPreview.mockResolvedValue({
        clientId: "codex",
        path: "/home/a/.codex/AGENTS.md",
        strategy: "sentinelBlock",
        before: "",
        after: "Always run tests.\n",
        state: "stale",
      });
      render(<RulesView />);
      await screen.findByLabelText("Rules");

      await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[0]);
      expect(await screen.findByText("/home/a/.codex/AGENTS.md")).toBeInTheDocument();

      // Smooth by default; the reduced-motion branch is covered below.
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "start",
      });
      // Two clients can share one file, so the path alone does not say whose preview this is.
      expect(screen.getByRole("heading", { name: "Preview: Codex" })).toBeInTheDocument();
    } finally {
      if (original) Object.defineProperty(Element.prototype, "scrollIntoView", original);
      else delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("does not animate the preview scroll for a reduced-motion reader", async () => {
    // index.css already zeroes scroll-behavior under prefers-reduced-motion, but an explicit
    // `behavior` in the options dict beats that CSS property, so the component has to read the
    // preference itself. Without that, this is the one animation the stylesheet cannot reach.
    const scrollIntoView = vi.fn();
    const originalScroll = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    );
    Element.prototype.scrollIntoView = scrollIntoView;
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    try {
      api.rulesPreview.mockResolvedValue({
        clientId: "codex",
        path: "/home/a/.codex/AGENTS.md",
        strategy: "sentinelBlock",
        before: "",
        after: "Always run tests.\n",
        state: "stale",
      });
      render(<RulesView />);
      await screen.findByLabelText("Rules");

      await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[0]);
      expect(await screen.findByText("/home/a/.codex/AGENTS.md")).toBeInTheDocument();

      // Still scrolled - the card must reach the screen either way. Just not animated.
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    } finally {
      matchMedia.mockRestore();
      if (originalScroll) {
        Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
      } else {
        delete (Element.prototype as Partial<Element>).scrollIntoView;
      }
    }
  });

  it("clears a stale preview when the view is reseated", async () => {
    api.rulesPreview.mockResolvedValue({
      clientId: "codex",
      path: "/home/a/.codex/AGENTS.md",
      strategy: "sentinelBlock",
      before: "",
      after: "Always run tests.\n",
      state: "stale",
    });
    api.rulesApply.mockResolvedValue(view());
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[0]);
    expect(await screen.findByText("/home/a/.codex/AGENTS.md")).toBeInTheDocument();

    // A preview naming a path and bytes that no longer match the editor is worse than none.
    await userEvent.click(screen.getByRole("button", { name: "Re-apply" }));
    await waitFor(() =>
      expect(screen.queryByText("/home/a/.codex/AGENTS.md")).not.toBeInTheDocument(),
    );
  });

  it("does not claim there are no sets when a deleted set left siblings behind", async () => {
    // `remove_rule_set` clears the selection rather than promoting a sibling, so the other sets
    // are still on screen. Saying none exist would contradict the chips right above.
    api.rulesView.mockResolvedValue(
      view({
        sets: [
          { id: "work", name: "Work", content: "Always run tests.", revision: 2 },
          { id: "personal", name: "Personal", content: "Be brief.", revision: 1 },
        ],
        activeSetId: undefined,
      }),
    );
    render(<RulesView />);

    expect(await screen.findByText(/Pick one above/)).toBeInTheDocument();
    expect(screen.queryByText(/No rule set yet/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Personal" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Preview/ })[0]).toHaveAttribute(
      "title",
      "Pick a rule set first",
    );
  });

  it("a failed preview does not leave another client's card on screen", async () => {
    api.rulesPreview.mockResolvedValueOnce({
      clientId: "codex",
      path: "/home/a/.codex/AGENTS.md",
      strategy: "sentinelBlock",
      before: "",
      after: "Always run tests.\n",
      state: "stale",
    });
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    const previews = screen.getAllByRole("button", { name: /Preview/ });
    await userEvent.click(previews[0]);
    expect(await screen.findByText("/home/a/.codex/AGENTS.md")).toBeInTheDocument();

    // Second client's preview fails. Codex's bytes must not sit under the error looking like
    // they belong to Claude Code.
    api.rulesPreview.mockRejectedValueOnce(new Error("permission denied"));
    await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[1]);

    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
    expect(screen.queryByText("/home/a/.codex/AGENTS.md")).not.toBeInTheDocument();
  });

  it("editing clears an open preview instead of letting it go stale", async () => {
    api.rulesPreview.mockResolvedValue({
      clientId: "codex",
      path: "/home/a/.codex/AGENTS.md",
      strategy: "sentinelBlock",
      before: "",
      after: "Always run tests.\n",
      state: "stale",
    });
    render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");

    await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[0]);
    expect(await screen.findByText("/home/a/.codex/AGENTS.md")).toBeInTheDocument();

    await userEvent.type(editor, " And lint.");
    expect(screen.queryByText("/home/a/.codex/AGENTS.md")).not.toBeInTheDocument();
  });

  it("a failed load says so instead of claiming the machine is empty", async () => {
    api.rulesView.mockRejectedValue(new Error("registry unreadable"));
    render(<RulesView />);

    expect(await screen.findByRole("alert")).toHaveTextContent("registry unreadable");
    // We never found out what is on this machine, so we must not report an answer.
    expect(screen.queryByText(/No AI clients/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No rule set yet/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });

  it("restores a held draft when retrying a failed load", async () => {
    setRulesDraft("work", {
      name: "Work",
      content: "Always run tests. And lint.",
    });
    api.rulesView
      .mockRejectedValueOnce(new Error("registry unreadable"))
      .mockResolvedValueOnce(view());
    render(<RulesView />);

    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));

    expect(await screen.findByLabelText("Rules")).toHaveValue(
      "Always run tests. And lint.",
    );
    expect(screen.getByRole("button", { name: "Save and apply" })).toBeEnabled();
  });

  /**
   * The control says it writes nothing, so it must write nothing. Routing it through a save (to
   * make the bytes accurate) applied the draft to every opted-in client's file first, which is the
   * opposite of a dry run.
   */
  it("preview of an unsaved draft writes nothing and still shows the typed text", async () => {
    api.rulesPreview.mockResolvedValue({
      clientId: "codex",
      path: "/home/a/.codex/AGENTS.md",
      strategy: "sentinelBlock",
      before: "# Mine\n",
      after: "# Mine\n\nAlways run tests. And lint.\n",
      state: "stale",
    });
    render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");

    await userEvent.type(editor, " And lint.");
    await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[0]);

    // The draft goes to the backend as an argument, not through a save.
    await waitFor(() =>
      expect(api.rulesPreview).toHaveBeenCalledWith(
        "codex",
        "Always run tests. And lint.",
      ),
    );
    expect(api.rulesSaveSet).not.toHaveBeenCalled();
    expect(api.rulesApply).not.toHaveBeenCalled();
    // Scoped to the preview block: the same text is also in the textarea the user just typed it in.
    expect(
      await screen.findByText(/And lint\./, { selector: "pre" }),
    ).toBeInTheDocument();
  });

  it("previewing a clean editor sends no draft override", async () => {
    api.rulesPreview.mockResolvedValue(null);
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    await userEvent.click(screen.getAllByRole("button", { name: /Preview/ })[0]);
    await waitFor(() =>
      expect(api.rulesPreview).toHaveBeenCalledWith("codex", undefined),
    );
  });

  it("keeps an unsaved draft across leaving and returning to the tab", async () => {
    const { unmount } = render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");
    await userEvent.type(editor, " And lint.");

    // Switching sidebar views unmounts this tree with no chance to flush. Losing the text there
    // would break the same promise every in-tab action keeps.
    unmount();
    expect(api.rulesSaveSet).not.toHaveBeenCalled();

    render(<RulesView />);
    expect(await screen.findByLabelText("Rules")).toHaveValue(
      "Always run tests. And lint.",
    );
    expect(screen.getByRole("button", { name: "Save and apply" })).toBeEnabled();
  });

  it("does not resurrect a draft that was already saved", async () => {
    const saved = view({
      sets: [
        { id: "work", name: "Work", content: "Always run tests. And lint.", revision: 3 },
      ],
    });
    api.rulesSaveSet.mockResolvedValue(saved);
    const { unmount } = render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");

    await userEvent.type(editor, " And lint.");
    await userEvent.click(screen.getByRole("button", { name: "Save and apply" }));
    await waitFor(() => expect(api.rulesSaveSet).toHaveBeenCalled());
    unmount();

    api.rulesView.mockResolvedValue(saved);
    render(<RulesView />);
    // Same text, but from the saved set, so it must not read as unsaved work.
    expect(await screen.findByLabelText("Rules")).toHaveValue(
      "Always run tests. And lint.",
    );
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
  });

  /**
   * Deleting a set that is not active must not activate it on the way. Activation applies, so
   * every opted-in client's file would be rewritten to the set being discarded and then emptied.
   */
  it("saves the active draft before deleting a non-active set", async () => {
    const sets = [
      { id: "work", name: "Work", content: "Always run tests.", revision: 2 },
      { id: "personal", name: "Personal", content: "Be brief.", revision: 1 },
    ];
    const saved = view({
      sets: [
        { id: "work", name: "Work", content: "Always run tests. And lint.", revision: 3 },
        sets[1],
      ],
    });
    api.rulesView.mockResolvedValue(view({ sets }));
    api.rulesSaveSet.mockResolvedValue(saved);
    api.rulesDeleteSet.mockResolvedValue(
      view({
        sets: [
          {
            id: "work",
            name: "Work",
            content: "Always run tests. And lint.",
            revision: 3,
          },
        ],
      }),
    );
    render(<RulesView />);
    const editor = await screen.findByLabelText("Rules");

    await userEvent.type(editor, " And lint.");
    await userEvent.click(screen.getByRole("button", { name: "Delete Personal" }));
    expect(
      screen.getByText(/active set and client files stay unchanged/i),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(api.rulesSaveSet).toHaveBeenCalledWith(
        "Work",
        "Always run tests. And lint.",
        "work",
      ),
    );
    await waitFor(() => expect(api.rulesDeleteSet).toHaveBeenCalledWith("personal"));
    expect(api.rulesSetActive).not.toHaveBeenCalled();
    expect(api.rulesSaveSet.mock.invocationCallOrder[0]).toBeLessThan(
      api.rulesDeleteSet.mock.invocationCallOrder[0],
    );
    expect(screen.getByLabelText("Rules")).toHaveValue("Always run tests. And lint.");
  });

  it("shows no state badge while no set is applied", async () => {
    // The backend reports Applied for "correctly nothing on disk". Rendering that as
    // "Applied / up to date" right after the user deleted their rules reads as still in place.
    api.rulesView.mockResolvedValue(
      view({
        activeSetId: undefined,
        clients: [
          {
            id: "codex",
            name: "Codex",
            enabled: true,
            path: "/home/a/.codex/AGENTS.md",
            state: "applied",
          },
        ],
      }),
    );
    render(<RulesView />);

    expect(await screen.findByText(/No set is applied right now/)).toBeInTheDocument();
    expect(screen.queryByText("Applied")).not.toBeInTheDocument();
  });

  it("shows a stale cleanup state when no set is active", async () => {
    api.rulesView.mockResolvedValue(
      view({
        activeSetId: undefined,
        clients: [
          {
            id: "codex",
            name: "Codex",
            enabled: true,
            path: "/home/a/.codex/AGENTS.md",
            state: "stale",
          },
        ],
      }),
    );
    render(<RulesView />);

    expect(await screen.findByText("Not applied yet")).toBeInTheDocument();
  });

  it("with no set, the editor is replaced by a prompt and preview is unavailable", async () => {
    api.rulesView.mockResolvedValue(view({ sets: [], activeSetId: undefined }));
    render(<RulesView />);

    expect(await screen.findByText(/No rule set yet/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Rules")).not.toBeInTheDocument();
    for (const b of screen.getAllByRole("button", { name: /Preview/ })) {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute("title", "Create a rule set first");
    }
  });

  it("surfaces a failed write instead of leaving the UI looking clean", async () => {
    api.rulesSetClientEnabled.mockRejectedValue(new Error("permission denied"));
    render(<RulesView />);
    await screen.findByLabelText("Rules");

    await userEvent.click(screen.getByLabelText("Claude Code"));
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
  });
});
