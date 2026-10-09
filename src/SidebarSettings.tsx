import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { bbSidebarRpcContract } from "./server";
import {
  cachedSidebarSettings,
  cacheSidebarSettings,
  CHILD_THREAD_ICON_STYLES,
  CHILD_THREAD_SORT_DIRECTIONS,
  CHILD_THREAD_SORT_FIELDS,
  DEFAULT_SIDEBAR_SETTINGS,
  SIDEBAR_SETTINGS_CHANNEL,
  type ChildThreadIconStyle,
  type ChildThreadSortDirection,
  type ChildThreadSortField,
  type SidebarSettingsValues,
} from "./sidebar-settings";
import { ProjectSettings } from "./ProjectSettings";
import { ArchiveSettings } from "./ArchiveShelf";
import { PortLinkSettings } from "./PortLinkSettings";
import {
  configuredSnoozePresetError,
  parseConfiguredSnoozePresets,
} from "./lifecycle";
import {
  MAX_INACTIVE_AFTER_HOURS,
  MIN_INACTIVE_AFTER_HOURS,
} from "./inactive";
import {
  MAX_AUTO_SETTLE_AFTER_DAYS,
  MIN_AUTO_SETTLE_AFTER_DAYS,
} from "./auto-settle";
import {
  InlineNumber,
  SettingRow,
  SettingsSection,
  SettingsSelect,
  Switch,
  type SaveStatus,
} from "./settings-ui";

const CHILD_SORT_FIELD_LABELS: Record<ChildThreadSortField, string> = {
  created: "Date created",
  activity: "Last activity",
};
const CHILD_ICON_STYLE_LABELS: Record<ChildThreadIconStyle, string> = {
  disc: "Colour circle",
  provider: "Provider icon",
};
const CHILD_SORT_DIRECTION_LABELS: Record<ChildThreadSortDirection, string> = {
  ascending: "Oldest first",
  descending: "Newest first",
};

/** Long enough to finish typing a shortcut, short enough to feel instant. */
const SAVE_DELAY_MS = 500;
/** How long "Saved" stays beside a section before it fades. */
const SAVED_VISIBLE_MS = 2_000;

/** The section each setting lives in, so its save feedback shows there. */
const SECTION_BY_SETTING: Record<keyof SidebarSettingsValues, string> = {
  inactiveThreadsEnabled: "Shelves",
  inactiveAfterHours: "Shelves",
  snoozePresets: "Snooze",
  autoSettleInactive: "Automatic settle",
  autoSettleAfterDays: "Automatic settle",
  autoSettleOnMerge: "Automatic settle",
  showRunningChildrenWhenCollapsed: "Child threads",
  childSortField: "Child threads",
  childSortDirection: "Child threads",
  childIconStyle: "Child threads",
  compactWorkingThreads: "Experimental",
  workingShelf: "Experimental",
  dockShelves: "Experimental",
  archivedShelfEnabled: "Shelves",
  projectColorsEnabled: "Appearance",
};

/**
 * The plugin's settings page. Every change saves on its own, as bb's own
 * settings do; a value that fails validation shows why and is not sent.
 */
