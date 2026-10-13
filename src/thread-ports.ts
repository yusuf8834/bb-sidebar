import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { portScanContract } from "./port-scan-contract";
import type { OwnedPortTarget, PortCloseScope } from "./contract";

export function createThreadPortActions(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: portScanContract });
  const controller = new AbortController();
  bb.onDispose(() => controller.abort());
  async function context(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return null;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.status !== "ready" || !environment.path) throw new Error("Thread workspace is unavailable");
    return {
      root: { environmentId: environment.id, path: environment.path },
      workspace: { environmentId: environment.id, hostId: environment.hostId, path: environment.path },
      options: {
        hostId: environment.hostId,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      },
    };
  }
  return {
    async getThreadWorkspace({ threadId }: { threadId: string }) {
      return (await context(threadId))?.workspace ?? null;
    },
    async canonicalWorkspacePaths(threads: readonly PortThread[]) {
      const byHost = new Map<string, PortThread[]>();
      for (const thread of threads) {
        if (!thread.environmentHostId || !thread.environmentId || !thread.environmentPath) continue;
        byHost.set(thread.environmentHostId, [...(byHost.get(thread.environmentHostId) ?? []), thread]);
      }
      const paths = new Map<string, string>();
      const failedHosts = new Set<string>();
      await Promise.all(
        [...byHost].map(async ([hostId, hostThreads]) => {
          try {
            const roots = [
              ...new Map(
                hostThreads.map((thread) => [
                  thread.environmentId!,
                  {
                    environmentId: thread.environmentId!,
                    path: thread.environmentPath!,
                  },
                ]),
              ).values(),
            ];
            const result = await host.call(
              "resolveRoots",
              { roots },
              {
                hostId,
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
              },
            );
            for (const root of result.roots) if (root.path) paths.set(root.environmentId, root.path);
          } catch {
            controller.signal.throwIfAborted();
            failedHosts.add(hostId);
          }
        }),
      );
      return { paths, failedHosts };
    },
    async getThreadPorts({ threadId }: { threadId: string }) {
      const target = await context(threadId);
      if (!target) return { ports: [], workspace: null };
      const result = await host.call("scan", { roots: [target.root] }, target.options);
      return {
        ports: result.ports
          .filter(
            (port) =>
              port.environmentId === target.root.environmentId &&
              port.ownerThreadId === threadId &&
              port.source === "process" &&
              port.pid &&
              port.pid > 1,
          )
          .map((port) => ({
            port: port.port,
            pid: port.pid!,
            ...(port.processStartedAt ? { processStartedAt: port.processStartedAt } : {}),
          })),
        workspace: target.workspace,
      };
    },
    async closeThreadPorts({
      threadId,
      ports,
      scope = "thread",
      expectedWorkspace,
    }: {
      threadId: string;
      ports: OwnedPortTarget[];
      scope?: PortCloseScope;
      expectedWorkspace?: { environmentId: string; hostId: string; path: string };
    }) {
      const target = await context(threadId);
      if (!target) throw new Error("Thread has no workspace");
      if (
        expectedWorkspace &&
        (target.workspace.environmentId !== expectedWorkspace.environmentId ||
          target.workspace.hostId !== expectedWorkspace.hostId ||
          target.workspace.path !== expectedWorkspace.path)
      ) {
        throw new Error("Thread workspace changed since preview");
      }
      return host.call("closeOwnedPorts", { root: target.root, threadId, ports, scope }, target.options);
    },
    /**
     * Which of `candidates` may still be serving a port: a process listening
     * in its workspace that it owns, or that no thread owns in a workspace
     * only it uses (ownership is read from the process environment, which can
     * fail). One scan per host. A host that cannot be scanned puts all its
     * candidates in the result, because no answer is not "none". A candidate
     * without a workspace path serves nothing.
     */
    async threadsServingPorts(
      candidates: readonly PortThread[],
      everyThread: readonly PortThread[],
    ): Promise<Set<string>> {
      const threadsPerEnvironment = new Map<string, number>();
      for (const { environmentId } of everyThread) {
        if (environmentId)
          threadsPerEnvironment.set(environmentId, (threadsPerEnvironment.get(environmentId) ?? 0) + 1);
      }
      const byHost = new Map<string, PortThread[]>();
      for (const thread of candidates) {
        if (!thread.environmentId || !thread.environmentPath || !thread.environmentHostId) continue;
        byHost.set(thread.environmentHostId, [...(byHost.get(thread.environmentHostId) ?? []), thread]);
      }
      const serving = new Set<string>();
      await Promise.all(
        [...byHost].map(async ([hostId, threads]) => {
          try {
            const roots = [
              ...new Map(
                threads.map((thread) => [
                  thread.environmentId!,
                  { environmentId: thread.environmentId!, path: thread.environmentPath! },
                ]),
              ).values(),
            ];
            const { ports } = await host.call(
              "scan",
              { roots },
              {
                hostId,
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
              },
            );
            for (const thread of threads) {
              const servesPort = ports.some(
                (port) =>
                  port.environmentId === thread.environmentId &&
                  port.source === "process" &&
                  (port.ownerThreadId === thread.id ||
                    (port.ownerThreadId === undefined && threadsPerEnvironment.get(thread.environmentId!) === 1)),
              );
              if (servesPort) serving.add(thread.id);
            }
          } catch {
            controller.signal.throwIfAborted();
            for (const thread of threads) serving.add(thread.id);
          }
        }),
      );
      return serving;
    },
  };
}

/** The workspace fields of a bb project-thread row. */
interface PortThread {
  id: string;
  environmentId: string | null;
  environmentPath: string | null;
  environmentHostId: string | null;
}
