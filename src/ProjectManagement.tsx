import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { errorDetail, toast } from "./lib/toast";
import type { bbSidebarRpcContract } from "./contract";
import { useSidebarRead } from "./bb-sdk";
import { cn } from "./lib/utils";
import {
  SettingRow,
  SettingsSection,
  SettingsSelect,
  destructiveButtonClass,
  secondaryButtonClass,
} from "./settings-ui";

interface ProjectChoice {
  id: string;
  name: string;
}

export function ProjectManagement() {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const directory = useSidebarRead("listProjects");
  // A removed project leaves the list at once, whatever a read in flight says.
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set());
  const projects = useMemo<ProjectChoice[]>(
    () => (directory.data?.projects ?? []).filter((project) => !removedIds.has(project.id)),
    [directory.data, removedIds],
  );
  const loadFailed = directory.error !== null;
  const loading = directory.data === undefined && !loadFailed;
  const [selectedId, setSelectedId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const selected = projects.find((project) => project.id === selectedId) ?? projects[0];

  useEffect(() => {
    setConfirming(false);
  }, [selected?.id]);

  const remove = async () => {
    if (!selected || removing) return;
    const removed = selected;
    setRemoving(true);
    try {
      await rpc.call("removeProject", { projectId: removed.id, confirmation: removed.name });
      setRemovedIds((current) => new Set(current).add(removed.id));
      setSelectedId("");
      setConfirming(false);
      toast.success(`${removed.name} removed from BB`);
    } catch (error) {
      toast.error("Could not remove the project", { description: errorDetail(error) });
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
            title="Remove from BB"
            description="Removes the project and its threads from BB."
            control={
              <div className="flex flex-wrap items-center gap-2">
                <SettingsSelect
                  aria-label="Project to remove"
                  value={selected.id}
                  disabled={removing}
                  onChange={(event) => {
                    setSelectedId(event.target.value);
                    setConfirming(false);
                  }}
                  className="w-48"
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </SettingsSelect>
                {!confirming ? (
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    className={cn(secondaryButtonClass, "text-destructive-text hover:bg-destructive/10")}
                  >
                    Remove…
                  </button>
                ) : null}
              </div>
            }
          />
          {confirming ? (
            <div
              role="group"
              aria-label={`Confirm removal of ${selected.name}`}
              className="mx-1.5 my-1 flex flex-wrap items-center justify-between gap-4 rounded-md bg-destructive/5 px-2.5 py-2.5"
            >
              <div className="min-w-0 flex-1 basis-48">
                <p className="break-words text-sm text-foreground">Remove {selected.name}?</p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  Its threads are removed from BB too. This cannot be undone.
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={removing}
                  onClick={() => setConfirming(false)}
                  className={secondaryButtonClass}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={removing}
                  onClick={() => void remove()}
                  className={destructiveButtonClass}
                >
                  {removing ? "Removing..." : "Remove from BB"}
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
