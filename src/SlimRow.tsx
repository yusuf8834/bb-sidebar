import { useState } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";
import { RowContextMenu } from "./RowContextMenu";
import { STATUS_SLOT_CLASS, StatusOrTime } from "./StatusSlot";
import { threadDisplayTitle } from "./inbox";
import { snoozeWakeLabel } from "./lifecycle";
import type { ConfiguredSnoozePreset } from "./lifecycle";
import { InlineThreadTitle } from "./InlineThreadTitle";

/**
 * A parked thread: one line instead of a card. Density comes from the user
 * actually parking work, never from the sidebar guessing what still matters.
 *
 * Same structure as the card — a full-bleed anchor under the restore button,
 * because a `<button>` inside an `<a>` is invalid interactive nesting.
 */
export function SlimRow({
  thread,
  isActive,
  shelf,
  wakeAt,
  now,
  snoozePresets,
  onNavigate,
  onRestore,
  onSnooze,
}: {
  thread: PluginSidebarThread;
  isActive: boolean;
  shelf: "snoozed" | "settled";
  wakeAt: number | null;
  now: number;
  snoozePresets: readonly ConfiguredSnoozePreset[];
  onNavigate: () => void;
  onRestore: () => void;
  onSnooze: (snoozedUntil: number) => void;
}) {
  const actions = useSidebarThreadActions();
  const title = threadDisplayTitle(thread);
  const [isRenaming, setIsRenaming] = useState(false);

  return (
    <RowContextMenu
      thread={thread}
      canSnooze={shelf === "settled"}
      snoozePresets={snoozePresets}
      onSnooze={onSnooze}
      onWake={shelf === "snoozed" ? onRestore : undefined}
      onUnsettle={shelf === "settled" ? onRestore : undefined}
      onRename={() => setIsRenaming(true)}
    >
      <li className="list-none">
        <div
          className={cn(
            "group/slim relative flex h-8 items-center gap-2 rounded-md px-2.5 text-xs",
            isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
          )}
        >
          <a
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            href="#"
            aria-label={title}
            onClick={(event) => {
              event.preventDefault();
              if (isRenaming || event.detail > 1) return;
              actions.open(thread.id, {
                split: event.metaKey || event.ctrlKey,
              });
              onNavigate();
            }}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsRenaming(true);
            }}
            className="absolute inset-0 cursor-pointer rounded-md"
          />
          <span
            className={cn(
              "pointer-events-none relative min-w-0 flex-1 truncate",
              isRenaming && "pointer-events-auto",
              isActive ? "text-foreground" : "text-muted-foreground/70",
              "group-hover/slim:text-foreground",
            )}
          >
            <InlineThreadTitle
              thread={thread}
              editing={isRenaming}
              onEditingChange={setIsRenaming}
            />
          </span>
          {/* The same slot as a card, so a shelf keeps the card's column. A
              snoozed row spends it on the wake time: when the thread comes
              BACK is that shelf's whole question, and it outranks an age the
              user has already decided to ignore.

              The restore button shares this one cell instead of following it.
              A button of its own would sit between the age and the row's edge
              and push the whole column off the card's, which is the one thing
              the fixed slot exists to prevent. */}
          <span
            className={cn(
              STATUS_SLOT_CLASS,
              "pointer-events-none relative tabular-nums text-2xs text-muted-foreground/60",
            )}
          >
            <span className="flex items-center group-hover/slim:opacity-0">
              {shelf === "snoozed" && wakeAt !== null ? (
                snoozeWakeLabel(wakeAt, now)
              ) : (
                <StatusOrTime thread={thread} now={now} />
              )}
            </span>
            <button
              type="button"
              aria-label={
                shelf === "snoozed" ? "Wake thread now" : "Un-settle thread"
              }
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRestore();
              }}
              // Pulled right by its own padding, so the icon — not the hit
              // area — lands on the column.
              className="pointer-events-auto absolute -right-0.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/slim:opacity-100"
            >
              <Icon
                name={shelf === "snoozed" ? "Clock" : "ArrowTurnBackward"}
                className="size-3.5"
              />
            </button>
          </span>
        </div>
      </li>
    </RowContextMenu>
  );
}
