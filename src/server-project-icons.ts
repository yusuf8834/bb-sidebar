import type { ServerContext, ServerHandlers } from "./server-context";
import {
  PROJECT_ICON_CANDIDATES,
  extractProjectIconHref,
  iconPathsForHref,
  normalizeProjectIconPath,
} from "./project-icons";
import {
  manifestProjectIconPath,
  PROJECT_ICON_SEARCH_QUERIES,
  rankDiscoveredProjectIcons,
} from "./project-icon-discovery";
import { PROJECT_ICONS_CHANNEL } from "./contract";
interface StoredProjectIconRow {
  project_id: string;
  path: string;
  updated_at: number;
}

interface StoredProjectIconUploadRow {
  project_id: string;
  filename: string;
  mime_type: string;
  content_base64: string;
  size_bytes: number;
  updated_at: number;
}

interface ResolvedProjectIcon {
  content: string;
  contentEncoding: "base64" | "utf8";
  mimeType: string;
  path: string;
  sizeBytes: number;
}

const PROJECT_ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;

const PROJECT_ICON_MAX_BYTES = 1_000_000;

const PROJECT_ICON_CACHE_MS = 5 * 60_000;

const PROJECT_ICON_MISS_CACHE_MS = 30_000;

// Only a file that does not exist is a real miss. Any other read failure, such
// as a host that is still connecting, must not be cached as "no icon".
function isMissingFileError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, code, message } = error as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  return (
    status === 404 ||
    code === "ENOENT" ||
    (typeof message === "string" && /ENOENT|not found|does not exist/i.test(message))
  );
}

function iconMimeType(path: string, reported: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".webp")) return "image/webp";
  return reported;
}

