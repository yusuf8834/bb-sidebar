import type { PluginAppCommands } from "@get-bb/plugin-sdk/app";
import { type ConfiguredSnoozePreset, resolveConfiguredSnoozePreset } from "../lifecycle";
import { BROWSER_EVENTS } from "./browser-events";
import { toast } from "./toast";

export type SnoozeCommandRequest =
  | { kind: "snooze"; threadId: string; snoozedUntil: number }
  | { kind: "unsnooze"; threadId: string };

// Palette rows are registered once at load, before settings arrive, so they
// follow the default presets rather than the user's configured ones.
const SNOOZE_COMMANDS: { id: string; title: string; preset: ConfiguredSnoozePreset }[] = [
  { id: "snooze-1h", title: "for 1 hour", preset: { id: "1h", label: "1 hour", durationMs: 60 * 60_000 } },
  { id: "snooze-5h", title: "for 5 hours", preset: { id: "5h", label: "5 hours", durationMs: 5 * 60 * 60_000 } },
  {
    id: "snooze-evening",
    title: "until this evening",
    preset: { id: "evening", label: "This evening", calendar: "evening", hour: 18, minute: 0 },
  },
  {
    id: "snooze-tomorrow",
    title: "until tomorrow morning",
    preset: { id: "tomorrow", label: "Tomorrow morning", calendar: "tomorrow", hour: 9, minute: 0 },
  },
  {
    id: "snooze-next-week",
    title: "until next week",
    preset: { id: "next-week", label: "Next week", calendar: "next-week", hour: 9, minute: 0 },
  },
];

/** Hand the request to the mounted inbox, which owns the snooze actions. */
function requestSnooze(request: SnoozeCommandRequest) {
  const event = new CustomEvent(BROWSER_EVENTS.snoozeCommand, { detail: request, cancelable: true });
  if (window.dispatchEvent(event)) toast.error("Open the BB Sidebar to snooze threads");
}

export function registerSnoozeCommands(commands: PluginAppCommands) {
  for (const { id, title, preset } of SNOOZE_COMMANDS) {
    commands.register({
      id,
      title: `BB Sidebar: Snooze this thread ${title}`,
      isAvailable: ({ threadId }) => threadId !== null && resolveConfiguredSnoozePreset(preset) !== null,
      run: ({ threadId }) => {
        const snoozedUntil = resolveConfiguredSnoozePreset(preset);
        if (threadId !== null && snoozedUntil !== null) requestSnooze({ kind: "snooze", threadId, snoozedUntil });
      },
    });
  }
  commands.register({
    id: "unsnooze",
    title: "BB Sidebar: Unsnooze this thread",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => {
      if (threadId !== null) requestSnooze({ kind: "unsnooze", threadId });
    },
  });
}
