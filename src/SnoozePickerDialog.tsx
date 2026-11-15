import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { primaryButtonClass, secondaryButtonClass } from "./settings-ui";
import { Calendar } from "./components/Calendar";
import { usePortalScopeProps } from "./lib/portal-scope";
import { combineSnoozeDateTime, defaultPickedSnooze, formatPickedSnooze, MAX_SNOOZE_MS } from "./lifecycle";

/**
 * "Pick date & time" for snooze, the custom entry Gmail, Slack, and Linear
 * put under their shortcuts: a month calendar and a native time field, with
 * the resulting wake time spelled out before it is committed.
 */
export function SnoozePickerDialog({
  open,
  onOpenChange,
  onSnooze,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (snoozedUntil: number) => void;
}) {
  const portalScope = usePortalScopeProps();
  const contentRef = useRef<HTMLDivElement>(null);
  const [date, setDate] = useState(() => defaultPickedSnooze().date);
  const [time, setTime] = useState(() => defaultPickedSnooze().time);
  // Re-read the clock while open so a dialog left up past the chosen minute
  // stops offering it.
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!open) return;
    const initial = defaultPickedSnooze();
    setDate(initial.date);
    setTime(initial.time);
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, [open]);

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const lastDay = new Date(now.getTime() + MAX_SNOOZE_MS);
  const wake = combineSnoozeDateTime(date, time);
  const problem =
    wake === null
      ? "Enter a time."
      : wake <= now.getTime()
        ? "Pick a time in the future."
        : wake > now.getTime() + MAX_SNOOZE_MS
          ? "Snooze for at most a year."
          : null;

  const submit = () => {
    // Check against the clock at submit, not the last tick.
    const selected = combineSnoozeDateTime(date, time);
    if (problem || selected === null || selected <= Date.now()) return;
    onSnooze(selected);
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay {...portalScope} className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          {...portalScope}
          ref={contentRef}
          // Start on the selected day, so arrow keys move through the month.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.querySelector<HTMLButtonElement>("[data-selected] button")?.focus();
          }}
          // The dialog renders inside a row; keep its clicks off the row's menu.
          onContextMenu={(event) => event.stopPropagation()}
          className="fixed left-1/2 top-1/2 z-50 box-border w-max max-w-[calc(100%_-_2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-none"
        >
          <Dialog.Title className="text-sm font-semibold leading-5">Snooze until</Dialog.Title>
          <Dialog.Description className="sr-only">
            Choose the day and time this thread comes back to the inbox.
          </Dialog.Description>
          <form
            className="mt-3 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Calendar
              mode="single"
              required
              weekStartsOn={1}
              selected={date}
              onSelect={setDate}
              defaultMonth={date}
              startMonth={today}
              endMonth={lastDay}
              disabled={[{ before: today }, { after: lastDay }]}
            />
            <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              Time
              <input
                type="time"
                required
                value={time}
                onChange={(event) => setTime(event.target.value)}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </label>
            <p
              aria-live="polite"
              className={
                problem ? "text-xs text-[color:var(--bb-sidebar-tone-error)]" : "text-xs text-muted-foreground"
              }
            >
              {problem ?? `Wakes ${formatPickedSnooze(wake!, now)}`}
            </p>
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" className={secondaryButtonClass}>
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" disabled={problem !== null} className={primaryButtonClass}>
                Snooze
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
