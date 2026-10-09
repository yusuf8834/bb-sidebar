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
  PROJECT_COLOR_DISPLAYS,
  SIDEBAR_SETTINGS_CHANNEL,
  type ChildThreadIconStyle,
  type ChildThreadSortDirection,
  type ChildThreadSortField,
  type SidebarSettingsValues,
  type ProjectColorDisplay,
} from "./sidebar-settings";
import { ProjectAppearanceSettings } from "./ProjectSettings";
import { ProjectManagement } from "./ProjectManagement";
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
  SettingsGroup,
  SettingsNavigation,
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

const PROJECT_COLOR_DISPLAY_LABELS: Record<ProjectColorDisplay, string> = {
  all: "Full and collapsed mode",
  full: "Full mode only",
  grouped: "Grouped projects only",
};

const SETTINGS_SECTIONS = [
  "Sidebar layout", "Project appearance", "Thread behavior", "Child threads",
  "This device", "Project management",
] as const;

/** Long enough to finish typing a shortcut, short enough to feel instant. */
const SAVE_DELAY_MS = 500;
/** How long "Saved" stays beside a section before it fades. */
const SAVED_VISIBLE_MS = 2_000;

/** The section each setting lives in, so its save feedback shows there. */
const SECTION_BY_SETTING: Record<keyof SidebarSettingsValues, string> = {
  inactiveThreadsEnabled: "Sidebar layout",
  inactiveAfterHours: "Sidebar layout",
  snoozePresets: "Thread behavior",
  autoSettleInactive: "Thread behavior",
  autoSettleAfterDays: "Thread behavior",
  autoSettleOnMerge: "Thread behavior",
  showRunningChildrenWhenCollapsed: "Child threads",
  childSortField: "Child threads",
  childSortDirection: "Child threads",
  childIconStyle: "Child threads",
  compactWorkingThreads: "Sidebar layout",
  workingShelf: "Sidebar layout",
  dockShelves: "Sidebar layout",
  projectColorsEnabled: "Project appearance",
  projectColorDisplay: "Project appearance",
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
      <SettingsNavigation sections={SETTINGS_SECTIONS} />
      <SettingsSection title="Sidebar layout" status={statusFor("Sidebar layout")}>
        <SettingRow
          title="Compact working threads"
          experimental
          description="Use one line while a thread or its child agents are working. Expand it when work finishes, fails, or needs you."
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
          experimental
          description="Keep working threads in their own shelf. They return to Active when work finishes, fails, or needs you. Pinned threads stay pinned."
          control={
            <Switch
              label="Working shelf"
              checked={draft.workingShelf}
              onChange={(checked) => update("workingShelf", checked)}
            />
          }
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

        <SettingRow
          title="Dock shelves to the bottom"
          experimental
          description="Keep shelves below Active at the bottom of the sidebar. Expanded shelves scroll with the thread list."
          control={
            <Switch
              label="Dock shelves to the bottom"
              checked={draft.dockShelves}
              onChange={(checked) => update("dockShelves", checked)}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Project appearance" status={statusFor("Project appearance")}>
        <SettingRow
          title="Project colors"
          description="Color project names in every mode. Choose where their stripes appear below."
          control={<Switch label="Project colors" checked={draft.projectColorsEnabled} onChange={(checked) => update("projectColorsEnabled", checked)} />}
        >
          {draft.projectColorsEnabled ? (
            <div className="border-l-2 border-border">
              <SettingRow
                title="Show stripes in"
                description="Full mode includes cards and expanded groups. Grouped projects means combined blocks when sorting by Project."
                control={
                  <SettingsSelect
                    aria-label="Show project stripes in"
                    value={draft.projectColorDisplay}
                    onChange={(event) => update("projectColorDisplay", event.target.value as ProjectColorDisplay)}
                    className="w-52"
                  >
                    {PROJECT_COLOR_DISPLAYS.map((display) => (
                      <option key={display} value={display}>{PROJECT_COLOR_DISPLAY_LABELS[display]}</option>
                    ))}
                  </SettingsSelect>
                }
              />
            </div>
          ) : null}
        </SettingRow>
        <SettingsGroup title="Customize a project">
          <ProjectAppearanceSettings />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Thread behavior" status={statusFor("Thread behavior")}>
        <SettingsGroup title="Snooze">
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
        </SettingsGroup>
        <SettingsGroup title="Automatic settle">
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
        </SettingsGroup>
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
            <div className="flex flex-wrap items-center gap-2">
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

      <SettingsSection title="This device" status={statusFor("This device")}>
        <PortLinkSettings
          onSaved={() => setSaveFeedback({ section: "This device", status: "saved" })}
        />
      </SettingsSection>

      <ProjectManagement />
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
