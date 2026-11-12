import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { portScanContract, type PortRoot } from "./port-scan-contract";
import type { OpenPort, PortSnapshot } from "./contract";

const CACHE_MS = 30_000;
// A host whose backoff ran out this long ago starts over at its first step.
const FAILURE_MEMORY_MS = 300_000;

async function forEachConcurrent<T>(items: T[], limit: number, visit: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await visit(items[next++]);
    }),
  );
}

// Hosts that scan are macOS or Linux, so environment paths use "/".
const isNestedUnder = (path: string, root: string) => path.startsWith(`${root.replace(/\/+$/, "")}/`);

/**
 * Open ports for the workspaces the app names. The app knows which threads
 * are live; bb has no notion of a settled thread, so the server no longer
 * lists threads to find workspaces. Results are cached per workspace for 30s,
 * and a workspace already being scanned is shared with later callers.
 *
 * `ownerThreadId` is passed through as the host reported it. The app marks a
 * thread only when the owner is that thread and the port is in that thread's
 * own workspace, which is the check the thread listing used to make here.
 */
export function createPortDiscovery(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: portScanContract });
  const controller = new AbortController();
  bb.onDispose(() => controller.abort());
  const cache = new Map<string, { ports: OpenPort[]; at: number }>();
  const pending = new Map<string, Promise<ReadonlyMap<string, OpenPort[]>>>();
  let generation = 0;
  const failures = new Map<string, { attempts: number; retryAt: number }>();

  async function scan(environmentIds: readonly string[]): Promise<ReadonlyMap<string, OpenPort[]>> {
    const found = new Map(environmentIds.map((id) => [id, [] as OpenPort[]]));
    // One bulk status read instead of one get per environment: thread rows keep a stale path during teardown.
    const ready = new Map<string, { path: string; hostId: string }>();
    for (let offset = 0; ; offset += 500) {
      const page = await bb.sdk.environments.list({ status: "ready", limit: 500, offset, signal: controller.signal });
      for (const env of page)
        if (env.status === "ready" && env.path) ready.set(env.id, { path: env.path, hostId: env.hostId });
      if (page.length < 500) break;
    }
    const byHost = new Map<string, PortRoot[]>();
    for (const environmentId of environmentIds) {
      const env = ready.get(environmentId);
      if (!env) continue;
      byHost.set(env.hostId, [...(byHost.get(env.hostId) ?? []), { environmentId, path: env.path }]);
    }
    // A listener belongs to the deepest workspace that contains it. A ready
    // workspace nested inside a requested one keeps its own listeners even
    // when nobody asked for it, so they are not moved up to the parent. The
    // nesting is judged on bb's paths; the host compares resolved paths.
    for (const [environmentId, env] of ready) {
      const roots = byHost.get(env.hostId);
      if (found.has(environmentId) || !roots?.some((root) => isNestedUnder(env.path, root.path))) continue;
      roots.push({ environmentId, path: env.path });
    }
    const now = Date.now();
    for (const [hostId, failure] of failures) if (failure.retryAt + FAILURE_MEMORY_MS < now) failures.delete(hostId);
    await forEachConcurrent([...byHost], 4, async ([hostId, roots]) => {
      controller.signal.throwIfAborted();
      if (Date.now() < (failures.get(hostId)?.retryAt ?? 0)) return;
      try {
        const result = await host.call(
          "scan",
          { roots },
          {
            hostId,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
          },
        );
        failures.delete(hostId);
        for (const { environmentId: owner, ...port } of result.ports) found.get(owner)?.push(port);
      } catch (error) {
        controller.signal.throwIfAborted();
        const attempts = Math.min((failures.get(hostId)?.attempts ?? 0) + 1, 5);
        failures.set(hostId, { attempts, retryAt: Date.now() + Math.min(30_000 * 2 ** (attempts - 1), 300_000) });
        bb.log.debug(`Port scan failed on ${hostId}: ${String(error)}`);
      }
    });
    return found;
  }

  const discover = async ({ environmentIds }: { environmentIds: readonly string[] }): Promise<PortSnapshot> => {
    controller.signal.throwIfAborted();
    const now = Date.now();
    for (const [id, entry] of cache) if (now - entry.at >= CACHE_MS) cache.delete(id);
    const wanted = [...new Set(environmentIds)];
    const missing = wanted.filter((id) => !cache.has(id) && !pending.has(id));
    if (missing.length) {
      const scanGeneration = generation;
      const run = scan(missing)
        .then((found) => {
          // A scan that started before an invalidation answers its callers but is not reused.
          if (scanGeneration === generation) {
            const at = Date.now();
            for (const [id, ports] of found) cache.set(id, { ports, at });
          }
          return found;
        })
        .finally(() => {
          for (const id of missing) if (pending.get(id) === run) pending.delete(id);
        });
      for (const id of missing) pending.set(id, run);
    }
    // Awaited together, so a joined scan that fails cannot leave this call's own scan unobserved.
    const found = await Promise.all(
      wanted.map(async (id) => cache.get(id)?.ports ?? (await pending.get(id)!).get(id) ?? []),
    );
    return {
      groups: wanted.flatMap((environmentId, index) =>
        found[index]!.length ? [{ environmentId, ports: found[index]! }] : [],
      ),
    };
  };
  return Object.assign(discover, {
    invalidate() {
      generation++;
      cache.clear();
    },
  });
}
