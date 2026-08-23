import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "./components/Select";
import { Icon } from "./components/Icon";
import { Tooltip } from "./components/Tooltip";
import type { ConfiguredSnoozePreset } from "./lifecycle";

export function SnoozeSelect({
  label,
  snoozePresets,
  disabled = false,
  triggerClassName,
  onSnooze,
}: {
  label: string;
  snoozePresets: readonly ConfiguredSnoozePreset[];
  disabled?: boolean;
  triggerClassName: string;
  onSnooze: (snoozedUntil: number) => void;
}) {
  return (
    <Select
      disabled={disabled || snoozePresets.length === 0}
      onValueChange={(presetId) => {
        const preset = snoozePresets.find((item) => item.id === presetId);
        if (preset) onSnooze(Date.now() + preset.durationMs);
      }}
    >
      <Tooltip label={label}>
        <SelectTrigger aria-label={label} className={triggerClassName}>
          <Icon name="Clock" className="size-3.5" />
        </SelectTrigger>
      </Tooltip>
      <SelectContent align="end">
        {snoozePresets.map((preset) => (
          <SelectItem key={preset.id} value={preset.id} className="text-xs">
            {preset.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
