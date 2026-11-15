import { useRef, useState, type MutableRefObject } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useSdk, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { errorDetail, toast } from "./lib/toast";
import { Icon } from "./components/Icon";
import { usePortalScopeProps } from "./lib/portal-scope";

type ParentNotifications = "auto" | "stuck" | "off";

// Which of this child's turn outcomes wake its parent thread, as bb defines them.
const CHOICES: ReadonlyArray<{ value: ParentNotifications; label: string; detail: string }> = [
  { value: "auto", label: "Every outcome", detail: "Each finished, failed, or interrupted turn" },
  { value: "stuck", label: "Only when stuck", detail: "Failed, interrupted, or waiting on an answer" },
  { value: "off", label: "Off", detail: "The parent is never woken" },
];

function isParentNotifications(value: unknown): value is ParentNotifications {
  return value === "auto" || value === "stuck" || value === "off";
}

/**
 * Whether bb acts on this thread's setting: a child with a parent, but not a
 * fork, whose outcomes bb never reports to the parent.
 */
export function notifiesParent(thread: PluginSidebarThread): boolean {
  return thread.parentThreadId !== null && thread.originKind === null;
}

/**
 * Choose which outcomes notify the parent. Choosing closes the menu and
 * unmounts this, so the caller keeps the pending save: a reopen reads only
 * after it lands, and saves never overlap.
 */
export function ParentNotificationsMenu({
  thread,
  pendingSave,
}: {
  thread: PluginSidebarThread;
  pendingSave: MutableRefObject<Promise<void> | null>;
}) {
  const sdk = useSdk();
  const portalScope = usePortalScopeProps();
  const [value, setValue] = useState<ParentNotifications | null>(null);
  const [saving, setSaving] = useState(false);
  const loads = useRef(0);

  // The sidebar's thread rows do not carry this setting, so read it on open.
  const load = () => {
    const load = ++loads.current;
    setValue(null);
    const pending = pendingSave.current;
    setSaving(pending !== null);
    void Promise.resolve(pending)
      .then(() => sdk.threads.get({ threadId: thread.id }))
      .then(
        (response) => {
          if (load !== loads.current) return;
          const current: unknown = response.parentNotifications;
          setValue(isParentNotifications(current) ? current : "auto");
        },
        () => {
          /* The choices stay usable; none is checked until a save succeeds. */
        },
      )
      .finally(() => {
        if (load === loads.current) setSaving(false);
      });
  };

  const update = (next: ParentNotifications) => {
    if (saving || pendingSave.current !== null || next === value) return;
    const previous = value;
    loads.current += 1;
    setValue(next);
    setSaving(true);
    const save = sdk.threads.update({ threadId: thread.id, parentNotifications: next }).then(
      () => undefined,
      (error: unknown) => {
        setValue(previous);
        toast.error("Could not update parent notifications", { description: errorDetail(error) });
      },
    );
    pendingSave.current = save;
    void save.finally(() => {
      if (pendingSave.current === save) pendingSave.current = null;
      setSaving(false);
    });
  };

  return (
    <ContextMenu.Sub onOpenChange={(open) => open && load()}>
      <ContextMenu.SubTrigger className="flex cursor-pointer items-center rounded-md px-2 py-[0.3125rem] text-xs outline-none data-[state=open]:bg-accent data-[highlighted]:bg-accent">
        Notify parent
        <Icon name="ChevronRight" className="ml-auto size-4 opacity-60" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          {...portalScope}
          aria-label="Parent notifications"
          sideOffset={4}
          className="z-50 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <ContextMenu.Label className="px-2 py-1 text-xs text-muted-foreground">
            Wake the parent thread on
          </ContextMenu.Label>
          <ContextMenu.RadioGroup
            value={value ?? ""}
            onValueChange={(next) => {
              if (isParentNotifications(next)) update(next);
            }}
          >
            {CHOICES.map((choice) => (
              <ContextMenu.RadioItem
                key={choice.value}
                value={choice.value}
                disabled={saving}
                textValue={choice.label}
                className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-[0.3125rem] text-xs outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{choice.label}</span>
                  <span className="text-2xs text-muted-foreground">{choice.detail}</span>
                </span>
                <ContextMenu.ItemIndicator>
                  <Icon name="Check" className="size-4" />
                </ContextMenu.ItemIndicator>
              </ContextMenu.RadioItem>
            ))}
          </ContextMenu.RadioGroup>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
