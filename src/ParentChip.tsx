import { useProviders, useSidebarThreads } from "./bb-sdk";
import { useBbNavigate, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { Tooltip } from "./components/Tooltip";
import { cn } from "./lib/utils";
import { Disc } from "./Disc";
import { ProviderGlyph } from "./ProviderGlyph";
import { DEFAULT_SIDEBAR_SETTINGS } from "./sidebar-settings";
import { useSidebarSettings } from "./useSidebarSettings";
import { parentOf, threadDisplayTitle } from "./inbox";

/**
 * The way back out of a child thread.
 *
 * The flat list hides a child while its parent is on screen, so opening a
 * child from the parent's header chip leaves the user with no route back. This
 * chip names the parent and opens it. Its icon follows the child icon setting.
 */
export function ParentChip({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { threads } = useSidebarThreads();
  const { providers } = useProviders();
  const settings = useSidebarSettings();
  const navigate = useBbNavigate();

  const parent = parentOf(threads, threadId);
  if (parent === null) return null;

  const title = threadDisplayTitle(parent);
  const iconStyle = settings?.childIconStyle ?? DEFAULT_SIDEBAR_SETTINGS.childIconStyle;
  const provider = providers.find((candidate) => candidate.id === parent.providerId);

  return (
    <Tooltip label={`Back to parent: ${title}`} side="bottom">
      <button
        type="button"
        aria-label={`Back to parent: ${title}`}
        onClick={() => navigate.toThread(parent.id)}
        className={cn(
          "flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border text-2xs text-muted-foreground",
          "hover:bg-accent hover:text-foreground",
          isCompactViewport ? "px-1.5" : "px-2",
        )}
      >
        <Icon name="ChevronLeft" className="size-3 shrink-0" aria-hidden />
        {iconStyle === "provider" && provider ? (
          <ProviderGlyph providerId={parent.providerId} provider={provider} />
        ) : (
          <Disc thread={parent} />
        )}
        {isCompactViewport ? null : <span className="truncate">{title}</span>}
      </button>
    </Tooltip>
  );
}
