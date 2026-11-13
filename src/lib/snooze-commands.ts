import type { PluginAppCommands } from "@get-bb/plugin-sdk/app";
import {
  type ConfiguredSnoozePreset,
  DEFAULT_SNOOZE_PRESET_CONFIG,
  parseConfiguredSnoozePresets,
  resolveConfiguredSnoozePreset,
} from "../lifecycle";
import { BROWSER_EVENTS } from "./browser-events";
import { toast } from "./toast";

export type SnoozeCommandRequest =
  | { kind: "snooze"; threadId: string; snoozedUntil: number }
  | { kind: "unsnooze"; threadId: string };

type CalendarDay = Extract<ConfiguredSnoozePreset, { calendar: unknown }>["calendar"];
const CALENDAR_TITLES: Record<CalendarDay, string> = {
  evening: "until this evening",
  tomorrow: "until tomorrow morning",
  "next-week": "until next week",
};

/** A stable command id and a title from the preset's time, not its label. */
function paletteCommand(preset: ConfiguredSnoozePreset) {
  if ("calendar" in preset) {
    return { id: `snooze-${preset.calendar}`, title: CALENDAR_TITLES[preset.calendar], preset };
  }
  const minutes = preset.durationMs / 60_000;
  const [amount, unit] = minutes % 60 === 0 ? [minutes / 60, "hour"] : [minutes, "minute"];
  return { id: `snooze-${amount}${unit[0]}`, title: `for ${amount} ${unit}${amount === 1 ? "" : "s"}`, preset };
}

// Palette rows are registered once at load, before settings arrive, so they
// follow the default presets rather than the user's configured ones.
const SNOOZE_COMMANDS = parseConfiguredSnoozePresets(DEFAULT_SNOOZE_PRESET_CONFIG).map(paletteCommand);

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
