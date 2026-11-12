import {
  createContext,
  useContext,
  useMemo,
  type Context,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { useSidebarThreads } from "./bb-sdk";
import type { SidebarProvider } from "./ProviderGlyph";
import { DEFAULT_SIDEBAR_SETTINGS, type SidebarSettingsValues } from "./sidebar-settings";
import type { ConfiguredSnoozePreset } from "./lifecycle";
import type { LifecycleApi } from "./useLifecycle";
import type { ShelfExpansionState } from "./ThreadInboxView";
import { ListAnimationContext, type ListAnimationController } from "./useListMotion";
import { ProjectColorsProvider } from "./ProjectColors";
import { WorkingSinceContext } from "./useWorkingSince";
import type { WorkingSince } from "./working-since";
import { ChildThreadDisplayContext, type ChildThreadDisplay } from "./ChildThreadDisplay";
import { OpenPortsProvider, type PortScanScope } from "./OpenPorts";
import type { ActiveSortMode } from "./inbox-layout";
import type { useRenamingShelfLocks } from "./useRenamingShelfLocks";

interface InboxContextInputs {
  providerById: ReadonlyMap<string, SidebarProvider>;
  projectNameById: ReadonlyMap<string, string>;
  projectIconRevision: number;
  projects: ReturnType<typeof useSidebarThreads>["projects"];
  sidebarSettings: SidebarSettingsValues | null;
  snoozePresets: readonly ConfiguredSnoozePreset[];
  lifecycle: LifecycleApi;
  childrenByParentId: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  activeThreadId: string | null;
  now: number;
  onNavigate: () => void;
  parkThread: (thread: PluginSidebarThread) => void;
  settleThread: (thread: PluginSidebarThread) => void;
  snoozeThread: (thread: PluginSidebarThread, until: number) => void;
  toggleChildExpansion: (threadId: string) => void;
  setRenamingShelfLocks: ReturnType<typeof useRenamingShelfLocks>[1];
  setScope: Dispatch<SetStateAction<string[]>>;
  setExpandedShelves: Dispatch<SetStateAction<ShelfExpansionState>>;
  setActiveSortMode: Dispatch<SetStateAction<ActiveSortMode>>;
  setSettledLimit: Dispatch<SetStateAction<number>>;
  toggleProjectCollapse: (projectId: string) => void;
}

/** Shared inbox values have separate identities for data, handlers, and activity. */
export function useInboxContextValues({
  providerById,
  projectNameById,
  projectIconRevision,
  projects,
  sidebarSettings,
  snoozePresets,
  lifecycle,
  childrenByParentId,
  activeThreadId,
  now,
  onNavigate,
  parkThread,
  settleThread,
  snoozeThread,
  toggleChildExpansion,
  setRenamingShelfLocks,
  setScope,
  setExpandedShelves,
  setActiveSortMode,
  setSettledLimit,
  toggleProjectCollapse,
}: InboxContextInputs) {
  const environment = useMemo(
    () => ({
      providerById,
      projectNameById,
      projectIconRevision,
      projects,
      sidebarSettings,
      snoozePresets,
      lifecycle,
      childrenByParentId,
    }),
    [
      providerById,
      projectNameById,
      projectIconRevision,
      projects,
      sidebarSettings,
      snoozePresets,
      lifecycle,
      childrenByParentId,
    ],
  );
  const actions = useMemo(
    () => ({
      onNavigate,
      parkThread,
      settleThread,
      snoozeThread,
      toggleChildExpansion,
      setRenamingShelfLocks,
      setScope,
      setExpandedShelves,
      setActiveSortMode,
      setSettledLimit,
      toggleProjectCollapse,
      acknowledgeWake: (threadId: string) => void lifecycle.acknowledgeWake(threadId),
    }),
    [
      onNavigate,
      parkThread,
      settleThread,
      snoozeThread,
      toggleChildExpansion,
      setRenamingShelfLocks,
      setScope,
      setExpandedShelves,
      setActiveSortMode,
      setSettledLimit,
      toggleProjectCollapse,
      lifecycle,
    ],
  );
  const activity = useMemo(() => ({ activeThreadId, now }), [activeThreadId, now]);
  return { environment, actions, activity };
}

type InboxValues = ReturnType<typeof useInboxContextValues>;
const InboxEnvironmentContext = createContext<InboxValues["environment"] | null>(null);
const InboxActionsContext = createContext<InboxValues["actions"] | null>(null);
const InboxActivityContext = createContext<InboxValues["activity"] | null>(null);

export function InboxProvider({
  value,
  listAnimationController,
  workingSince,
  childDisplay,
  portScope,
  children,
}: {
  value: InboxValues;
  listAnimationController: ListAnimationController;
  workingSince: WorkingSince;
  childDisplay: ChildThreadDisplay;
  portScope: PortScanScope;
  children: ReactNode;
}) {
  const { sidebarSettings, projects } = value.environment;
  const projectIds = useMemo(() => projects.map((project) => project.id), [projects]);
  return (
    <ListAnimationContext.Provider value={listAnimationController}>
      <ProjectColorsProvider
        enabled={sidebarSettings?.projectColorsEnabled === true}
        display={sidebarSettings?.projectColorDisplay ?? DEFAULT_SIDEBAR_SETTINGS.projectColorDisplay}
        projectIds={projectIds}
      >
        <WorkingSinceContext.Provider value={workingSince}>
          <ChildThreadDisplayContext.Provider value={childDisplay}>
            <OpenPortsProvider scope={portScope}>
              <InboxEnvironmentContext.Provider value={value.environment}>
                <InboxActionsContext.Provider value={value.actions}>
                  <InboxActivityContext.Provider value={value.activity}>{children}</InboxActivityContext.Provider>
                </InboxActionsContext.Provider>
              </InboxEnvironmentContext.Provider>
            </OpenPortsProvider>
          </ChildThreadDisplayContext.Provider>
        </WorkingSinceContext.Provider>
      </ProjectColorsProvider>
    </ListAnimationContext.Provider>
  );
}

function requireInboxContext<T>(value: T | null): T {
  if (value === null) throw new Error("Inbox consumers must be inside InboxProvider");
  return value;
}

function useRequiredContext<T>(context: Context<T | null>): T {
  return requireInboxContext(useContext(context));
}

export function useInboxEnvironment() {
  return useRequiredContext(InboxEnvironmentContext);
}

export function useInboxActions() {
  return useRequiredContext(InboxActionsContext);
}

export function useInboxActivity() {
  return useRequiredContext(InboxActivityContext);
}

type ExplicitChildListInputs = {
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  /** Runs on a click that bb's link routing opens; it does not navigate. */
  onThreadOpen: () => void;
};

export type InboxChildListInputs = {
  now?: number;
  activeThreadId?: string | null;
} & (({ variant: "header" } & ExplicitChildListInputs) | ({ variant: "sidebar" } & Partial<ExplicitChildListInputs>));

/** Header popovers and standalone lists keep their explicit inputs. */
export function useInboxChildList<T extends InboxChildListInputs>(props: T) {
  const environment = useContext(InboxEnvironmentContext);
  const actions = useContext(InboxActionsContext);
  const activity = useContext(InboxActivityContext);
  const sidebar = props.variant === "sidebar";
  const childrenByParent = props.childrenByParent ?? requireInboxContext(environment).childrenByParentId;
  const onThreadOpen = props.onThreadOpen ?? requireInboxContext(actions).onNavigate;
  return {
    ...props,
    childrenByParent,
    onThreadOpen,
    now: props.now ?? (sidebar ? activity?.now : undefined),
    activeThreadId:
      props.activeThreadId !== undefined ? props.activeThreadId : sidebar ? activity?.activeThreadId : undefined,
  };
}
