import { afterEach, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { renderSlot } from "./test-slot";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { deferred, idleSidebarThreadFields, runtimeStatusFor } from "./test-fixtures";
import type { SidebarProvider } from "./ProviderGlyph";

export const toastMocks = {
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
  dismiss: vi.fn(),
};

export const sonnerMock = () => ({ toast: toastMocks });

export function stubIntersectionObservers() {
  const observers = new Map<Element, TestIntersectionObserver>();
  const instances: TestIntersectionObserver[] = [];
  class TestIntersectionObserver {
    private elements = new Set<Element>();

    constructor(readonly callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
      instances.push(this);
    }

    observe(element: Element) {
      this.elements.add(element);
      observers.set(element, this);
    }

    unobserve(element: Element) {
      this.elements.delete(element);
      if (observers.get(element) === this) observers.delete(element);
    }

    disconnect = vi.fn(() => {
      for (const element of this.elements) this.unobserve(element);
    });
  }
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  return {
    observers,
    instances,
    notify(element: Element, isIntersecting: boolean) {
      const observer = observers.get(element);
      if (!observer) throw new Error("The row has no active IntersectionObserver");
      observer.callback([{ target: element, isIntersecting }]);
    },
  };
}

Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});
Object.defineProperty(Document.prototype, "elementFromPoint", {
  configurable: true,
  value: vi.fn(),
});

// Load through the harness so the plugin's `@get-bb/plugin-sdk/app` import binds
// to the test runtime; importing the component directly would bind it to an
// empty runtime first.
import type { RowContextMenu as RowContextMenuType } from "./RowContextMenu";
export let app: Awaited<ReturnType<typeof loadPluginApp>>;
export let inbox: (typeof app.threadLists)[number];
export let sidebarSettings: (typeof app.settingsSections)[number];
let RowContextMenu: typeof RowContextMenuType;

export async function loadInboxApp() {
  // Register cleanup for each calling file, even if this helper is reused.
  afterEach(cleanupInboxTest);
  if (app) return;
  app = await loadPluginApp(() => import("../app"));
  ({ RowContextMenu } = await import("./RowContextMenu"));
  inbox = app.threadLists[0]!;
  sidebarSettings = app.settingsSections[0]!;
}
export function PolicyMenu({
  selected,
  actions = {},
}: {
  selected: PluginSidebarThread;
  actions?: Omit<Parameters<typeof RowContextMenu>[0], "thread" | "children">;
}) {
  return (
    <RowContextMenu thread={selected} {...actions}>
      <button>Policy row</button>
    </RowContextMenu>
  );
}

/** A settle that found no runtime loaded and no terminals to report. */
export const SETTLED_NOTHING = {
  closedTerminals: 0,
  keptTerminals: 0,
  stoppedRuntime: false,
};

export const defaultSidebarSettings = {
  snoozePresets: "30m, 2h, 1d, 1w",
  inactiveThreadsEnabled: true,
  inactiveAfterHours: 6,
  showRunningChildrenWhenCollapsed: true,
  autoSettleInactive: true,
  autoSettleAfterDays: 3,
  autoSettleOnMerge: true,
  childSortField: "created",
  childSortDirection: "ascending",
  childIconStyle: "disc",
  threadDisplay: "full",
  compactProjectIconOnly: false,
  keepPinnedThreadsFull: false,
  keepWokeThreadsFull: false,
  compactWorkingThreads: false,
  workingShelf: false,
  dockShelves: false,
  projectColorsEnabled: false,
  projectColorDisplay: "all",
};

let nextPinnedKey = 0;

export function thread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    ...idleSidebarThreadFields,
    runtimeStatus: runtimeStatusFor(overrides),
    // Confirmed pins carry keys in canonical BB; explicit null models a provisional pin.
    ...(overrides.isPinned ? { pinnedAt: 100, pinSortKey: `U${String(nextPinnedKey++).padStart(6, "0")}U` } : {}),
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
    href: overrides.href ?? `/projects/${overrides.projectId ?? "proj_1"}/threads/${overrides.id ?? "thr_1"}`,
  };
}

