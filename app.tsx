// BB Sidebar: a shelved, manually ordered replacement for bb's thread list.
// Manual order stays fixed until the user moves a row. Optional views can sort
// by activity, creation date, or project without changing the saved order.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./src/theme.css";
import { ThreadInbox } from "./src/ThreadInbox";
import { ParentChip } from "./src/ParentChip";
import { SubagentsChip } from "./src/SubagentsChip";
import { SidebarSettings } from "./src/SidebarSettings";
import { registerThreadHeaderAction } from "./src/bb-sdk";
import { BROWSER_EVENTS } from "./src/lib/browser-events";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "sidebar-settings",
    component: SidebarSettings,
  });

  app.slots.experimental_threadList({
    id: "inbox",
    title: "BB Sidebar",
    description: "Shelves, project filtering, manual ordering, and optional sorted views.",
    component: ThreadInbox,
  });

  // Keyboard entry to the filter bar: [project] @machine is:status. The bar
  // listens for this event; with the sidebar closed there is no bar to focus.
  app.commands.register({
    id: "filter-threads",
    title: "BB Sidebar: Filter threads by project, machine, or status",
    defaultShortcut: { key: "s", mod: true, shift: true },
    run: () => {
      window.dispatchEvent(new Event(BROWSER_EVENTS.focusFilter));
    },
  });

  // Registered first, so it renders on the left of the children chip: the
  // header then reads up (parent) then down (children).
  //
  // The hidden child is otherwise a dead end — it is not in the list, so this
  // chip is its only route back to the parent.
  registerThreadHeaderAction(app.slots, {
    id: "parent",
    title: "Parent thread",
    component: ParentChip,
  });

  // A flat inbox has nowhere to nest child threads, so the list hides them
  // and this chip gives them a home on their parent's header.
  registerThreadHeaderAction(app.slots, {
    id: "children",
    title: "Child threads",
    component: SubagentsChip,
  });
});
