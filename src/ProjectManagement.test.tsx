// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { ProjectManagement } from "./ProjectManagement";
import { deferred } from "./test-fixtures";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
});

type Projects = { projects: Array<{ id: string; name: string }> };

it("shows a project renamed elsewhere once the server invalidates the project list", async () => {
  let name = "Sidebar";
  const slot = renderSlot(
    { component: ProjectManagement },
    {},
    { rpc: { listProjects: () => ({ projects: [{ id: "proj_1", name }] }) } },
  );
  const select = await screen.findByRole("combobox", { name: "Project to remove" });
  expect(within(select).getByRole("option", { name: "Sidebar" })).toBeDefined();
  name = "Renamed";
  await slot.behavior.experimental_invalidateRpc(["projects"]);
  await waitFor(() => expect(within(select).getByRole("option", { name: "Renamed" })).toBeDefined());
});

it("a project list read that started before a removal cannot bring the project back", async () => {
  const beforeRemoval = deferred<Projects>();
  let loads = 0;
  let removed = false;
  const slot = renderSlot(
    { component: ProjectManagement },
    {},
    {
      rpc: {
        listProjects: () => (++loads === 1 ? { projects: [{ id: "proj_1", name: "Sidebar" }] } : beforeRemoval.promise),
        removeProject: () => {
          removed = true;
          return { ok: true as const };
        },
      },
    },
  );
  fireEvent.click(await screen.findByRole("button", { name: "Remove…" }));
  // Another change starts a reread that the server answered before the removal.
  const invalidated = slot.behavior.experimental_invalidateRpc(["projects"]);
  await vi.waitFor(() => expect(loads).toBe(2));
  fireEvent.click(screen.getByRole("button", { name: "Remove from BB" }));
  await vi.waitFor(() => expect(removed).toBe(true));
  // The older answer lands after the removal is acknowledged.
  beforeRemoval.resolve({ projects: [{ id: "proj_1", name: "Sidebar" }] });
  await invalidated;
  expect(await screen.findByText("No projects to remove.")).toBeDefined();
  expect(screen.queryByRole("combobox", { name: "Project to remove" })).toBeNull();
});
