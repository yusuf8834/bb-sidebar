import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSdk, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { toast } from "./lib/toast";
import { cn } from "./lib/utils";
import { threadDisplayTitle } from "./inbox";
import { ThreadTitle } from "./ThreadTitle";

/** Inline title editing shared by full cards and parked rows. */
export function InlineThreadTitle({
  thread,
  editing,
  onEditingChange,
  className,
}: {
  thread: PluginSidebarThread;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  className?: string;
}) {
  const sdk = useSdk();
  const title = threadDisplayTitle(thread);
  const [draft, setDraft] = useState(title);
  const finished = useRef(false);
  const latest = useRef({ draft, title, sdk, onEditingChange });
  latest.current = { draft, title, sdk, onEditingChange };

  useLayoutEffect(() => {
    if (!editing) return;
    return () => {
      if (finished.current) return;
      finished.current = true;
      const { draft: currentDraft, title: currentTitle, sdk: currentSdk, onEditingChange: notify } = latest.current;
      notify(false);
      const nextTitle = currentDraft.trim();
      if (nextTitle && nextTitle !== currentTitle) saveTitle(currentSdk, thread.id, nextTitle);
    };
  }, [editing, thread.id]);

  useEffect(() => {
    if (!editing) return;
    setDraft(title);
    finished.current = false;
  }, [editing, title]);

  if (!editing) return <ThreadTitle threadId={thread.id} title={title} className={className} />;

  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    onEditingChange(false);
    const nextTitle = draft.trim();
    if (save && nextTitle.length > 0 && nextTitle !== title) {
      saveTitle(sdk, thread.id, nextTitle);
    }
  };

  return (
    <input
      autoFocus
      aria-label={`Rename ${title}`}
      value={draft}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      className={cn(
        "h-6 w-full min-w-0 appearance-none rounded border border-solid border-border bg-background px-1.5 text-inherit text-foreground shadow-none outline-none focus:border-ring",
        className,
      )}
    />
  );
}

function saveTitle(sdk: ReturnType<typeof useSdk>, threadId: string, title: string) {
  void sdk.threads.update({ threadId, title }).catch((error) => {
    // The SDK rolls back; preserve the former sidebar rename's error feedback.
    toast.error("Failed to update thread", {
      description: error instanceof Error ? error.message.replace(/^HTTP \d+: /, "") : undefined,
    });
  });
}