export function SidebarSettings() {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const loadRequestSeq = useRef(0);
  const initialSettings = cachedSidebarSettings(rpc);
  const [saved, setSaved] = useState<SidebarSettingsValues>(
    initialSettings ?? DEFAULT_SIDEBAR_SETTINGS,
  );
  const [draft, setDraft] = useState<SidebarSettingsValues>(
    initialSettings ?? DEFAULT_SIDEBAR_SETTINGS,
  );
  const savedRef = useRef(saved);
  const draftRef = useRef(draft);
  savedRef.current = saved;
  draftRef.current = draft;
  const savingRef = useRef(false);
  const [loading, setLoading] = useState(initialSettings === null);
  const changedSectionRef = useRef<string | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<{
    section: string;
    status: SaveStatus;
  } | null>(null);
  const statusFor = (section: string) =>
    saveFeedback?.section === section ? saveFeedback.status : undefined;

  useEffect(() => {
    if (saveFeedback?.status !== "saved") return;
    const timer = setTimeout(
      () => setSaveFeedback((current) => (current === saveFeedback ? null : current)),
      SAVED_VISIBLE_MS,
    );
    return () => clearTimeout(timer);
  }, [saveFeedback]);

  const load = useCallback(async () => {
    const seq = ++loadRequestSeq.current;
    try {
      const result = await rpc.call("getSidebarSettings", {});
      if (seq !== loadRequestSeq.current) return;
      const cached = cacheSidebarSettings(rpc, result);
      const hasLocalEdits =
        JSON.stringify(draftRef.current) !== JSON.stringify(savedRef.current);
      savedRef.current = cached;
      setSaved(cached);
      if (!hasLocalEdits) {
        draftRef.current = cached;
        setDraft(cached);
      }
    } catch (error) {
      if (seq !== loadRequestSeq.current) return;
      toast.error("Could not load sidebar settings", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      if (seq === loadRequestSeq.current) setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime(SIDEBAR_SETTINGS_CHANNEL, () => {
    void load();
  });

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const inactiveHoursValid =
    Number.isInteger(draft.inactiveAfterHours) &&
    draft.inactiveAfterHours >= MIN_INACTIVE_AFTER_HOURS &&
    draft.inactiveAfterHours <= MAX_INACTIVE_AFTER_HOURS;
  const autoSettleDaysValid =
    Number.isInteger(draft.autoSettleAfterDays) &&
    draft.autoSettleAfterDays >= MIN_AUTO_SETTLE_AFTER_DAYS &&
    draft.autoSettleAfterDays <= MAX_AUTO_SETTLE_AFTER_DAYS;
  const snoozePresetsError = configuredSnoozePresetError(draft.snoozePresets);
  const hasValidationError =
    (draft.inactiveThreadsEnabled && !inactiveHoursValid) ||
    (draft.autoSettleInactive && !autoSettleDaysValid) ||
    snoozePresetsError !== null;
  const snoozePreview = snoozePresetsError
    ? []
    : parseConfiguredSnoozePresets(draft.snoozePresets).map(
        (preset) => preset.label,
      );
  const update = <Key extends keyof SidebarSettingsValues>(
    key: Key,
    value: SidebarSettingsValues[Key],
  ) => {
    changedSectionRef.current = SECTION_BY_SETTING[key];
    setDraft((current) => {
      const next = { ...current, [key]: value };
      draftRef.current = next;
      return next;
    });
  };

  const save = async () => {
    // One write at a time. When it lands, `saved` changes and the effect
    // below schedules the next one if the draft moved on meanwhile.
    if (savingRef.current) return;
    const sent = draftRef.current;
    // A load started before this write cannot overwrite its result.
    loadRequestSeq.current += 1;
    savingRef.current = true;
    const section = changedSectionRef.current;
    if (section) setSaveFeedback({ section, status: "saving" });
    try {
      const result = await rpc.call("updateSidebarSettings", {
        ...sent,
        // A disabled rule may hold a half-typed number; send a valid one.
        inactiveAfterHours: inactiveHoursValid
          ? sent.inactiveAfterHours
          : DEFAULT_SIDEBAR_SETTINGS.inactiveAfterHours,
        autoSettleAfterDays: autoSettleDaysValid
          ? sent.autoSettleAfterDays
          : DEFAULT_SIDEBAR_SETTINGS.autoSettleAfterDays,
      });
      const cached = cacheSidebarSettings(rpc, result);
      savedRef.current = cached;
      setSaved(cached);
      if (draftRef.current === sent) {
        draftRef.current = cached;
        setDraft(cached);
      }
      if (section) setSaveFeedback({ section, status: "saved" });
    } catch (error) {
      if (section) setSaveFeedback({ section, status: "error" });
      toast.error("Could not save sidebar settings", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      savingRef.current = false;
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  const pendingSave = !loading && dirty && !hasValidationError;
  const pendingSaveRef = useRef(pendingSave);
  pendingSaveRef.current = pendingSave;

  useEffect(() => {
    if (!pendingSave) return;
    const timer = setTimeout(() => void saveRef.current(), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, saved, pendingSave]);
  // Leaving the page inside the delay still keeps the last change.
  useEffect(
    () => () => {
      if (pendingSaveRef.current) void saveRef.current();
    },
    [],
  );

  if (loading) {
    return (
      <div className="max-w-3xl rounded-lg border border-border px-4 py-8 text-center text-sm text-muted-foreground">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-8 pb-4">
      <SettingsSection title="Shelves" status={statusFor("Shelves")}>
        <SettingRow
          title="Archived shelf"
          description="Show archived threads at the bottom of the sidebar, with filtering and restore controls."
          control={<Switch label="Archived shelf" checked={draft.archivedShelfEnabled} onChange={(checked) => update("archivedShelfEnabled", checked)} />}
        />
        <SettingRow
          title="Inactive shelf"
          description="Move quiet, unpinned threads out of Active. New activity brings them back."
          control={
            <Switch
              label="Inactive shelf"
              checked={draft.inactiveThreadsEnabled}
              onChange={(checked) => update("inactiveThreadsEnabled", checked)}
            />
          }
        >
          {draft.inactiveThreadsEnabled ? (
            <InlineNumber
              label="Hours before inactive"
              prefix="After"
              suffix="hours without activity"
              value={draft.inactiveAfterHours}
              min={MIN_INACTIVE_AFTER_HOURS}
              max={MAX_INACTIVE_AFTER_HOURS}
              valid={inactiveHoursValid}
              errorId="inactive-hours-error"
              onChange={(value) => update("inactiveAfterHours", value)}
            />
          ) : null}
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Snooze" status={statusFor("Snooze")}>
        <SettingRow
          title="Snooze shortcuts"
          description={
            <>
              Comma-separated. Durations like <Code>30m</Code> or{" "}
              <Code>2h</Code>, times like <Code>evening@18:00</Code>,{" "}
              <Code>tomorrow@09:00</Code> or <Code>next-week@09:00</Code>.
              Rename one with <Code>Label=value</Code>.
            </>
          }
        >
          <textarea
            aria-label="Snooze shortcuts"
            aria-invalid={snoozePresetsError !== null}
            aria-describedby="snooze-shortcuts-feedback"
            value={draft.snoozePresets}
            onChange={(event) => update("snoozePresets", event.target.value)}
            rows={2}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs leading-5 text-foreground outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring aria-[invalid=true]:border-destructive"
          />
          <div id="snooze-shortcuts-feedback" className="mt-1.5">
            {snoozePresetsError ? (
              <p className="text-2xs text-destructive">{snoozePresetsError}</p>
            ) : (
              <ul
                aria-label="Snooze menu preview"
                className="flex flex-wrap items-center gap-1"
              >
                {snoozePreview.map((label, index) => (
                  <li
                    key={`${index}-${label}`}
                    className="rounded border border-border bg-muted/50 px-1.5 py-0.5 text-2xs text-muted-foreground"
                  >
                    {label}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Automatic settle" status={statusFor("Automatic settle")}>
        <SettingRow
          title="Settle quiet threads"
          description="Move threads to Settled after a longer quiet period."
          control={
            <Switch
              label="Settle inactive threads"
              checked={draft.autoSettleInactive}
              onChange={(checked) => update("autoSettleInactive", checked)}
            />
          }
        >
          {draft.autoSettleInactive ? (
            <InlineNumber
              label="Days before auto-settle"
              prefix="After"
              suffix="days without activity"
              value={draft.autoSettleAfterDays}
              min={MIN_AUTO_SETTLE_AFTER_DAYS}
              max={MAX_AUTO_SETTLE_AFTER_DAYS}
              valid={autoSettleDaysValid}
              errorId="auto-settle-days-error"
              onChange={(value) => update("autoSettleAfterDays", value)}
            />
          ) : null}
        </SettingRow>
        <SettingRow
          title="Settle merged pull requests"
          description="Closed pull requests always count as finished."
          control={
            <Switch
              label="Settle merged pull requests"
              checked={draft.autoSettleOnMerge}
              onChange={(checked) => update("autoSettleOnMerge", checked)}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Child threads" status={statusFor("Child threads")}>
        <SettingRow
          title="Show children that need attention"
          description="Keep children with a status visible while their list is collapsed."
          control={
            <Switch
              label="Show children that need attention"
              checked={draft.showRunningChildrenWhenCollapsed}
              onChange={(checked) =>
                update("showRunningChildrenWhenCollapsed", checked)
              }
            />
          }
        />
        <SettingRow
          title="Order"
          description="Also used in the thread header."
          control={
            <div className="flex items-center gap-2">
              <SettingsSelect
                aria-label="Child threads sort field"
                value={draft.childSortField}
                onChange={(event) =>
                  update(
                    "childSortField",
                    event.target.value as ChildThreadSortField,
                  )
                }
                className="w-36"
              >
                {CHILD_THREAD_SORT_FIELDS.map((field) => (
                  <option key={field} value={field}>
                    {CHILD_SORT_FIELD_LABELS[field]}
                  </option>
                ))}
              </SettingsSelect>
              <SettingsSelect
                aria-label="Child threads sort direction"
                value={draft.childSortDirection}
                onChange={(event) =>
                  update(
                    "childSortDirection",
                    event.target.value as ChildThreadSortDirection,
                  )
                }
                className="w-32"
              >
                {CHILD_THREAD_SORT_DIRECTIONS.map((direction) => (
                  <option key={direction} value={direction}>
                    {CHILD_SORT_DIRECTION_LABELS[direction]}
                  </option>
                ))}
              </SettingsSelect>
            </div>
          }
        />
        <SettingRow
          title="Icon"
          description="With provider icons, a parent's badge shows each agent once."
          control={
            <SettingsSelect
              aria-label="Child thread icon"
              value={draft.childIconStyle}
              onChange={(event) =>
                update(
                  "childIconStyle",
                  event.target.value as ChildThreadIconStyle,
                )
              }
              className="w-36"
            >
              {CHILD_THREAD_ICON_STYLES.map((style) => (
                <option key={style} value={style}>
                  {CHILD_ICON_STYLE_LABELS[style]}
                </option>
              ))}
            </SettingsSelect>
          }
        />
      </SettingsSection>

      <SettingsSection title="Appearance" status={statusFor("Appearance")}>
        <SettingRow
          title="Project colors"
          description="Color project names and add a stripe to each row, or one continuous stripe for a project group. Choose each project's color below."
          control={<Switch label="Project colors" checked={draft.projectColorsEnabled} onChange={(checked) => update("projectColorsEnabled", checked)} />}
        />
      </SettingsSection>

      <ProjectSettings />
      <ArchiveSettings />

      <SettingsSection title="This device" status={statusFor("This device")}>
        <PortLinkSettings
          onSaved={() => setSaveFeedback({ section: "This device", status: "saved" })}
        />
      </SettingsSection>

      <SettingsSection title="Experimental" status={statusFor("Experimental")}>
        <SettingRow
          title="Compact working threads"
          description="Show a working thread as one line with a small status icon and its run time. It stays that way while its child threads or background agents run, and becomes a full card when all of it is done, or when it fails or needs you."
          control={
            <Switch
              label="Compact working threads"
              checked={draft.compactWorkingThreads}
              onChange={(checked) => update("compactWorkingThreads", checked)}
            />
          }
        />
        <SettingRow
          title="Working shelf"
          description="Move a thread that is working, or has work running under it, out of Active into its own shelf below, shown as one line like the other shelves. It returns to its place in Active when all of it is done, or when it fails or needs you. Pinned threads stay pinned."
          control={
            <Switch
              label="Working shelf"
              checked={draft.workingShelf}
              onChange={(checked) => update("workingShelf", checked)}
            />
          }
        />
        <SettingRow
          title="Dock shelves to the bottom"
          description="Keep every shelf below Active at the bottom of the sidebar, below the space Pinned and Active leave free. An open shelf that needs more room extends the list, and everything scrolls together."
          control={
            <Switch
              label="Dock shelves to the bottom"
              checked={draft.dockShelves}
              onChange={(checked) => update("dockShelves", checked)}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <code className="rounded bg-muted px-1 py-px font-mono text-2xs text-foreground/80">
      {children}
    </code>
  );
}
