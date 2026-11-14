import { ProviderIcon, type useProviders } from "./bb-sdk";

import { cn } from "./lib/utils";
import { TRAILING_GLYPH_BOX_CLASS } from "./StatusSlot";

export type SidebarProvider = ReturnType<typeof useProviders>["providers"][number];

/**
 * The agent a thread runs on, resolved from bb's live provider directory.
 *
 * Ends the card's third line or a compact row. bb draws a known provider's
 * artwork, with its theme tint. A provider missing from the current directory
 * gets a neutral dot.
 */
export function ProviderGlyph({
  providerId,
  provider,
  className,
}: {
  providerId: string;
  provider: SidebarProvider | null;
  className?: string;
}) {
  const label = provider?.displayName ?? providerId;
  return (
    <span role="img" aria-label={label} className={cn(TRAILING_GLYPH_BOX_CLASS, className)}>
      {provider ? (
        <ProviderIcon
          providerKind="agent"
          provider={provider}
          aria-hidden
          className="size-3 text-muted-foreground/70"
        />
      ) : (
        <span className="size-2 rounded-full bg-muted-foreground/50" />
      )}
    </span>
  );
}
