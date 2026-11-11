import { ProjectAppearanceSettings } from "./ProjectSettings";
import { PROJECT_COLOR_DISPLAYS, type ProjectColorDisplay } from "./sidebar-settings";
import {
  SettingRow,
  SettingsSection,
  SettingsGroup,
  SettingsSelect,
  Switch,
  type SettingsDraftSectionProps,
} from "./settings-ui";

const PROJECT_COLOR_DISPLAY_LABELS: Record<ProjectColorDisplay, string> = {
  all: "Full and collapsed mode",
  full: "Full mode only",
  grouped: "Grouped projects only",
  none: "No stripes",
};

export function ProjectAppearanceSection({ draft, update, status }: SettingsDraftSectionProps) {
  return (
    <SettingsSection title="Project appearance" status={status}>
      <SettingRow
        title="Project colors"
        description="Color project names in every mode. Choose where their stripes appear below."
        control={
          <Switch
            label="Project colors"
            checked={draft.projectColorsEnabled}
            onChange={(checked) => update("projectColorsEnabled", checked)}
          />
        }
      >
        {draft.projectColorsEnabled ? (
          <div className="border-l-2 border-border">
            <SettingRow
              title="Show stripes in"
              description="Full mode includes cards and expanded groups. Grouped projects means combined blocks when sorting by Project. No stripes keeps the names colored without a stripe."
              control={
                <SettingsSelect
                  aria-label="Show project stripes in"
                  value={draft.projectColorDisplay}
                  onChange={(event) => update("projectColorDisplay", event.target.value as ProjectColorDisplay)}
                  className="w-52"
                >
                  {PROJECT_COLOR_DISPLAYS.map((display) => (
                    <option key={display} value={display}>
                      {PROJECT_COLOR_DISPLAY_LABELS[display]}
                    </option>
                  ))}
                </SettingsSelect>
              }
            />
          </div>
        ) : null}
      </SettingRow>
      <SettingsGroup title="Customize a project">
        <ProjectAppearanceSettings />
      </SettingsGroup>
    </SettingsSection>
  );
}
