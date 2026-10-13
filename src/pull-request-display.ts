import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import type { ThreadPullRequest } from "./contract";

/**
 * A PR as the sidebar draws it. Only the live branch PR from bb carries
 * `attention`; PRs found in the thread's history have just a state, and none
 * when `gh` could not look them up.
 */
type DisplayPullRequest = {
  number: number;
  title: string | null;
  url: string;
  state: PluginSidebarPullRequest["state"] | null;
  attention?: PluginSidebarPullRequest["attention"];
};

export function pullRequestStatusLabel(pullRequest: DisplayPullRequest): string {
  switch (pullRequest.attention) {
    case "blocked":
      return "Blocked";
    case "changes_requested":
      return "Changes requested";
    case "checks_failed":
      return "Checks failed";
    case "checks_pending":
      return "Checks pending";
    case "conflicts":
      return "Conflicts";
    case "ready_to_merge":
      return "Ready to merge";
    case "queued":
      return "In merge queue";
    case "review_requested":
      return "Review requested";
    case "draft":
      return "Draft";
    case "merged":
      return "Merged";
    case "closed":
      return "Closed";
    case "none":
    case undefined:
      if (!pullRequest.state) return "Status unavailable";
      return pullRequest.state[0]!.toUpperCase() + pullRequest.state.slice(1);
  }
}

export function pullRequestToneClass(pullRequest: DisplayPullRequest): string {
  if (pullRequest.state === "merged" || pullRequest.attention === "merged") {
    return "text-[color:var(--bb-sidebar-pr-merged)]";
  }
  if (
    pullRequest.attention === "blocked" ||
    pullRequest.attention === "changes_requested" ||
    pullRequest.attention === "checks_failed" ||
    pullRequest.attention === "conflicts"
  ) {
    return "text-[color:var(--bb-sidebar-pr-alert)]";
  }
  if (pullRequest.state === "draft" || pullRequest.attention === "draft") {
    return "text-muted-foreground/60";
  }
  if (pullRequest.state === "closed" || pullRequest.attention === "closed") {
    return "text-[color:var(--bb-sidebar-pr-alert)]";
  }
  if (pullRequest.state === "open") {
    return "text-[color:var(--bb-sidebar-pr-open)]";
  }
  return "text-muted-foreground";
}

/**
 * The thread's PRs newest first. The live branch PR from bb has the richer
 * status, so it replaces its history entry. bb reports it per workspace, so in
 * a shared checkout it may belong to another thread; it leads the list only
 * when the workspace is the thread's own worktree (a PR opened outside
 * `gh pr create`).
 */
export function mergeThreadPullRequests(
  current: PluginSidebarPullRequest | null,
  history: readonly ThreadPullRequest[],
  ownsWorkspace: boolean,
): DisplayPullRequest[] {
  if (!current) return [...history];
  if (!history.some((pullRequest) => pullRequest.url === current.url)) {
    return ownsWorkspace ? [current, ...history] : [...history];
  }
  return history.map((pullRequest) => (pullRequest.url === current.url ? current : pullRequest));
}
