// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActiveSortPicker } from "./ActiveSortPicker";
import type { ActiveSortMode } from "./inbox-layout";

afterEach(cleanup);

function Picker() {
  const [mode, setMode] = useState<ActiveSortMode>("manual");
  const [groupEnvironments, setGroupEnvironments] = useState(false);
  const [groupSingleThreadProjects, setGroupSingleThreadProjects] = useState(true);
  return (
    <ActiveSortPicker
      mode={mode}
      onModeChange={setMode}
      groupEnvironments={groupEnvironments}
      onGroupEnvironmentsChange={setGroupEnvironments}
      groupSingleThreadProjects={groupSingleThreadProjects}
      onGroupSingleThreadProjectsChange={setGroupSingleThreadProjects}
    />
  );
}

function openPicker() {
  render(<Picker />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Sort active threads: Manual order" }), { key: "Enter" });
}

it.each(["Manual order", "Recent activity", "Waiting longest", "Date created"])(
  "closes after a pointer click on %s",
  (name) => {
    openPicker();
    fireEvent.click(screen.getByRole("radio", { name }), { detail: 1 });
    expect(screen.queryByRole("dialog", { name: "Sort active threads" })).toBeNull();
    expect(screen.getByRole("button", { name: `Sort active threads: ${name}` })).toBeDefined();
  },
);

it("selects without dismissing on a keyboard-generated click", () => {
  openPicker();
  fireEvent.click(screen.getByRole("radio", { name: "Recent activity" }), { detail: 0 });
  expect(screen.getByRole("dialog", { name: "Sort active threads" })).toBeDefined();
  expect((screen.getByRole("radio", { name: "Recent activity" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole("button", { name: "Sort active threads: Recent activity" })).toBeDefined();
});

it("closes when Enter commits the selected radio", () => {
  openPicker();
  fireEvent.keyDown(screen.getByRole("radio", { name: "Manual order" }), { key: "Enter" });
  expect(screen.queryByRole("dialog", { name: "Sort active threads" })).toBeNull();
});

it("keeps Project open for environment grouping after pointer and Enter activation", () => {
  openPicker();
  const project = screen.getByRole("radio", { name: "Project" });
  fireEvent.click(project, { detail: 1 });
  fireEvent.keyDown(project, { key: "Enter" });
  expect(screen.getByRole("dialog", { name: "Sort active threads" })).toBeDefined();
  const toggle = screen.getByRole("checkbox", { name: "Group by worktree" });
  fireEvent.click(toggle);
  expect((toggle as HTMLInputElement).checked).toBe(true);
  const singles = screen.getByRole("checkbox", { name: "Group single-thread projects" });
  expect((singles as HTMLInputElement).checked).toBe(true);
  fireEvent.click(singles);
  expect((singles as HTMLInputElement).checked).toBe(false);
});
