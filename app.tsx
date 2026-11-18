// BB Sidebar: a shelved, manually ordered replacement for bb's thread list.
// Manual order stays fixed until the user moves a row. Optional views can sort
// by activity, creation date, or project without changing the saved order.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./src/theme.css";
import { ThreadInbox } from "./src/ThreadInbox";
import { SidebarSettings } from "./src/SidebarSettings";
import { registerSnoozeCommands } from "./src/lib/snooze-commands";

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

  // Palette commands act on the thread in view, so a thread can be snoozed
  // without finding its row.
  registerSnoozeCommands(app.commands);
});