export function createServerProjectIcons(ctx: ServerContext) {
  const projectIconCache = new Map<string, { expiresAt: number; icon: ResolvedProjectIcon | null }>();

  const pendingProjectIconResolutions = new Map<string, Promise<ResolvedProjectIcon | null>>();

  const projectIconGenerations = new Map<string, number>();

  const defaultProjectHostIds = new Map<string, Promise<string | null>>();

  const readProjectIconOverride = (projectId: string): string | null =>
    (
      ctx.db
        .prepare(
          `SELECT project_id, path, updated_at
             FROM project_icons
            WHERE project_id = ?`,
        )
        .get(projectId) as StoredProjectIconRow | undefined
    )?.path ?? null;

  const readProjectIconUpload = (projectId: string): StoredProjectIconUploadRow | null =>
    (ctx.db
      .prepare(
        `SELECT project_id, filename, mime_type, content_base64,
                size_bytes, updated_at
           FROM project_icon_uploads
          WHERE project_id = ?`,
      )
      .get(projectId) as StoredProjectIconUploadRow | undefined) ?? null;

  const clearProjectIconCache = (projectId: string): void => {
    projectIconGenerations.set(projectId, (projectIconGenerations.get(projectId) ?? 0) + 1);
    for (const key of projectIconCache.keys()) {
      if (key.startsWith(`${projectId}\0`)) projectIconCache.delete(key);
    }
    for (const key of pendingProjectIconResolutions.keys()) {
      if (key.startsWith(`${projectId}\0`)) {
        pendingProjectIconResolutions.delete(key);
      }
    }
  };

  const projectIconGeneration = (projectId: string): number => projectIconGenerations.get(projectId) ?? 0;

  const defaultProjectHostId = async (projectId: string): Promise<string | null> => {
    let pending = defaultProjectHostIds.get(projectId);
    if (!pending) {
      pending = ctx.bb.sdk.projects
        .get({ projectId })
        .then(
          (project) => project.sources.find((source) => source.isDefault)?.hostId ?? project.sources[0]?.hostId ?? null,
        );
      defaultProjectHostIds.set(projectId, pending);
      void pending.catch(() => defaultProjectHostIds.delete(projectId));
    }
    return pending;
  };

  const readProjectFile = async (projectId: string, environmentId: string | null, path: string) => {
    if (environmentId) {
      return ctx.bb.sdk.projects.fileContent({ projectId, environmentId, path });
    }
    const hostId = await defaultProjectHostId(projectId);
    return hostId
      ? ctx.bb.sdk.projects.fileContent({ projectId, hostId, path })
      : ctx.bb.sdk.projects.fileContent({ projectId, path });
  };

  const listProjectFiles = async (projectId: string, environmentId: string | null, query: string) => {
    const request = { projectId, query, limit: "100" };
    if (environmentId) return ctx.bb.sdk.projects.files({ ...request, environmentId });
    const hostId = await defaultProjectHostId(projectId);
    return hostId ? ctx.bb.sdk.projects.files({ ...request, hostId }) : ctx.bb.sdk.projects.files(request);
  };

  const readManifestIconPath = async (projectId: string, environmentId: string | null): Promise<string | null> => {
    try {
      return manifestProjectIconPath(await readProjectFile(projectId, environmentId, "package.json"));
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  };

  const searchProjectIcons = async (projectId: string, environmentId: string | null): Promise<string[]> => {
    const results = await Promise.all(
      PROJECT_ICON_SEARCH_QUERIES.map((query) => listProjectFiles(projectId, environmentId, query)),
    );
    return rankDiscoveredProjectIcons(results.flatMap((result) => result.files.map((file) => file.path)));
  };

  const tryProjectIcon = async (
    projectId: string,
    environmentId: string | null,
    path: string,
  ): Promise<ResolvedProjectIcon | null> => {
    const normalized = normalizeProjectIconPath(path);
    if (!normalized) return null;
    try {
      const file = await readProjectFile(projectId, environmentId, normalized);
      if (file.sizeBytes > PROJECT_ICON_MAX_BYTES) return null;
      return {
        ...file,
        mimeType: iconMimeType(normalized, file.mimeType),
        path: normalized,
      };
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  };

  const resolveProjectIconUncached = async (
    projectId: string,
    environmentId: string | null,
    generation: number,
  ): Promise<ResolvedProjectIcon | null> => {
    const cacheKey = `${projectId}\0${environmentId ?? ""}`;
    const upload = readProjectIconUpload(projectId);
    if (upload) {
      const icon = {
        content: upload.content_base64,
        contentEncoding: "base64" as const,
        mimeType: upload.mime_type,
        path: upload.filename,
        sizeBytes: upload.size_bytes,
      };
      if (projectIconGeneration(projectId) === generation) {
        projectIconCache.set(cacheKey, {
          expiresAt: Date.now() + PROJECT_ICON_CACHE_MS,
          icon,
        });
      }
      return icon;
    }
    const candidates: string[] = [];
    const customPath = readProjectIconOverride(projectId);
    if (customPath) candidates.push(customPath);
    let icon: ResolvedProjectIcon | null = null;
    let unavailable = false;
    try {
      const manifestPath = await readManifestIconPath(projectId, environmentId);
      if (manifestPath) candidates.push(manifestPath);
    } catch {
      unavailable = true;
    }
    candidates.push(...PROJECT_ICON_CANDIDATES);
    for (const candidate of new Set(candidates)) {
      try {
        icon = await tryProjectIcon(projectId, environmentId, candidate);
      } catch {
        unavailable = true;
        continue;
      }
      if (icon) break;
    }
    if (!icon) {
      for (const sourcePath of PROJECT_ICON_SOURCE_FILES) {
        try {
          const source = await readProjectFile(projectId, environmentId, sourcePath);
          if (source.contentEncoding !== "utf8" || source.sizeBytes > PROJECT_ICON_MAX_BYTES) {
            continue;
          }
          const href = extractProjectIconHref(source.content);
          if (!href) continue;
          for (const path of iconPathsForHref(href)) {
            icon = await tryProjectIcon(projectId, environmentId, path);
            if (icon) break;
          }
          if (icon) break;
        } catch (error) {
          // Each source file is optional.
          if (!isMissingFileError(error)) unavailable = true;
        }
      }
    }
    if (!icon) {
      try {
        for (const path of await searchProjectIcons(projectId, environmentId)) {
          if (candidates.includes(path)) continue;
          try {
            icon = await tryProjectIcon(projectId, environmentId, path);
          } catch {
            unavailable = true;
            continue;
          }
          if (icon) break;
        }
      } catch {
        unavailable = true;
      }
    }
    if (!icon && unavailable) {
      throw new Error(`Project icon files for ${projectId} could not be read`);
    }
    if (projectIconGeneration(projectId) === generation) {
      projectIconCache.set(cacheKey, {
        expiresAt: Date.now() + (icon ? PROJECT_ICON_CACHE_MS : PROJECT_ICON_MISS_CACHE_MS),
        icon,
      });
    }
    return icon;
  };

  const resolveProjectIcon = (projectId: string, environmentId: string | null): Promise<ResolvedProjectIcon | null> => {
    const cacheKey = `${projectId}\0${environmentId ?? ""}`;
    const cached = projectIconCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.icon);
    }
    const pending = pendingProjectIconResolutions.get(cacheKey);
    if (pending) return pending;
    const generation = projectIconGeneration(projectId);
    const resolution = resolveProjectIconUncached(projectId, environmentId, generation).finally(() => {
      if (pendingProjectIconResolutions.get(cacheKey) === resolution) {
        pendingProjectIconResolutions.delete(cacheKey);
      }
    });
    pendingProjectIconResolutions.set(cacheKey, resolution);
    return resolution;
  };

  const handlers = {
    async listProjectIconSettings() {
      const projects = await ctx.bb.sdk.projects.list();
      return {
        projects: projects
          .filter((project) => project.kind === "standard")
          .map((project) => ({
            id: project.id,
            name: project.name,
            customPath: readProjectIconOverride(project.id),
            customUploadName: readProjectIconUpload(project.id)?.filename ?? null,
          })),
      };
    },
    async searchProjectIconFiles({ projectId, query }) {
      const hostId = await defaultProjectHostId(projectId);
      const request = {
        projectId,
        includeFiles: "true" as const,
        includeDirectories: "false" as const,
        limit: "100",
        query,
      };
      const result = hostId
        ? await ctx.bb.sdk.projects.paths({ ...request, hostId })
        : await ctx.bb.sdk.projects.paths(request);
      return {
        paths: [
          ...new Set(
            result.paths.flatMap((entry) => {
              if (entry.kind !== "file") return [];
              const path = normalizeProjectIconPath(entry.path);
              return path ? [path] : [];
            }),
          ),
        ].slice(0, 30),
      };
    },
    async setProjectIcon({ projectId, path }) {
      await ctx.bb.sdk.projects.get({ projectId });
      const normalized = path === null ? null : normalizeProjectIconPath(path);
      if (path !== null && normalized === null) {
        throw new Error("Choose a relative image path inside the project");
      }
      if (normalized === null) {
        ctx.db.transaction(() => {
          ctx.db.prepare(`DELETE FROM project_icons WHERE project_id = ?`).run(projectId);
          ctx.db.prepare(`DELETE FROM project_icon_uploads WHERE project_id = ?`).run(projectId);
        })();
      } else {
        ctx.db.transaction(() => {
          ctx.db
            .prepare(
              `INSERT INTO project_icons (project_id, path, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(project_id) DO UPDATE SET
               path = excluded.path,
               updated_at = excluded.updated_at`,
            )
            .run(projectId, normalized, Date.now());
          ctx.db.prepare(`DELETE FROM project_icon_uploads WHERE project_id = ?`).run(projectId);
        })();
      }
      clearProjectIconCache(projectId);
      ctx.bb.realtime.publish(PROJECT_ICONS_CHANNEL, { projectId });
      return { customPath: normalized, customUploadName: null };
    },
    async uploadProjectIcon({ projectId, filename, mimeType, contentBase64 }) {
      await ctx.bb.sdk.projects.get({ projectId });
      const bytes = Buffer.from(contentBase64, "base64");
      if (bytes.byteLength === 0 || bytes.byteLength > PROJECT_ICON_MAX_BYTES) {
        throw new Error("Choose an image smaller than 1 MB");
      }
      const normalizedFilename = filename.trim();
      const canonicalBase64 = bytes.toString("base64");
      if (canonicalBase64 !== contentBase64) {
        throw new Error("The selected image data is invalid");
      }
      const resolvedMimeType = iconMimeType(normalizedFilename, mimeType);
      ctx.db.transaction(() => {
        ctx.db
          .prepare(
            `INSERT INTO project_icon_uploads (
             project_id, filename, mime_type, content_base64,
             size_bytes, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET
             filename = excluded.filename,
             mime_type = excluded.mime_type,
             content_base64 = excluded.content_base64,
             size_bytes = excluded.size_bytes,
             updated_at = excluded.updated_at`,
          )
          .run(projectId, normalizedFilename, resolvedMimeType, canonicalBase64, bytes.byteLength, Date.now());
        ctx.db.prepare(`DELETE FROM project_icons WHERE project_id = ?`).run(projectId);
      })();
      clearProjectIconCache(projectId);
      ctx.bb.realtime.publish(PROJECT_ICONS_CHANNEL, { projectId });
      return {
        customPath: null,
        customUploadName: normalizedFilename,
      };
    },
  } satisfies Pick<
    ServerHandlers,
    "listProjectIconSettings" | "searchProjectIconFiles" | "setProjectIcon" | "uploadProjectIcon"
  >;

  return { resolveProjectIcon, clearProjectIconCache, defaultProjectHostIds, handlers };
}
