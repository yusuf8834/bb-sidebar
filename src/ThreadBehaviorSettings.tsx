import { MAX_AUTO_SETTLE_AFTER_DAYS, MIN_AUTO_SETTLE_AFTER_DAYS } from "./auto-settle";
import {
  InlineNumber,
  SettingRow,
  SettingsSection,
  SettingsGroup,
  SwitchRow,
  type SettingsDraftSectionProps,
} from "./settings-ui";

export function ThreadBehaviorSettings({
  draft,
  update,
  status,
  autoSettleDaysValid,
  snoozePresetsError,
  snoozePreview,
}: SettingsDraftSectionProps & {
  autoSettleDaysValid: boolean;
  snoozePresetsError: string | null;
  snoozePreview: string[];
}) {
  return (
    <SettingsSection title="Thread behavior" status={status}>
      <SettingsGroup title="Snooze">
        <SettingRow
          title="Snooze shortcuts"
          description={
            <>
              Comma-separated. Durations like <Code>30m</Code> or <Code>2h</Code>, times like <Code>evening@18:00</Code>
              , <Code>tomorrow@09:00</Code> or <Code>next-week@09:00</Code>. Rename one with <Code>Label=value</Code>.
            </>
          }
        >
          <textarea
            aria-label="Snooze shortcuts"
            aria-invalid={snoozePresetsError !== null}
            aria-describedby="snooze-shortcuts-feedback"
            value={draft.snoozePresets}
            onChange={(event) => update("snoozePresets", event.target.value)}
            rows={2}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs leading-5 text-foreground outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring aria-[invalid=true]:border-destructive"
          />
          <div id="snooze-shortcuts-feedback" className="mt-1.5">
            {snoozePresetsError ? (
              <p className="text-2xs text-destructive">{snoozePresetsError}</p>
            ) : (
              <ul aria-label="Snooze menu preview" className="flex flex-wrap items-center gap-1">
                {snoozePreview.map((label, index) => (
                  <li
                    key={`${index}-${label}`}
                    className="rounded border border-border bg-muted/50 px-1.5 py-0.5 text-2xs text-muted-foreground"
                  >
                    {label}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Automatic settle">
        <SwitchRow
          title="Settle quiet threads"
          description="Move threads to Settled after a longer quiet period."
          checked={draft.autoSettleInactive}
          onChange={(checked) => update("autoSettleInactive", checked)}
        >
          {draft.autoSettleInactive ? (
            <InlineNumber
              label="Days before auto-settle"
              prefix="After"
              suffix="days without activity"
              value={draft.autoSettleAfterDays}
              min={MIN_AUTO_SETTLE_AFTER_DAYS}
              max={MAX_AUTO_SETTLE_AFTER_DAYS}
              valid={autoSettleDaysValid}
              errorId="auto-settle-days-error"
              onChange={(value) => update("autoSettleAfterDays", value)}
            />
          ) : null}
        </SwitchRow>
        <SwitchRow
          title="Settle finished pull requests"
          description="Settles a thread when its pull request is merged or closed after the thread's last activity. Pull request status comes from the GitHub PR Status plugin; while it is off, threads with a workspace are not settled automatically."
          checked={draft.autoSettleOnMerge}
          onChange={(checked) => update("autoSettleOnMerge", checked)}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}

function Code({ children }: { children: string }) {
  return <code className="rounded bg-muted px-1 py-px font-mono text-2xs text-foreground/80">{children}</code>;
}
