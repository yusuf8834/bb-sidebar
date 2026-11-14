import type { ServerContext, ServerHandlers } from "./server-context";
import { PROJECT_COLORS_TAG } from "./rpc-tags";

export function createServerProjectColors(ctx: ServerContext) {
  const handlers = {
    async getProjectColors() {
      const rows = ctx.db.prepare("SELECT project_id, color FROM project_colors").all() as Array<{
        project_id: string;
        color: string;
      }>;
      return { colors: Object.fromEntries(rows.map((row) => [row.project_id, row.color])) };
    },
    async setProjectColor({ projectId, color }) {
      await ctx.bb.sdk.projects.get({ projectId });
      if (color === null) {
        ctx.db.prepare("DELETE FROM project_colors WHERE project_id = ?").run(projectId);
      } else {
        ctx.db
          .prepare(
            "INSERT INTO project_colors (project_id, color) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET color = excluded.color",
          )
          .run(projectId, color);
      }
      ctx.bb.rpc.experimental_invalidate([PROJECT_COLORS_TAG]);
      return { ok: true };
    },
  } satisfies Pick<ServerHandlers, "getProjectColors" | "setProjectColor">;

  return { handlers };
}
