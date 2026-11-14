import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useSidebarRead } from "./bb-sdk";
import { automaticProjectColor, projectColorsById, projectColorStyle } from "./project-colors";
import type { ProjectColorDisplay } from "./sidebar-settings";

export type ProjectStripeView = "full" | "collapsed" | "group-full" | "group-collapsed";

const NO_OVERRIDES: Record<string, string> = {};

/** Saved project colors. Automatic colors stand in until the first answer and through a failed read. */
export function useProjectColorOverrides(enabled = true) {
  const { data, refresh } = useSidebarRead("getProjectColors", { enabled });
  return { overrides: data?.colors ?? NO_OVERRIDES, reload: refresh };
}

const ProjectColorsContext = createContext<{
  colors: ReadonlyMap<string, string>;
  display: ProjectColorDisplay;
} | null>(null);

export function ProjectColorsProvider({
  enabled,
  display,
  projectIds,
  children,
}: {
  enabled: boolean;
  display: ProjectColorDisplay;
  projectIds: readonly string[];
  children: ReactNode;
}) {
  const { overrides } = useProjectColorOverrides(enabled);
  const value = useMemo(
    () => (enabled ? { colors: projectColorsById(projectIds, overrides), display } : null),
    [enabled, projectIds, overrides, display],
  );
  return <ProjectColorsContext.Provider value={value}>{children}</ProjectColorsContext.Provider>;
}

export function useProjectColor(projectId: string | undefined) {
  const context = useContext(ProjectColorsContext);
  if (!context || !projectId) return undefined;
  return projectColorStyle(context.colors.get(projectId) ?? automaticProjectColor(projectId));
}

export function useProjectStripeColor(projectId: string, view: ProjectStripeView = "full") {
  const context = useContext(ProjectColorsContext);
  const color = useProjectColor(projectId);
  if (!context || context.display === "none") return undefined;
  if (context.display === "full" && (view === "collapsed" || view === "group-collapsed")) return undefined;
  if (context.display === "grouped" && view !== "group-full" && view !== "group-collapsed") return undefined;
  return color;
}
