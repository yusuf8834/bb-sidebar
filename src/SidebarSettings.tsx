import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { errorDetail, toast } from "./lib/toast";
import type { bbSidebarRpcContract } from "./contract";
import { SIDEBAR_SETTINGS_CHANNEL } from "./realtime-channels";
import {
  cachedSidebarSettings,
  cacheSidebarSettings,
  DEFAULT_SIDEBAR_SETTINGS,
  type SidebarSettingsValues,
} from "./sidebar-settings";
import { SidebarLayoutSettings } from "./SidebarLayoutSettings";
import { ProjectAppearanceSection } from "./ProjectAppearanceSection";
import { ThreadBehaviorSettings } from "./ThreadBehaviorSettings";
import { ChildThreadSettings } from "./ChildThreadSettings";
import { DeviceSettings } from "./DeviceSettings";
import { ProjectManagement } from "./ProjectManagement";
import { configuredSnoozePresetError, parseConfiguredSnoozePresets } from "./lifecycle";
import { isValidInactiveAfterHours } from "./inactive";
import { isValidAutoSettleAfterDays } from "./auto-settle";
import type { SaveStatus } from "./settings-ui";

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
  threadDisplay: "Sidebar layout",
  compactProjectIconOnly: "Sidebar layout",
  keepPinnedThreadsFull: "Sidebar layout",
  keepWokeThreadsFull: "Sidebar layout",
  compactWorkingThreads: "Sidebar layout",
  workingShelf: "Sidebar layout",
  dockShelves: "Sidebar layout",
  projectColorsEnabled: "Project appearance",
  projectColorDisplay: "Project appearance",
};

const validDraft = (value: SidebarSettingsValues) =>
  configuredSnoozePresetError(value.snoozePresets) === null &&
  (!value.inactiveThreadsEnabled || isValidInactiveAfterHours(value.inactiveAfterHours)) &&
  (!value.autoSettleInactive || isValidAutoSettleAfterDays(value.autoSettleAfterDays));

/**
 * The plugin's settings page. Every change saves on its own, as bb's own
 * settings do; a value that fails validation shows why and is not sent.
 */
