// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, defaultProviders, listProps, render, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("card metadata", () => {
  // Labels come from the model catalog (last column), then the provider's levels, then the raw ID.
  it.each([
    [undefined, "gpt-6.1-sol", true, "medium", "Medium", "Medium"],
    ["GPT 6.1 Sol", "GPT 6.1 Sol", true, "medium", "Medium", "Medium"],
    ["GPT 6.1 Sol Medium", "GPT 6.1 Sol Medium", false, "medium", "Medium", "Medium"],
    ["GPT 6.1 Sol (Medium)", "GPT 6.1 Sol (Medium)", false, "medium", "Medium", "Medium"],
    ["My Custom Model", "My Custom Model", true, "xhigh", "Extra High", "Extra High"],
    ["My Custom Model (Extra High)", "My Custom Model (Extra High)", false, "xhigh", "Extra High", "Extra High"],
    ["My Custom Model Extra High", "My Custom Model Extra High", false, "xhigh", "Extra High", "Extra High"],
    ["My Custom Model (xhigh)", "My Custom Model (xhigh)", false, "xhigh", "Extra High", "Extra High"],
    ["My Custom Model", "My Custom Model", true, "custom", "Deep Thinking", undefined],
    ["My Custom Model (Deep Thinking)", "My Custom Model (Deep Thinking)", false, "custom", "Deep Thinking", undefined],
    ["My Custom Model", "My Custom Model", true, "xhigh", "xhigh", undefined],
  ])(
    "shows model display name %s with a raw ID fallback",
    async (modelDisplayName, label, showReasoning, effort, effortLabel, reasoningLabel) => {
      renderSlot(inbox, listProps, {
        sidebarThreads: {
          status: "ready",
          threads: [thread({ id: "thr_model", title: "Model details" })],
          projects: [],
        },
        providers: {
          status: "ready",
          providers: defaultProviders.map((provider) => ({
            ...provider,
            reasoningLevels: [{ id: "custom", label: "Deep Thinking" }],
          })),
        },
        rpc: {
          getThreadExecutionDetails: () => ({
            model: "gpt-6.1-sol",
            ...(modelDisplayName ? { modelDisplayName } : {}),
            ...(reasoningLabel ? { reasoningLabel } : {}),
            reasoningLevel: effort,
          }),
        },
      });
      fireEvent.pointerMove(screen.getByRole("link", { name: "Model details" }), { pointerType: "mouse" });
      const details = await screen.findByRole("dialog", { name: "Thread details" });
      await waitFor(() => expect(details.textContent).toContain(`Model: ${label}`));
      expect(details.textContent?.includes(`Reasoning: ${effortLabel}`)).toBe(showReasoning);
      expect(details.textContent).not.toContain("Provider:");
      expect(details.textContent).not.toContain("codex");
      expect(within(details).getByRole("img", { name: "Codex" })).toBeDefined();
      const executionRow = within(details).getByText("Model:").parentElement!;
      expect(executionRow.className).toContain("truncate");
      expect(executionRow.getAttribute("title")).toBe(`${label}${showReasoning ? ` ${effortLabel}` : ""}`);
      if (showReasoning) expect(executionRow.textContent).toContain(`${label} Reasoning: ${effortLabel}`);
      if (modelDisplayName) expect(details.textContent).not.toContain("gpt-6.1-sol");
    },
  );

  it("always shows the provider glyph, even without a branch", async () => {
    render([thread({ id: "thr_p", providerId: "claude-code" })]);
    expect(await screen.findByLabelText("Claude Code")).toBeDefined();
  });

  it("falls back to a neutral glyph for an unknown provider", async () => {
    render([thread({ id: "thr_p", providerId: "some-new-agent" })]);
    expect(await screen.findByLabelText("some-new-agent")).toBeDefined();
  });

  // A personal-project thread has a machine but no worktree, so the machine
  // takes the branch's place instead of leaving the line blank.
  it("shows the machine when the thread has no branch", async () => {
    render([
      thread({
        id: "thr_m",
        host: { id: "host_1", name: "Dev MacBook" },
      }),
    ]);
    expect(await screen.findByText("Dev MacBook")).toBeDefined();
  });

  it("prefers the branch over the machine when both exist", async () => {
    render([
      thread({
        id: "thr_b",
        host: { id: "host_1", name: "Dev MacBook" },
        environment: {
          id: "env_1",
          name: "Worktree",
          branchName: "bb/feature",
          workspaceDisplayKind: "managed-worktree",
          path: null,
          isWorktree: true,
          providerId: null,
        },
      }),
    ]);
    expect(await screen.findByText("bb/feature")).toBeDefined();
    expect(screen.queryByText("Dev MacBook")).toBeNull();
    expect(await screen.findByLabelText("Worktree branch")).toBeDefined();
    expect(screen.getByLabelText("Machine: Dev MacBook")).toBeDefined();
  });

  it("shows a plain branch cue for non-worktree checkouts", async () => {
    render([
      thread({
        id: "thr_checkout",
        environment: {
          id: "env_1",
          name: "Checkout",
          branchName: "main",
          workspaceDisplayKind: "other",
          path: null,
          isWorktree: null,
          providerId: null,
        },
      }),
    ]);
    expect(await screen.findByLabelText("Branch")).toBeDefined();
    expect(screen.queryByLabelText("Worktree branch")).toBeNull();
  });

  it.each([
    ["managed-worktree", true, "FolderGit", "Worktree branch"],
    ["unmanaged-worktree", true, "FolderGit", "Worktree branch"],
    ["other", false, "GitBranch", "Branch"],
  ] as const)(
    "shows one branch line with matching icons for %s",
    async (workspaceDisplayKind, isWorktree, icon, branchLabel) => {
      render([
        thread({
          title: "Unnamed worktree thread",
          environment: {
            id: "env_worktree",
            name: null,
            branchName: "bb/feature",
            path: null,
            isWorktree,
            providerId: null,
            workspaceDisplayKind,
          },
        }),
      ]);

      expect(screen.getByLabelText(branchLabel).getAttribute("data-icon")).toBe(icon);
      act(() => screen.getByRole("link", { name: "Unnamed worktree thread" }).focus());
      const details = await screen.findByRole("dialog", { name: "Thread details" });
      const label = within(details).getByText(`${branchLabel}:`);
      expect(label.className).toContain("sr-only");
      expect(label.parentElement?.previousElementSibling?.getAttribute("data-icon")).toBe(icon);
      expect(within(details).getAllByText("bb/feature")).toHaveLength(1);
    },
  );

  it("reduces read idle emphasis without weakening unread rows", async () => {
    render([
      thread({ id: "read", title: "Read row", createdAt: 20 }),
      thread({
        id: "unread",
        title: "Unread row",
        isUnread: true,
        createdAt: 10,
      }),
    ]);
    const read = (await screen.findByText("Read row")).closest("[data-row-emphasis]");
    const unread = screen.getByText("Unread row").closest("[data-row-emphasis]");
    expect(read?.getAttribute("data-row-emphasis")).toBe("read-idle");
    expect(read?.className).toContain("text-muted-foreground");
    expect(unread?.getAttribute("data-row-emphasis")).toBe("unread");
    expect(unread?.className).toContain("font-medium");
    expect(unread?.className).toContain("text-foreground");
  });

  it("shows the shared details card on the main thread without an icon tooltip", async () => {
    render([
      thread({
        id: "thr_details",
        title: "Thread metadata",
        providerId: "claude-code",
        host: { id: "host_1", name: "Build Mac" },
        environment: {
          id: "env_1",
          name: "Feature worktree",
          branchName: "bb/details",
          workspaceDisplayKind: "unmanaged-worktree",
          path: null,
          isWorktree: true,
          providerId: null,
        },
        activity: {
          workflows: 1,
          backgroundAgents: 2,
          backgroundCommands: 0,
          planMode: 0,
        },
      }),
    ]);

    expect(screen.queryByLabelText("Thread details")).toBeNull();
    fireEvent.pointerMove(await screen.findByRole("link", { name: "Thread metadata" }), { pointerType: "mouse" });
    const details = await screen.findByRole("dialog", { name: "Thread details" });
    expect(details.textContent).toContain("Project: bb");
    expect(details.textContent).not.toContain("Feature worktree");
    expect(details.textContent).toContain("Worktree branch: bb/details");
    expect(details.textContent).toContain("Machine: Build Mac");
    expect(details.textContent).not.toContain("Provider:");
    expect(within(details).getByRole("img", { name: "Claude Code" })).toBeDefined();
    expect(details.textContent).toContain("Model:");
    expect(within(details).queryByRole("list", { name: "Subthreads" })).toBeNull();
  });

  // Not exactly 3h: the card's clock is quantized to the minute, so a
  // timestamp sitting on a bucket boundary legitimately reads one unit lower.
  it("shows how long ago the thread was touched", async () => {
    render([thread({ id: "thr_t", updatedAt: Date.now() - (3 * 3_600_000 + 60_000) })]);
    expect(await screen.findByText("3h")).toBeDefined();
  });

  // Status and age share one slot. Live work uses a short readable label;
  // idle rows use their age.
  it("replaces the age label with a readable status while work runs", async () => {
    render([
      thread({
        id: "thr_run",
        indicator: "runtime",
        indicatorLabel: "Agent is working",
        updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
      }),
    ]);
    expect(await screen.findByLabelText("Agent is working")).toBeDefined();
    expect(screen.getByText("Working").className).toContain("text-[color:var(--bb-sidebar-tone-working)]");
    expect(screen.queryByText("3h")).toBeNull();
  });

  // The host says only that a thread is working, so the sidebar keeps its own
  // stamp per thread and shows how long the current stretch has run.
  it("shows how long a thread has been working", async () => {
    window.localStorage.setItem(
      "bb-sidebar:working-since:v1",
      JSON.stringify({ thr_run: Date.now() - 5 * 60_000 - 60_000 }),
    );
    render([thread({ id: "thr_run", indicator: "runtime" })]);
    expect(await screen.findByText("Working · 5m")).toBeDefined();
  });

  it("shows monitoring when BB identifies a monitoring runtime", async () => {
    window.localStorage.setItem(
      "bb-sidebar:working-since:v1",
      JSON.stringify({ thr_monitor: Date.now() - 5 * 60_000 - 60_000 }),
    );
    render([
      thread({
        id: "thr_monitor",
        indicator: "runtime",
        indicatorLabel: "Thread monitoring",
      }),
    ]);
    expect(await screen.findByText("Monitoring · 5m")).toBeDefined();
    expect(screen.getByLabelText("Thread monitoring")).toBeDefined();
  });

  it("stamps a thread that starts working and persists the stamp", async () => {
    render([thread({ id: "thr_run", indicator: "runtime" })]);
    expect(await screen.findByText("Working")).toBeDefined();
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem("bb-sidebar:working-since:v1") ?? "{}") as Record<
        string,
        number
      >;
      expect(typeof stored.thr_run).toBe("number");
    });
  });

  // A request for input is a verdict, not a stretch of work, and reads oddly
  // with a duration behind it.
  it("leaves the duration off a status that is waiting on the user", async () => {
    window.localStorage.setItem("bb-sidebar:working-since:v1", JSON.stringify({ thr_ask: Date.now() - 10 * 60_000 }));
    render([
      thread({
        id: "thr_ask",
        indicator: "waiting-for-input",
        hasPendingInteraction: true,
      }),
    ]);
    expect(await screen.findByText("Needs you")).toBeDefined();
  });

  // bb paints no indicator for queued messages, so without these labels a
  // failed send reads as idle or merely busy.
  it("labels a failed send over everything but a question", async () => {
    render([
      thread({ id: "thr_failed", indicator: "runtime", queuedWork: "failed" }),
      thread({
        id: "thr_asking",
        hasPendingInteraction: true,
        queuedWork: "failed",
      }),
    ]);
    expect(await screen.findByText("Send failed")).toBeDefined();
    expect(screen.getByLabelText("A queued message failed to send")).toBeDefined();
    expect(screen.getByText("Needs you")).toBeDefined();
    expect(screen.queryByText("Working")).toBeNull();
  });

  it("labels a waiting message only on an otherwise quiet row", async () => {
    render([
      thread({ id: "thr_scheduled", title: "Scheduled", queuedWork: "waiting" }),
      thread({
        id: "thr_behind",
        title: "Behind a turn",
        indicator: "runtime",
        queuedWork: "waiting",
      }),
    ]);
    expect(await screen.findByText("Queued")).toBeDefined();
    expect(screen.getByLabelText("A message is waiting to send")).toBeDefined();
    expect(screen.getAllByText("Queued")).toHaveLength(1);
    expect(screen.getByText("Working")).toBeDefined();
  });

  // An indicator this plugin does not know must fall through to the age label
  // rather than leave the slot blank.  // An indicator this plugin does not know must fall through to the age label
  // rather than leave the slot blank.
  it("keeps the age label for an unrecognized indicator", async () => {
    render([
      thread({
        id: "thr_new",
        indicator: "something-bb-ships-later" as never,
        updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
      }),
    ]);
    expect(await screen.findByText("3h")).toBeDefined();
  });

  // bb keeps unsent composer drafts out of `indicator`, so the row folds them
  // in itself, in bb's order: a draft never hides a result you have not read.
  it("marks threads holding an unsent draft", async () => {
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "thr_idle", title: "Idle draft" }),
          thread({ id: "thr_busy", title: "Busy draft", indicator: "runtime", indicatorLabel: "Thread working" }),
          thread({
            id: "thr_unread",
            title: "Unread draft",
            indicator: "unread-success",
            indicatorLabel: "Unread thread succeeded",
            isUnread: true,
          }),
          thread({ id: "thr_clean", title: "No draft", updatedAt: Date.now() - (3 * 3_600_000 + 60_000) }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      providers: { status: "ready", providers: defaultProviders },
      rpc: { listLifecycle: () => ({ rows: [] }) },
      sidebarDraftThreadIds: ["thr_idle", "thr_busy", "thr_unread"],
    });
    expect(await screen.findByLabelText("Thread has unsubmitted draft")).toBeDefined();
    expect(screen.getByText("Draft").className).toContain("text-[color:var(--bb-sidebar-tone-draft)]");
    expect(screen.getByLabelText("Thread working with unsubmitted draft")).toBeDefined();
    expect(screen.getByText("Drafting")).toBeDefined();
    expect(screen.getByText("Unread")).toBeDefined();
    expect(screen.getByText("3h")).toBeDefined();
  });

  // Moved from the removed header chip's tests; the only test of a failed
  // lookup, run on a sidebar child row.
  it.each([false, true])("loads a child row's execution details only on hover, failure=%s", async (fail) => {
    let requests = 0;
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "parent", title: "Parent" }),
          thread({ id: "child", title: "Child", parentThreadId: "parent" }),
        ],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        getThreadExecutionDetails: (input) => {
          expect(input).toEqual({ threadId: "child" });
          requests++;
          if (fail) throw new Error("Offline");
          return { model: "gpt-6", reasoningLabel: "High", reasoningLevel: "high" };
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "1 child thread" }));
    expect(requests).toBe(0);
    const row = screen.getByRole("link", { name: "Open child thread: Child" });
    fireEvent.pointerMove(row, { pointerType: "mouse" });
    await waitFor(() => {
      const tooltip = screen.getByRole("dialog", { name: "Thread details" });
      expect(tooltip.textContent).not.toContain("Provider:");
      expect(within(tooltip).getByRole("img", { name: "codex" })).toBeDefined();
      expect(tooltip.textContent).toContain(fail ? "Model: Unavailable" : "Model: gpt-6");
      if (!fail) expect(tooltip.textContent).toContain("Reasoning: High");
    });
    expect(requests).toBe(1);
  });
});
