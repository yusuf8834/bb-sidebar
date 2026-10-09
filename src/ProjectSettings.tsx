import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { bbSidebarRpcContract } from "./server";
import {
  PROJECT_ICONS_CHANNEL,
  PROJECT_ICON_EXTENSIONS,
  projectIconUrl,
} from "./project-icons";
import { ProjectMonogram } from "./ProjectFavicon";
import { ProjectColorSetting } from "./ProjectColorSetting";
import { cn } from "./lib/utils";
import {
  SettingRow,
  SettingsSection,
  SettingsSelect,
  secondaryButtonClass,
} from "./settings-ui";

interface ProjectIconSetting {
  id: string;
  name: string;
  customPath: string | null;
  customUploadName: string | null;
}

interface ProjectChoice {
  id: string;
  name: string;
}

const MAX_ICON_BYTES = 1_000_000;

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that image"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      if (separator < 0) {
        reject(new Error("Could not read that image"));
        return;
      }
      resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Per-project settings behind one project picker: the sidebar icon, and
 * removing the project from bb. Personal projects have an icon but cannot be
 * removed, so the remove row only shows for projects the server lists as
 * removable.
 */
export function ProjectSettings() {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadRequestSeq = useRef(0);
  const [iconSettings, setIconSettings] = useState<ProjectIconSetting[]>([]);
  const [removable, setRemovable] = useState<ProjectChoice[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [previewFailed, setPreviewFailed] = useState(false);

  const load = useCallback(async () => {
    const seq = ++loadRequestSeq.current;
    const [icons, projects] = await Promise.allSettled([
      rpc.call("listProjectIconSettings", {}),
      rpc.call("listProjects", {}),
    ]);
    if (seq !== loadRequestSeq.current) return;
    if (icons.status === "fulfilled") {
      setIconSettings(icons.value.projects);
    } else {
      toast.error("Could not load project icons", {
        description:
          icons.reason instanceof Error ? icons.reason.message : undefined,
      });
    }
    if (projects.status === "fulfilled") {
      setRemovable(projects.value.projects);
    } else {
      toast.error("Could not load projects", {
        description:
          projects.reason instanceof Error ? projects.reason.message : undefined,
      });
    }
    setLoading(false);
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime(PROJECT_ICONS_CHANNEL, () => {
    setRevision((current) => current + 1);
    void load();
  });

  // Every project either list knows, in the icon list's order.
  const choices: ProjectChoice[] = [
    ...iconSettings,
    ...removable.filter(
      (project) => !iconSettings.some((icon) => icon.id === project.id),
    ),
  ];
  const selected =
    choices.find((project) => project.id === selectedProjectId) ??
    choices[0] ??
    null;
  const selectedId = selected?.id ?? "";
  const icon = iconSettings.find((project) => project.id === selectedId) ?? null;
  const canRemove = removable.some((project) => project.id === selectedId);
  const hasCustomIcon = !!(icon?.customPath || icon?.customUploadName);

  useEffect(() => {
    setPreviewFailed(false);
  }, [revision, selectedId]);

  const applyIconResult = (result: {
    customPath: string | null;
    customUploadName: string | null;
  }) => {
    setIconSettings((current) =>
      current.map((project) =>
        project.id === selectedId ? { ...project, ...result } : project,
      ),
    );
    setRevision((current) => current + 1);
    setPreviewFailed(false);
  };

  const clearCustomIcon = async () => {
    if (!selectedId || saving) return;
    loadRequestSeq.current += 1;
    setSaving(true);
    try {
      applyIconResult(
        await rpc.call("setProjectIcon", { projectId: selectedId, path: null }),
      );
      toast.success("Using automatic icon detection");
    } catch (error) {
      toast.error("Could not reset the project icon", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const upload = async (file: File) => {
    if (!selectedId || saving) return;
    if (file.size > MAX_ICON_BYTES) {
      toast.error("Choose an image smaller than 1 MB");
      return;
    }
    const lowerName = file.name.toLowerCase();
    if (
      !PROJECT_ICON_EXTENSIONS.some((extension) =>
        lowerName.endsWith(extension),
      )
    ) {
      toast.error("Choose an SVG, PNG, ICO, JPEG, GIF, AVIF, or WebP image");
      return;
    }
    loadRequestSeq.current += 1;
    setSaving(true);
    try {
      const contentBase64 = await readFileAsBase64(file);
      applyIconResult(
        await rpc.call("uploadProjectIcon", {
          projectId: selectedId,
          filename: file.name,
          mimeType: file.type,
          contentBase64,
        }),
      );
      toast.success("Project icon saved");
    } catch (error) {
      toast.error("Could not save the project icon", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const remove = async () => {
    if (!selected || !canRemove || removing) return;
    const removed = selected;
    loadRequestSeq.current += 1;
    setRemoving(true);
    try {
      await rpc.call("removeProject", {
        projectId: removed.id,
        confirmation: removed.name,
      });
      setIconSettings((current) => current.filter((p) => p.id !== removed.id));
      setRemovable((current) => current.filter((p) => p.id !== removed.id));
      setSelectedProjectId("");
      setConfirmingRemoval(false);
      toast.success(`${removed.name} removed from BB`);
    } catch (error) {
      toast.error("Could not remove the project", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setRemoving(false);
    }
  };

  if (loading || choices.length === 0) {
    return (
      <SettingsSection title="Projects">
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          {loading ? "Loading projects..." : "No projects yet."}
        </p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Projects">
      <SettingRow
        title="Project"
        description="The project the settings below apply to."
        control={
          <SettingsSelect
            aria-label="Project"
            value={selectedId}
            disabled={removing}
            onChange={(event) => {
              setSelectedProjectId(event.target.value);
              setConfirmingRemoval(false);
            }}
            className="w-48"
          >
            {choices.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </SettingsSelect>
        }
      />
      <ProjectColorSetting key={selectedId} projectId={selectedId} projectIds={choices.map((project) => project.id)} />
      {icon ? (
        <div className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
            {!previewFailed ? (
              <img
                src={projectIconUrl(icon.id, revision)}
                alt=""
                className="size-full object-contain p-1"
                onError={() => setPreviewFailed(true)}
              />
            ) : (
              <ProjectMonogram
                name={icon.name}
                className="size-full rounded-none text-lg"
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">Icon</p>
            <p className="mt-0.5 truncate text-xs leading-5 text-muted-foreground">
              {icon.customUploadName
                ? `Uploaded: ${icon.customUploadName}`
                : icon.customPath
                  ? `From project: ${icon.customPath}`
                  : "Found automatically from the project's favicon."}
            </p>
          </div>
          {hasCustomIcon ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => void clearCustomIcon()}
              className={secondaryButtonClass}
            >
              Use automatic
            </button>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            aria-label="Choose project icon image"
            accept={PROJECT_ICON_EXTENSIONS.join(",")}
            disabled={saving}
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <button
            type="button"
            disabled={saving}
            title="SVG, PNG, ICO, JPEG, GIF, AVIF, or WebP, up to 1 MB"
            onClick={() => fileInputRef.current?.click()}
            className={secondaryButtonClass}
          >
            {saving ? "Saving..." : "Upload image…"}
          </button>
        </div>
      ) : null}
      {canRemove && selected ? (
        confirmingRemoval ? (
          <div
            role="group"
            aria-label={`Confirm removal of ${selected.name}`}
            className="mx-1.5 my-1 flex items-center justify-between gap-4 rounded-md bg-destructive/5 px-2.5 py-2.5"
          >
            <div className="min-w-0">
              <p className="break-words text-sm text-foreground">
                Remove {selected.name}?
              </p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Its threads are removed from BB too. This cannot be undone.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                disabled={removing}
                onClick={() => setConfirmingRemoval(false)}
                className={secondaryButtonClass}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={removing}
                onClick={() => void remove()}
                className="h-8 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                {removing ? "Removing..." : "Remove from BB"}
              </button>
            </div>
          </div>
        ) : (
          <SettingRow
            title="Remove from BB"
            description="Removes the project and its threads from BB."
            control={
              <button
                type="button"
                onClick={() => setConfirmingRemoval(true)}
                className={cn(secondaryButtonClass, "text-destructive-text hover:bg-destructive/10")}
              >
                Remove…
              </button>
            }
          />
        )
      ) : null}
    </SettingsSection>
  );
}
