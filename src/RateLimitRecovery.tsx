import { useId, useRef, useState } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { useLimitActions, useThreadLimit } from "./RateLimits";
import { limitStatus, limitTime } from "./rate-limit-labels";
import { Popover, PopoverAnchor, PopoverContent } from "./components/Popover";
import { Icon } from "./components/Icon";
import { Tooltip } from "./components/Tooltip";
import { cn } from "./lib/utils";

export function RateLimitRecovery({ thread }: { thread: PluginSidebarThread }) {
  const limit = useThreadLimit(thread);
  const actions = useLimitActions();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  if (!limit || !actions) return null;
  const pending = actions.pending.has(thread.id);
  const held = pending || open;
  // bb's queued retry of the failed turn replaces Continue; the button cancels it first.
  const { retry, scheduled } = limit;
  const queued = retry ?? scheduled;
  const actionLabel = queued
    ? "Cancel"
    : limit.resetsAt === null
      ? "Schedule…"
      : limit.resetsAt > Date.now()
        ? `Continue at ${limitTime(limit.resetsAt, limit.timeZone)}`
        : "Continue now";
  const visibleLabel = pending ? (queued ? "Cancelling…" : "Scheduling…") : actionLabel;
  const accessibleLabel = retry
    ? `Cancel bb's retry for ${thread.displayTitle}`
    : scheduled
      ? `Cancel scheduled Continue for ${thread.displayTitle}`
      : `${visibleLabel} for ${thread.displayTitle}`;
  const hint = retry
    ? `bb retries this turn ${retry.sendAt === null ? "soon" : `at ${limitTime(retry.sendAt, limit.timeZone)}`}. Cancel the retry.${
        scheduled ? ` A Continue is also scheduled for ${limitTime(scheduled.sendAt, limit.timeZone)}.` : ""
      }`
    : scheduled
      ? `Continue scheduled for ${limitTime(scheduled.sendAt, limit.timeZone)}. Cancel the scheduled message.`
      : limit.resetsAt === null
        ? "Provider limit reached. Choose when to continue."
        : limit.resetsAt > Date.now()
          ? `Limit resets at ${limitTime(limit.resetsAt, limit.timeZone)}${limit.timeZone ? ` (${limit.timeZone})` : ""}. Schedule Continue just after the reset.`
          : "The reported reset time has passed. Continue this thread.";
  const schedule = async (sendAt?: number) => {
    if (await actions.schedule(thread.id, sendAt)) setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span
          data-limit-control=""
          className={cn(
            "group/limit pointer-events-auto relative inline-grid h-5 shrink-0 items-center whitespace-nowrap text-2xs font-medium",
            queued?.failed
              ? "text-[color:var(--bb-sidebar-tone-error)]"
              : "text-[color:var(--bb-sidebar-tone-pending)]",
          )}
        >
          <span
            role="status"
            aria-live="polite"
            className={cn(
              "pointer-events-none col-start-1 row-start-1 justify-self-end transition-opacity duration-150 motion-reduce:transition-none",
              "group-hover/card:opacity-0 group-hover/slim:opacity-0 group-hover/child:opacity-0 group-hover/limit:opacity-0 group-focus-within/limit:opacity-0 [@media(hover:none)]:opacity-0",
              held && "opacity-0",
            )}
          >
            {limitStatus(limit)}
          </span>
          <Tooltip label={hint}>
            <button
              ref={button}
              type="button"
              aria-disabled={pending}
              aria-busy={pending}
              aria-label={accessibleLabel}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (pending) return;
                if (queued) void actions.cancel(thread.id, queued.id);
                else if (limit.resetsAt !== null) void schedule();
                else setOpen(true);
              }}
              className={cn(
                "pointer-events-none col-start-1 row-start-1 flex h-5 items-center justify-end gap-1 rounded-sm opacity-0 transition-opacity duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none",
                "group-hover/card:pointer-events-auto group-hover/card:opacity-100 group-hover/slim:pointer-events-auto group-hover/slim:opacity-100 group-hover/child:pointer-events-auto group-hover/child:opacity-100 group-hover/limit:pointer-events-auto group-hover/limit:opacity-100 group-focus-within/limit:pointer-events-auto group-focus-within/limit:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
                held && "pointer-events-auto opacity-100",
              )}
            >
              <Icon
                name={pending ? "Loading" : queued ? "CircleX" : "Clock"}
                className={cn("size-3 shrink-0", pending && "animate-spin motion-reduce:animate-none")}
              />
              <span aria-hidden="true">{visibleLabel}</span>
            </button>
          </Tooltip>
        </span>
      </PopoverAnchor>
      <PopoverContent
        className="w-64 p-3"
        align="end"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          button.current?.focus();
        }}
      >
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const at = new Date(time).getTime();
            if (Number.isFinite(at)) void schedule(at);
          }}
        >
          <label htmlFor={inputId} className="text-xs font-medium">
            Continue at a time on this device
          </label>
          <input
            id={inputId}
            type="datetime-local"
            required
            value={time}
            onChange={(event) => setTime(event.target.value)}
            className="w-full rounded border bg-background p-1 text-xs"
          />
          <button
            type="submit"
            disabled={pending || !time}
            className="rounded-sm text-xs text-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          >
            {pending ? "Scheduling…" : "Schedule Continue"}
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
