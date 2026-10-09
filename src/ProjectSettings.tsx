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
import {
  SettingRow,
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

/** Project color and icon controls, rendered inside Project appearance. */
export function ProjectAppearanceSettings() {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadRequestSeq = useRef(0);
  const [iconSettings, setIconSettings] = useState<ProjectIconSetting[]>([]);
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [previewFailed, setPreviewFailed] = useState(false);

  const load = useCallback(async () => {
    const seq = ++loadRequestSeq.current;
    const [icons, directory] = await Promise.allSettled([
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
    if (directory.status === "fulfilled") {
      setProjects(directory.value.projects);
    } else {
      toast.error("Could not load projects", {
        description:
          directory.reason instanceof Error ? directory.reason.message : undefined,
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
    ...projects.filter(
      (project) => !iconSettings.some((icon) => icon.id === project.id),
    ),
  ];
  const selected =
    choices.find((project) => project.id === selectedProjectId) ??
    choices[0] ??
    null;
  const selectedId = selected?.id ?? "";
  const icon = iconSettings.find((project) => project.id === selectedId) ?? null;
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

  if (loading || choices.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
        {loading ? "Loading projects..." : "No projects yet."}
      </p>
    );
  }

  return (
    <>
      <SettingRow
        title="Project"
        description="The project the settings below apply to."
        control={
          <SettingsSelect
            aria-label="Project"
            value={selectedId}
            onChange={(event) => {
              setSelectedProjectId(event.target.value);
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
    </>
  );
}
