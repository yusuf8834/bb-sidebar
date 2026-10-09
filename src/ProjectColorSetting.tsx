import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { bbSidebarRpcContract } from "./server";
import { useProjectColorOverrides } from "./ProjectColors";
import { automaticProjectColor, projectColorsById } from "./project-colors";
import { SettingRow, secondaryButtonClass } from "./settings-ui";

export function ProjectColorSetting({ projectId, projectIds }: { projectId: string; projectIds: readonly string[] }) {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const { overrides, reload } = useProjectColorOverrides();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const color = projectColorsById(projectIds, overrides).get(projectId) ?? automaticProjectColor(projectId);
  const save = async (value: string | null) => {
    if (saving) return;
    setSaving(true);
    try {
      await rpc.call("setProjectColor", { projectId, color: value });
      await reload();
      setDraft(null);
      toast.success(value ? "Project color saved" : "Using automatic project color");
    } catch (error) {
      toast.error("Could not save project color", { description: error instanceof Error ? error.message : undefined });
    } finally {
      setSaving(false);
    }
  };
  return <SettingRow title="Color" description="Used when Project colors is enabled. The automatic color stays the same when you rename the project." control={
    <div className="flex flex-wrap items-center justify-end gap-2">
      <input type="color" aria-label="Project color" value={draft ?? color} disabled={saving} onChange={(event) => setDraft(event.target.value)} className="h-8 w-10 cursor-pointer rounded border border-border bg-background p-0.5 disabled:cursor-wait" />
      {draft !== null && draft !== color ? <button type="button" className={secondaryButtonClass} disabled={saving} onClick={() => void save(draft)}>{saving ? "Saving..." : "Save color"}</button> : null}
      {overrides[projectId] ? <button type="button" className={secondaryButtonClass} disabled={saving} onClick={() => void save(null)}>Reset color</button> : null}
    </div>
  } />;
}
