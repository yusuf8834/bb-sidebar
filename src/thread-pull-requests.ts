// Every pull request a thread opened, not just the one on its current branch.
//
// GitHub PR Status only reports the PR for an environment's checked-out
// branch, so a thread that ships several branches in a row shows only the
// latest. The thread's own event log still has the rest: each `gh pr create`
// prints the PR URL. This module finds those URLs and asks the thread's host
// for their status via `gh`.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { portScanContract } from "./port-scan-contract";
import { createdPullRequestUrls, pullRequestNumber } from "./pull-requests";
import type { ThreadPullRequest } from "./contract";

// bb rejects event pages larger than 100.
const EVENT_PAGE_SIZE = 100;
const OPEN_STATUS_TTL_MS = 60_000;

export function createThreadPullRequests(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: portScanContract });
  const controller = new AbortController();
  bb.onDispose(() => controller.abort());
  // Event logs only grow, so each thread is scanned once and then from its
  // last seen sequence.
  const scans = new Map<string, { afterSeq: number | null; urls: string[] }>();
  const pendingScans = new Map<string, Promise<string[]>>();
  // Merged and closed PRs never change; open ones are rechecked after a minute.
  const statuses = new Map<string, { value: ThreadPullRequest; expiresAt: number }>();

  async function scan(threadId: string) {
    const previous = scans.get(threadId) ?? { afterSeq: null, urls: [] };
    const urls = new Set(previous.urls);
    let afterSeq = previous.afterSeq;
    for (;;) {
      const page = await bb.sdk.threads.events.list({
        threadId,
        types: ["item/completed"],
        order: "asc",
        limit: String(EVENT_PAGE_SIZE),
        ...(afterSeq === null ? {} : { afterSeq: String(afterSeq) }),
        signal: controller.signal,
      });
      for (const url of createdPullRequestUrls(page)) urls.add(url);
      if (page.length) afterSeq = page[page.length - 1]!.seq;
      if (page.length < EVENT_PAGE_SIZE) break;
    }
    return { afterSeq, urls: [...urls] };
  }

  function createdUrls(threadId: string): Promise<string[]> {
    const existing = pendingScans.get(threadId);
    if (existing) return existing;
    // forgetThread drops a pending scan, so only the current one may write.
    const pending: Promise<string[]> = scan(threadId)
      .then((next) => {
        if (pendingScans.get(threadId) === pending) scans.set(threadId, next);
        return next.urls;
      })
      .finally(() => {
        if (pendingScans.get(threadId) === pending) pendingScans.delete(threadId);
      });
    pendingScans.set(threadId, pending);
    return pending;
  }

  async function refreshStatuses(threadId: string, urls: readonly string[]) {
    const now = Date.now();
    const stale = urls.filter((url) => (statuses.get(url)?.expiresAt ?? 0) <= now);
    if (!stale.length) return;
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    const { pullRequests } = await host.call(
      "pullRequests",
      { urls: stale },
      {
        hostId: environment.hostId,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      },
    );
    // A thread deleted during the lookup must not leave statuses behind.
    if (!scans.has(threadId)) return;
    const checkedAt = Date.now();
    for (const pullRequest of pullRequests) {
      statuses.set(pullRequest.url, {
        value: pullRequest,
        expiresAt:
          pullRequest.state === "merged" || pullRequest.state === "closed" ? Infinity : checkedAt + OPEN_STATUS_TTL_MS,
      });
    }
  }

  return {
    /** Drops a deleted thread's scan and the statuses no other thread uses. */
    forgetThread(threadId: string) {
      scans.delete(threadId);
      pendingScans.delete(threadId);
      const referenced = new Set([...scans.values()].flatMap((entry) => entry.urls));
      for (const url of statuses.keys()) if (!referenced.has(url)) statuses.delete(url);
    },
    async getThreadPullRequests({ threadId }: { threadId: string }) {
      const urls = await createdUrls(threadId);
      try {
        await refreshStatuses(threadId, urls);
      } catch {
        controller.signal.throwIfAborted();
        // gh missing, signed out, or the host is offline: list numbers only.
      }
      // Newest first, matching how the row badge shows the latest PR.
      const pullRequests = [...urls].reverse().map(
        (url) =>
          statuses.get(url)?.value ?? {
            url,
            number: pullRequestNumber(url),
            title: null,
            state: null,
          },
      );
      return { pullRequests };
    },
  };
}