export function SidebarSettings() {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const loadRequestSeq = useRef(0);
  const initialSettings = cachedSidebarSettings(rpc);
  const [saved, setSaved] = useState<SidebarSettingsValues>(initialSettings ?? DEFAULT_SIDEBAR_SETTINGS);
  const [draft, setDraft] = useState<SidebarSettingsValues>(initialSettings ?? DEFAULT_SIDEBAR_SETTINGS);
  const savedRef = useRef(saved);
  const draftRef = useRef(draft);
  savedRef.current = saved;
  draftRef.current = draft;
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const dirtyFields = useRef(new Map<keyof SidebarSettingsValues, number>());
  const editVersion = useRef(0);
  const refreshAfterSave = useRef(false);
  const mergeUnedited = (incoming: SidebarSettingsValues) => {
    const local = Object.fromEntries([...dirtyFields.current.keys()].map((key) => [key, draftRef.current[key]]));
    return { ...incoming, ...local };
  };
  const [loading, setLoading] = useState(initialSettings === null);
  const changedSectionRef = useRef<string | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<{
    section: string;
    status: SaveStatus;
  } | null>(null);
  const statusFor = (section: string) => (saveFeedback?.section === section ? saveFeedback.status : undefined);

  useEffect(() => {
    if (saveFeedback?.status !== "saved") return;
    const timer = setTimeout(
      () => setSaveFeedback((current) => (current === saveFeedback ? null : current)),
      SAVED_VISIBLE_MS,
    );
    return () => clearTimeout(timer);
  }, [saveFeedback]);

  const load = useCallback(async () => {
    if (savingRef.current) {
      refreshAfterSave.current = true;
      return;
    }
    const seq = ++loadRequestSeq.current;
    try {
      const result = await rpc.call("getSidebarSettings", {});
      if (seq !== loadRequestSeq.current) return;
      const cached = cacheSidebarSettings(rpc, result);
      savedRef.current = cached;
      draftRef.current = mergeUnedited(cached);
      setSaved(cached);
      setDraft(draftRef.current);
    } catch (error) {
      if (seq !== loadRequestSeq.current) return;
      toast.error("Could not load sidebar settings", { description: errorDetail(error) });
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

  const dirty = dirtyFields.current.size > 0;
  const inactiveHoursValid = isValidInactiveAfterHours(draft.inactiveAfterHours);
  const autoSettleDaysValid = isValidAutoSettleAfterDays(draft.autoSettleAfterDays);
  const snoozePresetsError = configuredSnoozePresetError(draft.snoozePresets);
  const hasValidationError = !validDraft(draft);
  const snoozePreview = snoozePresetsError
    ? []
    : parseConfiguredSnoozePresets(draft.snoozePresets).map((preset) => preset.label);
  const update = <Key extends keyof SidebarSettingsValues>(key: Key, value: SidebarSettingsValues[Key]) => {
    changedSectionRef.current = SECTION_BY_SETTING[key];
    dirtyFields.current.set(key, ++editVersion.current);
    setDraft((current) => {
      const next = { ...current, [key]: value };
      draftRef.current = next;
      return next;
    });
  };

  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      // Mounted edits keep the ordinary debounce after each reply. Once the
      // page unmounts, drain queued edits here: its effects can no longer save them.
      // Patch only dirty fields so other clients' edits survive.
      while (dirtyFields.current.size && validDraft(draftRef.current)) {
        const sentVersions = new Map(dirtyFields.current);
        const sent = { ...draftRef.current };
        if (!isValidInactiveAfterHours(sent.inactiveAfterHours))
          sent.inactiveAfterHours = DEFAULT_SIDEBAR_SETTINGS.inactiveAfterHours;
        if (!isValidAutoSettleAfterDays(sent.autoSettleAfterDays))
          sent.autoSettleAfterDays = DEFAULT_SIDEBAR_SETTINGS.autoSettleAfterDays;
        const patch = Object.fromEntries([...sentVersions.keys()].map((key) => [key, sent[key]]));
        loadRequestSeq.current += 1;
        const section = changedSectionRef.current;
        if (section && mounted.current) setSaveFeedback({ section, status: "saving" });
        try {
          const result = await rpc.call("updateSidebarSettings", patch);
          const cached = cacheSidebarSettings(rpc, result);
          for (const [key, version] of sentVersions) {
            if (dirtyFields.current.get(key) === version) dirtyFields.current.delete(key);
          }
          savedRef.current = cached;
          draftRef.current = mergeUnedited(cached);
          if (mounted.current) {
            setSaved(cached);
            setDraft(draftRef.current);
            if (section) setSaveFeedback({ section, status: "saved" });
            break;
          }
        } catch (error) {
          if (section && mounted.current) setSaveFeedback({ section, status: "error" });
          toast.error("Could not save sidebar settings", { description: errorDetail(error) });
          break;
        }
      }
    } finally {
      savingRef.current = false;
      if (refreshAfterSave.current && mounted.current) {
        refreshAfterSave.current = false;
        void load();
      }
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
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadRequestSeq.current += 1;
      if (pendingSaveRef.current) void saveRef.current();
    };
  }, []);

  if (loading) {
    return (
      <div className="max-w-3xl rounded-lg border border-border px-4 py-8 text-center text-sm text-muted-foreground">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-8 pb-4">
      <SidebarLayoutSettings
        draft={draft}
        update={update}
        status={statusFor("Sidebar layout")}
        inactiveHoursValid={inactiveHoursValid}
      />

      <ProjectAppearanceSection draft={draft} update={update} status={statusFor("Project appearance")} />

      <ThreadBehaviorSettings
        draft={draft}
        update={update}
        status={statusFor("Thread behavior")}
        autoSettleDaysValid={autoSettleDaysValid}
        snoozePresetsError={snoozePresetsError}
        snoozePreview={snoozePreview}
      />

      <ChildThreadSettings draft={draft} update={update} status={statusFor("Child threads")} />

      <DeviceSettings
        status={statusFor("This device")}
        onSaved={() => setSaveFeedback({ section: "This device", status: "saved" })}
      />

      <ProjectManagement />
    </div>
  );
}
