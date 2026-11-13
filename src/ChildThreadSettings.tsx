import {
  CHILD_THREAD_ICON_STYLES,
  CHILD_THREAD_SORT_DIRECTIONS,
  CHILD_THREAD_SORT_FIELDS,
  type ChildThreadIconStyle,
  type ChildThreadSortDirection,
  type ChildThreadSortField,
} from "./sidebar-settings";
import { SettingRow, SettingsSection, SettingsSelect, Switch, type SettingsDraftSectionProps } from "./settings-ui";

const CHILD_SORT_FIELD_LABELS: Record<ChildThreadSortField, string> = {
  created: "Date created",
  activity: "Last activity",
};
const CHILD_ICON_STYLE_LABELS: Record<ChildThreadIconStyle, string> = {
  disc: "Colour circle",
  provider: "Provider icon",
};
const CHILD_SORT_DIRECTION_LABELS: Record<ChildThreadSortDirection, string> = {
  ascending: "Oldest first",
  descending: "Newest first",
};

export function ChildThreadSettings({ draft, update, status }: SettingsDraftSectionProps) {
  return (
    <SettingsSection title="Child threads" status={status}>
      <SettingRow
        title="Show children that need attention"
        description="Keep children with a status visible while their list is collapsed."
        control={
          <Switch
            label="Show children that need attention"
            checked={draft.showRunningChildrenWhenCollapsed}
            onChange={(checked) => update("showRunningChildrenWhenCollapsed", checked)}
          />
        }
      />
      <SettingRow
        title="Order"
        description="Also used for subthreads in hover cards."
        control={
          <div className="flex flex-wrap items-center gap-2">
            <SettingsSelect
              aria-label="Child threads sort field"
              value={draft.childSortField}
              onChange={(event) => update("childSortField", event.target.value as ChildThreadSortField)}
              className="w-36"
            >
              {CHILD_THREAD_SORT_FIELDS.map((field) => (
                <option key={field} value={field}>
                  {CHILD_SORT_FIELD_LABELS[field]}
                </option>
              ))}
            </SettingsSelect>
            <SettingsSelect
              aria-label="Child threads sort direction"
              value={draft.childSortDirection}
              onChange={(event) => update("childSortDirection", event.target.value as ChildThreadSortDirection)}
              className="w-32"
            >
              {CHILD_THREAD_SORT_DIRECTIONS.map((direction) => (
                <option key={direction} value={direction}>
                  {CHILD_SORT_DIRECTION_LABELS[direction]}
                </option>
              ))}
            </SettingsSelect>
          </div>
        }
      />
      <SettingRow
        title="Icon"
        description="With provider icons, a parent's badge shows each agent once."
        control={
          <SettingsSelect
            aria-label="Child thread icon"
            value={draft.childIconStyle}
            onChange={(event) => update("childIconStyle", event.target.value as ChildThreadIconStyle)}
            className="w-36"
          >
            {CHILD_THREAD_ICON_STYLES.map((style) => (
              <option key={style} value={style}>
                {CHILD_ICON_STYLE_LABELS[style]}
              </option>
            ))}
          </SettingsSelect>
        }
      />
    </SettingsSection>
  );
}
