import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { bbSidebarRpcContract } from "./server";
import { automaticProjectColor, projectColorsById, projectColorStyle, PROJECT_COLORS_CHANNEL } from "./project-colors";

export function useProjectColorOverrides(enabled = true) {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const request = useRef(0);
  const load = useCallback(async () => {
    if (!enabled) return;
    const seq = ++request.current;
    try {
      const result = await rpc.call("getProjectColors", {});
      if (seq === request.current) setOverrides(result.colors);
    } catch {
      // Keep automatic colors while the backend is reloading.
    }
  }, [enabled, rpc]);
  useEffect(() => {
    void load();
    return () => { request.current += 1; };
  }, [load]);
  useRealtime(PROJECT_COLORS_CHANNEL, () => { void load(); });
  return { overrides, reload: load };
}

const ProjectColorsContext = createContext<ReadonlyMap<string, string> | null>(null);

export function ProjectColorsProvider({ enabled, projectIds, children }: {
  enabled: boolean;
  projectIds: readonly string[];
  children: ReactNode;
}) {
  const { overrides } = useProjectColorOverrides(enabled);
  const colors = useMemo(() => enabled ? projectColorsById(projectIds, overrides) : null, [enabled, projectIds, overrides]);
  return <ProjectColorsContext.Provider value={colors}>{children}</ProjectColorsContext.Provider>;
}

export function useProjectColor(projectId: string | undefined) {
  const colors = useContext(ProjectColorsContext);
  return colors && projectId ? projectColorStyle(colors.get(projectId) ?? automaticProjectColor(projectId)) : undefined;
}
