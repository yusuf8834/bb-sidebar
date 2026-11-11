// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

it("shows port details in the thread hover card", async () => {
  localStorage.setItem("bb-sidebar:port-link-host:v1", "host_local");
  const openUrl = vi.fn(() => true);
  renderSlot(inbox, listProps, {
    openUrl,
    sidebarThreads: {
      status: "ready",
      threads: [
        thread({
          title: "Port details",
          host: { id: "host_local", name: "Local" },
          environment: {
            id: "env_ports",
            name: null,
            branchName: "main",
            workspaceDisplayKind: "other",
            path: null,
            isWorktree: null,
            providerId: null,
          },
        }),
      ],
      projects: [],
    },
    rpc: {
      listLifecycle: () => ({ rows: [] }),
      getOpenPorts: () => ({
        groups: [
          {
            environmentId: "env_ports",
            ports: [
              { port: 3000, processName: "node", pid: 1234, address: "127.0.0.1", source: "process" },
              { port: 5432, service: "postgres", container: "app-db-1", address: "0.0.0.0", source: "docker" },
            ],
          },
        ],
      }),
      getThreadExecutionDetails: () => null,
    },
  });
  fireEvent.pointerMove(screen.getByRole("link", { name: "Port details" }), { pointerType: "mouse" });
  const details = await screen.findByRole("dialog", { name: "Thread details" });
  expect(details.textContent).toContain("Workspace ports (2)");
  expect(details.textContent).not.toContain(":3000 node");
  const toggle = within(details).getByRole("button", { name: /Workspace ports/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(details.textContent).toContain(":3000 node");
  expect(details.textContent).toContain("127.0.0.1 · PID 1234");
  expect(details.textContent).toContain(":5432 postgres");
  expect(details.textContent).toContain("Docker · app-db-1");
  expect(within(details).getByRole("button", { name: "Stop process on port 3000" })).toBeDefined();
  // Docker containers are stopped with Docker, not by signalling a PID.
  expect(within(details).queryByRole("button", { name: "Stop process on port 5432" })).toBeNull();
  expect(screen.queryByRole("img", { name: "Open ports started by this thread" })).toBeNull();
  const portLink = screen.getAllByRole("link", { name: "Open port 3000" })[0]!;
  expect(portLink.getAttribute("href")).toBe("http://127.0.0.1:3000/");
  fireEvent.click(portLink);
  expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:3000/");
  const row = screen.getByRole("link", { name: "Port details" });
  act(() => row.focus());
  fireEvent.keyDown(row, { key: "Tab" });
  expect(document.activeElement).toBe(toggle);
  fireEvent.keyDown(toggle, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull());
  expect(document.activeElement).toBe(row);
});
it("keeps a long workspace port list accessible even without local links", async () => {
  renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      projects: [],
      threads: [
        thread({
          title: "Many ports",
          environment: {
            id: "env_ports",
            name: null,
            branchName: "main",
            workspaceDisplayKind: "other",
            path: null,
            isWorktree: null,
            providerId: null,
          },
        }),
      ],
    },
    rpc: {
      listLifecycle: () => ({ rows: [] }),
      getThreadExecutionDetails: () => null,
      getOpenPorts: () => ({
        groups: [{ environmentId: "env_ports", ports: Array.from({ length: 20 }, (_, i) => ({ port: 8000 + i })) }],
      }),
    },
  });
  const row = screen.getByRole("link", { name: "Many ports" });
  act(() => row.focus());
  fireEvent.click(await screen.findByRole("button", { name: /Workspace ports \(20\)/ }));
  const list = await screen.findByRole("region", { name: "Workspace port list" });
  expect(within(list).getByText(":8019")).toBeDefined();
});
it("stops a workspace port process only after a second press", async () => {
  const stopWorkspacePort = vi.fn(() => ({ signalled: [3000], skipped: [], failed: [] }));
  let groups = [
    { environmentId: "env_ports", ports: [{ port: 3000, processName: "node", pid: 1234, source: "process" as const }] },
  ];
  const getOpenPorts = vi.fn(() => ({ groups }));
  renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      projects: [],
      threads: [
        thread({
          id: "thr_ports",
          title: "Stoppable",
          environment: {
            id: "env_ports",
            name: null,
            branchName: "main",
            workspaceDisplayKind: "other",
            path: null,
            isWorktree: null,
            providerId: null,
          },
        }),
      ],
    },
    rpc: {
      listLifecycle: () => ({ rows: [] }),
      getThreadExecutionDetails: () => null,
      getOpenPorts,
      stopWorkspacePort,
    },
  });
  fireEvent.pointerMove(screen.getByRole("link", { name: "Stoppable" }), { pointerType: "mouse" });
  const details = await screen.findByRole("dialog", { name: "Thread details" });
  fireEvent.click(await within(details).findByRole("button", { name: /Workspace ports \(1\)/ }));
  fireEvent.click(within(details).getByRole("button", { name: "Stop process on port 3000" }));
  expect(stopWorkspacePort).not.toHaveBeenCalled();
  groups = [];
  const scans = getOpenPorts.mock.calls.length;
  fireEvent.click(within(details).getByRole("button", { name: "Confirm stopping PID 1234 on port 3000" }));
  await waitFor(() =>
    expect(stopWorkspacePort).toHaveBeenCalledWith({ threadId: "thr_ports", port: { port: 3000, pid: 1234 } }),
  );
  await waitFor(() => expect(getOpenPorts.mock.calls.length).toBeGreaterThan(scans));
  await waitFor(() => expect(details.textContent).not.toContain("Workspace ports"));
});
it("marks only the owning thread without a count and clears its icon when the port closes", async () => {
  const environment = {
    id: "env_ports",
    name: null,
    branchName: "main",
    workspaceDisplayKind: "other" as const,
    path: null,
    isWorktree: null,
    providerId: null,
  };
  let groups = [
    {
      environmentId: environment.id,
      ports: [
        { port: 3000, ownerThreadId: "ports_a" },
        { port: 8080, ownerThreadId: "" },
      ],
    },
  ];
  renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads: [
        thread({ id: "ports_a", environment }),
        thread({ id: "ports_b", environment }),
        thread({ id: "no_ports" }),
      ],
      projects: [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
    },
    rpc: {
      listLifecycle: () => ({ rows: [] }),
      getOpenPorts: () => ({ groups }),
    },
  });
  const label = "Open ports started by this thread";
  await waitFor(() => expect(screen.getAllByRole("img", { name: label })).toHaveLength(1));
  expect(screen.getByRole("img", { name: label }).textContent).toBe("");
  expect(screen.getByRole("img", { name: label }).className).toContain("text-muted-foreground/60");
  vi.useFakeTimers();
  // Trigger a fresh provider mount so its next poll uses the fake clock.
  cleanup();
  renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", threads: [thread({ id: "ports_a", environment })], projects: [] },
    rpc: {
      listLifecycle: () => ({ rows: [] }),
      getOpenPorts: () => ({ groups }),
    },
  });
  await act(async () => {});
  expect(screen.getByRole("img", { name: label })).toBeTruthy();
  groups = [];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(screen.queryByRole("img", { name: label })).toBeNull();
  cleanup();
  vi.useRealTimers();
});