function provider(id: string, displayName: string, logoUrl: string | null): SidebarProvider {
  return {
    id,
    pluginId: `provider-${id}`,
    displayName,
    available: true,
    completedTurnDisplay: "collapse",
    maintenance: {
      health: true,
      usage: false,
      installation: true,
    },
    logoUrl,
    capabilities: {
      modelCatalogScope: "workspace",
      permissionModes: ["full"],
      supportsFork: true,
      supportsNativeUserQuestion: false,
      supportsServiceTier: false,
      supportsSessionRewind: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
    },
    composerActions: [],
  };
}

export const defaultProviders = [
  provider("codex", "Codex", "/api/v1/system/providers/codex/logo"),
  provider("claude-code", "Claude Code", "/api/v1/system/providers/claude-code/logo"),
];

export const listProps = {
  activeThreadId: null,
  activeProjectId: null,
  isCompactViewport: false,
  onNavigate: () => {},
  searchQuery: "",
  Original: () => null,
};

/** Top-level row links. Child rows are links too, but bb's shortcuts skip them. */
export function rowLinks(scope: HTMLElement = document.body) {
  return within(scope)
    .getAllByRole("link")
    .filter((link) => link.hasAttribute("data-sidebar-thread-shortcut-target"));
}

export function render(
  threads: PluginSidebarThread[],
  projects = [{ id: "proj_1", name: "bb", isPersonal: false, href: "", settingsHref: "" }],
) {
  return renderSlot(inbox, listProps, {
    sidebarThreads: { status: "ready", threads, projects },
    providers: { status: "ready", providers: defaultProviders },
    // The lifecycle store is the plugin's own backend; an empty one means
    // every thread is active, which is what these list tests are about.
    rpc: { listLifecycle: () => ({ rows: [] }) },
  });
}

/**
 * The card's trailing slot and the two spans it stacks: the status, and the
 * park actions that replace it on a hover device. On touch both stay put, so
 * the tests need each span separately.
 */
export function statusSlotParts(row: HTMLElement, statusText: string) {
  const status = within(row).getByText(statusText);
  const statusWrapper = status.parentElement!;
  const slot = statusWrapper.parentElement!;
  return {
    status,
    statusWrapper,
    slot,
    actions: slot.lastElementChild as HTMLElement,
  };
}

/**
 * Controls nested inside other controls. A `<button>` inside an `<a>` is
 * invalid interactive nesting and breaks keyboard behaviour, so every row that
 * mixes a navigation target with its own buttons must report none.
 */
export function nestedInteractiveControls(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("a a, a button, button a, button button")).map(
    (element) => element.outerHTML,
  );
}

export { deferred };

function cleanupInboxTest() {
  cleanup();
  window.localStorage.clear();
  nextPinnedKey = 0;
  for (const mock of Object.values(toastMocks)) mock.mockReset();
  vi.mocked(document.elementFromPoint).mockReset();
}

type ParkingAction = "settle" | "snooze" | "park";
export const parkingActions: readonly ParkingAction[] = ["settle", "snooze", "park"];

export async function parkFromCard(row: HTMLElement, action: ParkingAction) {
  if (action === "settle") {
    fireEvent.click(within(row).getByRole("button", { name: "Settle thread" }));
  } else {
    fireEvent.keyDown(within(row).getByRole("combobox", { name: "Snooze thread" }), { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("option", {
        name: action === "park" ? "Park thread" : "1 hour",
      }),
    );
  }
}

export async function parkFromMenu(row: HTMLElement, action: ParkingAction) {
  fireEvent.contextMenu(row);
  const menu = await screen.findByRole("menu", { name: "Thread actions" });
  if (action === "snooze") {
    fireEvent.click(within(menu).getByText("Snooze"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "1 hour" }));
  } else {
    fireEvent.click(within(menu).getByText(action === "park" ? "Park thread" : "Settle"));
  }
}
