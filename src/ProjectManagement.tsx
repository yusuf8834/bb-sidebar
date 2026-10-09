import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { bbSidebarRpcContract } from "./server";
import { PROJECT_ICONS_CHANNEL } from "./project-icons";
import { cn } from "./lib/utils";
import { SettingRow, SettingsSection, SettingsSelect, secondaryButtonClass } from "./settings-ui";

interface ProjectChoice {
  id: string;
  name: string;
}

export function ProjectManagement() {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const request = useRef(0);
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const selected = projects.find((project) => project.id === selectedId) ?? projects[0];

  const load = useCallback(async () => {
    const seq = ++request.current;
    try {
      const result = await rpc.call("listProjects", {});
      if (seq !== request.current) return;
      setProjects(result.projects);
      setLoadFailed(false);
    } catch {
      if (seq === request.current) setLoadFailed(true);
    } finally {
      if (seq === request.current) setLoading(false);
    }
  }, [rpc]);
  useEffect(() => {
    void load();
    return () => { request.current += 1; };
  }, [load]);
  useRealtime(PROJECT_ICONS_CHANNEL, () => { void load(); });
  useEffect(() => { setConfirming(false); }, [selected?.id]);

  const remove = async () => {
    if (!selected || removing) return;
    const removed = selected;
    request.current += 1;
    setRemoving(true);
    try {
      await rpc.call("removeProject", { projectId: removed.id, confirmation: removed.name });
      request.current += 1;
      setProjects((current) => current.filter((project) => project.id !== removed.id));
      setSelectedId("");
      setConfirming(false);
      toast.success(`${removed.name} removed from BB`);
    } catch (error) {
      toast.error("Could not remove the project", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <SettingsSection title="Project management">
      {loading || loadFailed || !selected ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          {loading ? "Loading projects..." : loadFailed ? "Could not load projects." : "No projects to remove."}
        </p>
      ) : (
        <>
          <SettingRow
            title="Project"
            description="Choose the project to remove from BB."
            control={
              <SettingsSelect
                aria-label="Project to remove"
                value={selected.id}
                disabled={removing}
                onChange={(event) => { setSelectedId(event.target.value); setConfirming(false); }}
                className="w-48"
              >
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </SettingsSelect>
            }
          />
          {confirming ? (
            <div role="group" aria-label={`Confirm removal of ${selected.name}`} className="mx-1.5 my-1 flex flex-wrap items-center justify-between gap-4 rounded-md bg-destructive/5 px-2.5 py-2.5">
              <div className="min-w-0 flex-1 basis-48">
                <p className="break-words text-sm text-foreground">Remove {selected.name}?</p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">Its threads are removed from BB too. This cannot be undone.</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" disabled={removing} onClick={() => setConfirming(false)} className={secondaryButtonClass}>Cancel</button>
                <button type="button" disabled={removing} onClick={() => void remove()} className="h-8 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">
                  {removing ? "Removing..." : "Remove from BB"}
                </button>
              </div>
            </div>
          ) : (
            <SettingRow
              title="Remove from BB"
              description="Removes the project and its threads from BB."
              control={<button type="button" onClick={() => setConfirming(true)} className={cn(secondaryButtonClass, "text-destructive-text hover:bg-destructive/10")}>Remove…</button>}
            />
          )}
        </>
      )}
    </SettingsSection>
  );
}
