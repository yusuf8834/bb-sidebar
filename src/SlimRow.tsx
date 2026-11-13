import { memo, useId, useState } from "react";
import { useSidebarThreadShortcut, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { Tooltip } from "./components/Tooltip";
import { ChildThreadBadge, ChildThreadList, collapsedChildThreads } from "./ChildThreadList";
import { CompactRow } from "./CompactRow";
import { RowContextMenu } from "./RowContextMenu";
import { StatusOrTime, useWorkingForDisplay } from "./StatusSlot";
import { useThreadLimit } from "./RateLimits";
import { threadDisplayTitle } from "./inbox";
import { snoozeWakeLabel } from "./lifecycle";
import { useProjectColor } from "./ProjectColors";
import { OpenPortsIndicator } from "./OpenPorts";
import { ShortcutHint } from "./bb-sdk";
import { rowKeyshortcuts } from "./lib/keyshortcuts";
import { useInboxActivity, useInboxEnvironment, useInboxActions } from "./InboxContext";
import { useRowStatusRuns } from "./useLifecycle";
import { projectIconUrl as iconUrl } from "./project-icons";

/**
 * A parked, snoozed, or settled thread: one line instead of a card, with its
 * children behind the same chip as a compact card. Density comes from the user
 * actually parking work, never from the sidebar guessing what still matters.
 *
 * Same structure as the card — a full-bleed anchor under the restore button,
 * because a `<button>` inside an `<a>` is invalid interactive nesting.
 */
export const SlimRow = memo(function SlimRow({
  thread,
  isActive,
  shelf,
  parkedAt,
  wakeAt,
  now,
  childrenExpanded,
}: {
  thread: PluginSidebarThread;
  isActive: boolean;
  shelf: "parked" | "snoozed" | "settled";
  parkedAt?: number | null;
  wakeAt: number | null;
  now: number;
  childrenExpanded: boolean;
}) {
  const { projectNameById, projectIconRevision, snoozePresets, lifecycle, childrenByParentId } = useInboxEnvironment();
  const { onNavigate, parkThread, settleThread, snoozeThread, toggleChildExpansion } = useInboxActions();
  const { activeThreadId } = useInboxActivity();
  const childThreads = childrenByParentId.get(thread.id) ?? [];
  const childListId = useId();
  const isWorking = useWorkingForDisplay();
  // Shelved rows stay one line: children show only when expanded, or on the
  // way to the open thread, never because one needs attention.
  const showChildren =
    childThreads.length > 0 &&
    (childrenExpanded ||
      collapsedChildThreads(childThreads, childrenByParentId, activeThreadId, false, isWorking).length > 0);
  // Another plugin's running status keeps the thread where it is.
  const canShelve = !useRowStatusRuns(thread.id);
  const projectName = projectNameById.get(thread.projectId) ?? null;
  const projectIconUrl = iconUrl(thread.projectId, projectIconRevision);
  const onPark = () => parkThread(thread);
  const onSettle = () => settleThread(thread);
  const onSnooze = (until: number) => snoozeThread(thread, until);
  const onRestore = () =>
    shelf === "parked"
      ? void lifecycle.resume(thread.id)
      : shelf === "snoozed"
        ? void lifecycle.unsnooze(thread.id)
        : void lifecycle.unsettle(thread.id);
  const projectColor = useProjectColor(thread.projectId);
  const shortcut = useSidebarThreadShortcut(thread.id);
  const title = threadDisplayTitle(thread);
  const rowLabel = projectName ? `${projectName} · ${title}` : title;
  const [isRenaming, setIsRenaming] = useState(false);
  const limit = useThreadLimit(thread);

  return (
    <RowContextMenu
      thread={thread}
      onPark={canShelve && shelf !== "parked" ? onPark : undefined}
      onResume={shelf === "parked" ? onRestore : undefined}
      onSettle={canShelve && shelf !== "settled" ? onSettle : undefined}
      canSnooze={canShelve && shelf !== "snoozed"}
      snoozePresets={snoozePresets}
      onSnooze={onSnooze}
      onWake={shelf === "snoozed" ? onRestore : undefined}
      onUnsettle={shelf === "settled" ? onRestore : undefined}
      onRename={() => setIsRenaming(true)}
    >
      <li className="list-none">
        <CompactRow
          thread={thread}
          tone="muted"
          projectName={projectName}
          projectIconUrl={projectIconUrl}
          projectColor={projectColor}
          label={rowLabel}
          isActive={isActive}
          isRenaming={isRenaming}
          onRenamingChange={setIsRenaming}
          linkProps={{ "aria-keyshortcuts": rowKeyshortcuts(shortcut?.ariaKeyshortcuts, false) }}
          onOpen={onNavigate}
          trailing={
            <>
              <OpenPortsIndicator thread={thread} />
              {childThreads.length > 0 ? (
                // Positioned, so the chip sits above the row's full-bleed link.
                <span className="pointer-events-none relative flex shrink-0 items-center">
                  <ChildThreadBadge
                    threads={childThreads}
                    childrenByParent={childrenByParentId}
                    expanded={childrenExpanded}
                    controls={childListId}
                    onToggle={() => toggleChildExpansion(thread.id)}
                  />
                </span>
              ) : null}
              {/* Size to the label so the port icon stays beside it. Keep enough
              room for the restore button, which replaces the label on hover.
              On touch devices, show both side by side. */}
              {shortcut ? (
                <ShortcutHint shortcut={shortcut} />
              ) : limit ? (
                <StatusOrTime thread={thread} now={now} />
              ) : (
                <span className="pointer-events-none relative flex min-w-5 shrink-0 items-center justify-end tabular-nums text-2xs text-muted-foreground/60 [@media(hover:none)]:gap-2">
                  <span className="flex items-center transition-opacity duration-150 ease-out [@media(hover:hover)]:group-hover/slim:opacity-0 motion-reduce:transition-none">
                    {shelf === "parked" && parkedAt != null ? (
                      `Waiting ${Math.max(0, Math.floor((now - parkedAt) / 86_400_000))}d`
                    ) : shelf === "snoozed" && wakeAt !== null ? (
                      snoozeWakeLabel(wakeAt, now)
                    ) : (
                      <StatusOrTime thread={thread} now={now} />
                    )}
                  </span>
                  <Tooltip
                    label={
                      shelf === "parked"
                        ? "Resume thread"
                        : shelf === "snoozed"
                          ? "Wake thread now"
                          : "Un-settle thread"
                    }
                  >
                    <button
                      type="button"
                      aria-label={
                        shelf === "parked"
                          ? "Resume thread"
                          : shelf === "snoozed"
                            ? "Wake thread now"
                            : "Un-settle thread"
                      }
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onRestore();
                      }}
                      // Pulled right by its own padding, so the icon — not the hit
                      // area — lands on the column.
                      className="pointer-events-auto absolute -right-0.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out hover:text-foreground focus-visible:opacity-100 group-hover/slim:opacity-100 [@media(hover:none)]:static [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100 motion-reduce:transition-none"
                    >
                      <Icon name={shelf === "snoozed" ? "Clock" : "ArrowTurnBackward"} className="size-3.5" />
                    </button>
                  </Tooltip>
                </span>
              )}
            </>
          }
        />
        {showChildren ? (
          <ChildThreadList
            id={childListId}
            threads={childThreads}
            expanded={childrenExpanded}
            showRunningChildrenWhenCollapsed={false}
            parentProjectId={thread.projectId}
          />
        ) : null}
      </li>
    </RowContextMenu>
  );
});
