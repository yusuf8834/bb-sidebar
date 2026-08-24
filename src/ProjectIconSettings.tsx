import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { bbSidebarRpcContract } from "./server";

interface ProjectIconSetting {
  id: string;
  name: string;
  customPath: string | null;
}

export function ProjectIconSettings() {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const [projects, setProjects] = useState<ProjectIconSetting[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [path, setPath] = useState("");
  const [matches, setMatches] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const searchSequence = useRef(0);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("listProjectIconSettings", {});
      setProjects(result.projects);
      setSelectedProjectId((current) =>
        result.projects.some((project) => project.id === current)
          ? current
          : (result.projects[0]?.id ?? ""),
      );
    } catch (error) {
      toast.error("Could not load project icons", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("project-icons", () => {
    void load();
  });

  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? null;
  useEffect(() => {
    setPath(selectedProject?.customPath ?? "");
  }, [selectedProject?.customPath, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setMatches([]);
      return;
    }
    const sequence = ++searchSequence.current;
    const timer = window.setTimeout(() => {
      void rpc
        .call("searchProjectIconFiles", {
          projectId: selectedProjectId,
          query: path,
        })
        .then((result) => {
          if (searchSequence.current === sequence) setMatches(result.paths);
        })
        .catch(() => {
          if (searchSequence.current === sequence) setMatches([]);
        });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [path, rpc, selectedProjectId]);

  const save = async (nextPath: string | null) => {
    if (!selectedProjectId || saving) return;
    setSaving(true);
    try {
      const result = await rpc.call("setProjectIcon", {
        projectId: selectedProjectId,
        path: nextPath,
      });
      setProjects((current) =>
        current.map((project) =>
          project.id === selectedProjectId
            ? { ...project, customPath: result.customPath }
            : project,
        ),
      );
      setPath(result.customPath ?? "");
      toast.success(
        result.customPath
          ? "Project icon saved"
          : "Using automatic icon detection",
      );
    } catch (error) {
      toast.error("Could not save project icon", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-xs text-muted-foreground">Loading projects…</p>;
  }
  if (projects.length === 0) {
    return <p className="text-xs text-muted-foreground">No projects yet.</p>;
  }

  return (
    <div className="max-w-xl space-y-3">
      <label className="grid gap-1.5 text-xs font-medium text-foreground">
        Project
        <select
          value={selectedProjectId}
          onChange={(event) => setSelectedProjectId(event.target.value)}
          className="h-9 rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>

      <div className="rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">
              {selectedProject?.customPath ?? "Automatic"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Automatic checks common favicon and app icon paths. If none exist,
              the sidebar stays icon-free.
            </p>
          </div>
          {selectedProject?.customPath ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => void save(null)}
              className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              Use automatic
            </button>
          ) : null}
        </div>
      </div>

      <label className="grid gap-1.5 text-xs font-medium text-foreground">
        Choose a project image
        <div className="flex gap-2">
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="Search or enter a relative path"
            className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            disabled={saving || path.trim().length === 0}
            onClick={() => void save(path.trim())}
            className="rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Use image
          </button>
        </div>
      </label>

      {matches.length > 0 ? (
        <div
          aria-label="Matching project images"
          className="max-h-48 overflow-y-auto rounded-md border border-border p-1"
        >
          {matches.map((match) => (
            <button
              key={match}
              type="button"
              onClick={() => void save(match)}
              disabled={saving}
              className="block w-full truncate rounded px-2 py-1.5 text-left font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {match}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
