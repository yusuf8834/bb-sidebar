import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";

export function settingsSectionId(title: string): string {
  return `settings-${title.toLowerCase().replaceAll(" ", "-")}`;
}

export function SettingsNavigation({ sections }: { sections: readonly string[] }) {
  return (
    <nav aria-label="Settings sections" className="flex flex-wrap gap-x-4 gap-y-2 border-b border-border pb-4 text-xs">
      {sections.map((title) => (
        <a
          key={title}
          href={`#${settingsSectionId(title)}`}
          className="rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => {
            const section = document.getElementById(settingsSectionId(title));
            if (!section) return;
            event.preventDefault();
            section.scrollIntoView({ block: "start" });
            section.querySelector("h2")?.focus({ preventScroll: true });
          }}
        >
          {title}
        </a>
      ))}
    </nav>
  );
}

/**
 * The settings page's building blocks, drawn after bb's own settings: a short
 * section title over a bordered card, and undivided rows with the label on
 * the left and the control on the right.
 */
export function SettingsSection({
  title,
  status,
  children,
}: {
  title: string;
  /** Save feedback for the change just made in this section. */
  status?: SaveStatus;
  children: ReactNode;
}) {
  const id = settingsSectionId(title);
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id={`${id}-heading`} tabIndex={-1} className="text-sm font-medium text-foreground focus:outline-none">
          {title}
        </h2>
        <SaveIndicator status={status} />
      </div>
      <div className="rounded-lg border border-border bg-card py-1.5">
        {children}
      </div>
    </section>
  );
}

export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-2 border-t border-border pt-3 first:mt-0 first:border-t-0 first:pt-1">
      <h3 className="px-4 pb-1 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

export type SaveStatus = "saving" | "saved" | "error";

/**
 * "Saving…", then "Saved", beside the section that changed. The last label
 * stays in place while it fades, so the heading row never jumps.
 */
function SaveIndicator({ status }: { status: SaveStatus | undefined }) {
  const [shown, setShown] = useState(status);
  useEffect(() => {
    if (status) setShown(status);
  }, [status]);
  return (
    <span
      role="status"
      className={cn(
        "flex items-center gap-1 text-xs transition-opacity duration-300 motion-reduce:transition-none",
        status ? "opacity-100" : "opacity-0",
        shown === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {shown === "saving" ? (
        <>
          <Icon name="Loading" aria-hidden className="size-3 animate-spin" />
          Saving…
        </>
      ) : shown === "saved" ? (
        <>
          <Icon name="Check" aria-hidden className="size-3.5 text-[color:var(--bb-sidebar-tone-success)]" />
          Saved
        </>
      ) : shown === "error" ? (
        <>
          <Icon name="CircleX" aria-hidden className="size-3.5" />
          Not saved
        </>
      ) : null}
    </span>
  );
}

/**
 * One setting. `control` sits on the right; `children` render below the
 * label at full width, for a dependent value or a larger editor.
 */
export function SettingRow({
  title,
  description,
  control,
  children,
  experimental = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  experimental?: boolean;
}) {
  return (
    <div className="px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            {title}
            {experimental ? <span className="rounded border border-border px-1.5 py-0.5 text-2xs font-normal text-muted-foreground">Experimental</span> : null}
          </p>
          {description ? (
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {control ? <div className="shrink-0">{control}</div> : null}
      </div>
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}

export function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 motion-reduce:transition-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 size-4 rounded-full bg-background shadow-sm transition-transform duration-150 motion-reduce:transition-none",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

/**
 * A native select, kept for its keyboard and screen-reader behaviour, styled
 * like bb's dropdown buttons. `className` sizes the wrapper.
 */
export function SettingsSelect({
  className,
  ...props
}: ComponentProps<"select">) {
  return (
    <span className={cn("relative inline-flex w-40", className)}>
      <select
        {...props}
        className="h-8 w-full appearance-none truncate rounded-md border border-border bg-background pl-2.5 pr-7 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      />
      <Icon
        name="ChevronDown"
        aria-hidden
        className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}

/** "After [12] hours without activity", with its range error underneath. */
export function InlineNumber({
  label,
  prefix,
  suffix,
  value,
  min,
  max,
  valid,
  errorId,
  onChange,
}: {
  label: string;
  prefix: string;
  suffix: string;
  value: number;
  min: number;
  max: number;
  valid: boolean;
  errorId: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{prefix}</span>
        <input
          type="number"
          aria-label={label}
          min={min}
          max={max}
          value={Number.isNaN(value) ? "" : value}
          aria-invalid={!valid}
          aria-describedby={valid ? undefined : errorId}
          onChange={(event) => onChange(Number(event.target.value))}
          className="h-7 w-16 rounded-md border border-border bg-background px-2 text-right text-sm tabular-nums text-foreground outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring aria-[invalid=true]:border-destructive"
        />
        <span>{suffix}</span>
      </div>
      {valid ? null : (
        <p id={errorId} className="mt-1 text-2xs text-destructive">
          Enter a whole number from {min} to {max}.
        </p>
      )}
    </div>
  );
}

export const secondaryButtonClass =
  "h-8 shrink-0 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
