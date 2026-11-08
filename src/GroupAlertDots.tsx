import { childStatusIndicator } from "./child-status";
import type { GroupAlert } from "./inbox-layout";
import { statusToneClass } from "./StatusSlot";
import { cn } from "./lib/utils";

/** The alerts as label text, e.g. ", 1 failed, 2 need you". */
export function groupAlertPhrase(alerts: readonly GroupAlert[]): string {
  const words = { failed: "failed", "needs-you": "need you", done: "done" } as const;
  return alerts.map((alert) => `, ${alert.count} ${words[alert.kind]}`).join("");
}

/** One dot per kind of news a collapsed group hides. */
export function GroupAlertDots({ alerts }: { alerts: readonly GroupAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <span
      data-group-alerts=""
      title={groupAlertPhrase(alerts).slice(2)}
      aria-hidden
      className="flex shrink-0 items-center gap-0.5"
    >
      {alerts.map((alert) => (
        <span
          key={alert.kind}
          data-group-alert={alert.kind}
          className={cn("size-1.5 rounded-full bg-current", statusToneClass(childStatusIndicator(alert.kind)))}
        />
      ))}
    </span>
  );
}
