import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

/**
 * The filter bar's grammar, borrowed from TaskYou so the same fingers work in
 * both:
 *
 *   [project]   projects, OR'd (stored as the project scope)
 *   @machine    the machine a thread runs on, OR'd
 *   is:value    a thread state or a shelf; states OR together, shelves OR
 *               together, and the two groups AND
 *   other text  a title keyword
 *
 * Every group ANDs with the others, so "[offerlab] @mona is:needs-you" is the
 * OfferLab threads on mona that are waiting for you.
 */

export const THREAD_STATES = ["needs-you", "working", "unread", "failed"] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

export const SHELVES = ["pinned", "active", "inactive", "snoozed", "parked", "settled"] as const;
export type Shelf = (typeof SHELVES)[number];

export type IsValue = ThreadState | Shelf;

const IS_VALUES: readonly { value: IsValue; label: string; kind: "state" | "shelf" }[] = [
  { value: "needs-you", label: "Needs you: a question, approval, or error", kind: "state" },
  { value: "working", label: "Working, or has work running under it", kind: "state" },
  { value: "unread", label: "Unread", kind: "state" },
  { value: "failed", label: "Failed", kind: "state" },
  { value: "pinned", label: "Pinned shelf", kind: "shelf" },
  { value: "active", label: "Active shelf", kind: "shelf" },
  { value: "inactive", label: "Inactive shelf", kind: "shelf" },
  { value: "snoozed", label: "Snoozed shelf", kind: "shelf" },
  { value: "parked", label: "Parked shelf", kind: "shelf" },
  { value: "settled", label: "Settled shelf", kind: "shelf" },
];

/** Words people reach for that mean an `is:` value. */
const IS_ALIASES: Record<string, IsValue> = {
  attention: "needs-you",
  needs: "needs-you",
  waiting: "needs-you",
  running: "working",
  busy: "working",
  new: "unread",
  error: "failed",
  errored: "failed",
  pin: "pinned",
  snooze: "snoozed",
  park: "parked",
  settle: "settled",
  done: "settled",
};

export interface ThreadFilter {
  /** Lowercased machine names. */
  hosts: string[];
  states: ThreadState[];
  shelves: Shelf[];
  keyword: string;
}

export const EMPTY_FILTER: ThreadFilter = { hosts: [], states: [], shelves: [], keyword: "" };

/** True for a word that starts a [project], @machine, or is:value token. */
function isSigilWord(word: string): boolean {
  return /^(\[|@|is:|status:)/i.test(word);
}

/**
 * The title keyword in the bar's text. Half-typed tokens are left out, so the
 * list does not empty while "[infl" is still on its way to [influencekit].
 */
export function keywordOf(text: string): string {
  return text
    .split(" ")
    .filter((word) => word.length > 0 && !isSigilWord(word))
    .join(" ")
    .toLowerCase();
}

function isShelf(value: IsValue): value is Shelf {
  return (SHELVES as readonly string[]).includes(value);
}

function resolveIsValue(raw: string): IsValue | null {
  const value = raw.trim().toLowerCase();
  if (IS_VALUES.some((entry) => entry.value === value)) return value as IsValue;
  return IS_ALIASES[value] ?? null;
}

/** Adds an `is:` value to the matching group, or removes it when present. */
export function toggleIsValue(filter: ThreadFilter, value: IsValue): ThreadFilter {
  if (isShelf(value)) {
    const shelves = filter.shelves.includes(value)
      ? filter.shelves.filter((shelf) => shelf !== value)
      : [...filter.shelves, value];
    return { ...filter, shelves };
  }
  const states = filter.states.includes(value)
    ? filter.states.filter((state) => state !== value)
    : [...filter.states, value];
  return { ...filter, states };
}

export function toggleHost(filter: ThreadFilter, host: string): ThreadFilter {
  const name = host.toLowerCase();
  const hosts = filter.hosts.includes(name) ? filter.hosts.filter((entry) => entry !== name) : [...filter.hosts, name];
  return { ...filter, hosts };
}

export interface ThreadFacts {
  needsYou: boolean;
  working: boolean;
}

/** Keeps the threads that pass the machine, state, and keyword predicates. */
export function filterThreads(
  threads: readonly PluginSidebarThread[],
  filter: ThreadFilter,
  factsFor: (thread: PluginSidebarThread) => ThreadFacts,
): PluginSidebarThread[] {
  const keyword = keywordOf(filter.keyword);
  if (filter.hosts.length === 0 && filter.states.length === 0 && keyword.length === 0) return [...threads];
  return threads.filter((thread) => {
    if (filter.hosts.length > 0 && !filter.hosts.includes(thread.host?.name.toLowerCase() ?? "")) return false;
    if (keyword.length > 0 && !thread.displayTitle.toLowerCase().includes(keyword)) return false;
    if (filter.states.length === 0) return true;
    const facts = factsFor(thread);
    return filter.states.some((state) => threadHasState(thread, state, facts));
  });
}

function threadHasState(thread: PluginSidebarThread, state: ThreadState, facts: ThreadFacts): boolean {
  switch (state) {
    case "needs-you":
      return facts.needsYou;
    case "working":
      return facts.working;
    case "unread":
      return thread.isUnread;
    case "failed":
      return thread.indicator === "unread-error" || thread.queuedWork === "failed" || thread.runtimeStatus === "error";
  }
}

export function hostNames(threads: readonly PluginSidebarThread[]): string[] {
  const names = new Set<string>();
  for (const thread of threads) if (thread.host?.name) names.add(thread.host.name);
  return [...names].sort((left, right) => left.localeCompare(right));
}

export type Suggestion = (
  | { kind: "project"; id: string; name: string; selected: boolean }
  | { kind: "host"; name: string; selected: boolean }
  | { kind: "is"; value: IsValue; label: string; selected: boolean }
) & { recent?: boolean };

interface SuggestionSources {
  projects: readonly { id: string; name: string }[];
  hosts: readonly string[];
  scope: readonly string[];
  filter: ThreadFilter;
  /** Suggestion keys, most recently used first. */
  recents?: readonly string[];
}

/** Stable identity for a suggestion; also what the recents list stores. */
export function suggestionKey(suggestion: Suggestion): string {
  if (suggestion.kind === "project") return `project:${suggestion.id}`;
  if (suggestion.kind === "host") return `host:${suggestion.name.toLowerCase()}`;
  return `is:${suggestion.value}`;
}

const MAX_RECENTS = 8;

/** Moves a key to the front of the recents list. */
export function rememberRecent(recents: readonly string[], key: string): string[] {
  return [key, ...recents.filter((entry) => entry !== key)].slice(0, MAX_RECENTS);
}

/** The token under the caret: everything after the last space. */
export function currentToken(text: string): string {
  const index = text.lastIndexOf(" ");
  return index < 0 ? text : text.slice(index + 1);
}

/**
 * Suggestions for the token being typed. A sigil narrows to one group; a bare
 * word searches every group, so "infl" finds [influencekit] and "snoo" finds
 * is:snoozed without remembering which prefix they live under.
 */
export function suggestionsFor(token: string, sources: SuggestionSources): Suggestion[] {
  const lower = token.toLowerCase();
  const isMatch = /^(is|status):(.*)$/.exec(lower);
  let query = lower;
  let list: Suggestion[];
  if (lower.startsWith("[")) {
    query = lower.slice(1).replace(/]$/, "");
    list = projectSuggestions(query, sources);
  } else if (lower.startsWith("@")) {
    query = lower.slice(1);
    list = hostSuggestions(query, sources);
  } else if (isMatch) {
    query = isMatch[2] ?? "";
    list = isSuggestions(query, sources);
  } else {
    list = [
      ...isSuggestions(lower, sources),
      ...hostSuggestions(lower, sources),
      ...projectSuggestions(lower, sources),
    ];
  }
  return query.length === 0 ? withRecentsFirst(list, sources.recents ?? []) : list;
}

/**
 * Before anything is typed, the dropdown leads with what was used last, so
 * the usual filters are one arrow away.
 */
function withRecentsFirst(list: readonly Suggestion[], recents: readonly string[]): Suggestion[] {
  const byKey = new Map(list.map((suggestion) => [suggestionKey(suggestion), suggestion]));
  const recent = recents.flatMap((key) => {
    const suggestion = byKey.get(key);
    return suggestion ? [{ ...suggestion, recent: true }] : [];
  });
  const recentKeys = new Set(recent.map(suggestionKey));
  return [...recent, ...list.filter((suggestion) => !recentKeys.has(suggestionKey(suggestion)))];
}

/**
 * TaskYou's VS Code-style fuzzy score: every query character must appear in
 * order, and matches at word starts, in runs, and near the front score
 * higher. "ofl" finds offerlab; -1 means no match.
 */
export function fuzzyScore(name: string, query: string): number {
  if (query.length === 0) return 0;
  const lower = name.toLowerCase();
  const pattern = query.toLowerCase();
  let score = 100;
  let patternIndex = 0;
  let previous = -1;
  let first = -1;
  for (let index = 0; index < lower.length && patternIndex < pattern.length; index++) {
    if (lower[index] !== pattern[patternIndex]) continue;
    if (first < 0) first = index;
    if (isWordStart(name, index)) score += 50;
    if (previous >= 0 && index === previous + 1) score += 40;
    if (index === 0) score += 25;
    if (index > 0 && /[a-z]/.test(name[index - 1] ?? "") && /[A-Z]/.test(name[index] ?? "")) score += 45;
    if (previous >= 0 && index > previous + 1) score -= 3 * (index - previous - 1);
    previous = index;
    patternIndex++;
  }
  if (patternIndex < pattern.length) return -1;
  return score + Math.max(-15, -5 * first);
}

function isWordStart(name: string, index: number): boolean {
  if (index === 0) return true;
  const previous = name[index - 1] ?? "";
  return /[\s_\-/.:]/.test(previous) || (/[0-9]/.test(previous) && /[a-z]/i.test(name[index] ?? ""));
}

function byRank<T>(items: readonly T[], nameOf: (item: T) => string, query: string): T[] {
  return items
    .map((item) => ({ item, score: fuzzyScore(nameOf(item), query) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item);
}

function projectSuggestions(query: string, { projects, scope }: SuggestionSources): Suggestion[] {
  return byRank(projects, (project) => project.name, query).map((project) => ({
    kind: "project",
    id: project.id,
    name: project.name,
    selected: scope.includes(project.id),
  }));
}

function hostSuggestions(query: string, { hosts, filter }: SuggestionSources): Suggestion[] {
  return byRank(hosts, (host) => host, query).map((name) => ({
    kind: "host",
    name,
    selected: filter.hosts.includes(name.toLowerCase()),
  }));
}

function isSuggestions(query: string, { filter }: SuggestionSources): Suggestion[] {
  const alias = IS_ALIASES[query];
  const matches = byRank(IS_VALUES, (entry) => entry.value, query);
  const aliased =
    alias && !matches.some((entry) => entry.value === alias) ? IS_VALUES.filter((e) => e.value === alias) : [];
  return [...aliased, ...matches].map((entry) => ({
    kind: "is",
    value: entry.value,
    label: entry.label,
    selected: filter.states.includes(entry.value as ThreadState) || filter.shelves.includes(entry.value as Shelf),
  }));
}

interface ParsedText {
  projects: string[];
  hosts: string[];
  isValues: IsValue[];
  rest: string;
}

/**
 * Pulls finished tokens ("[offerlab] ", "@mona ", "is:snoozed ") out of typed
 * or pasted text. A token resolves only when it names exactly one thing;
 * anything else stays as text.
 */
export function extractCompletedTokens(
  text: string,
  sources: Pick<SuggestionSources, "projects" | "hosts">,
): ParsedText {
  const parsed: ParsedText = { projects: [], hosts: [], isValues: [], rest: "" };
  // The last word is still being typed unless the text ends in a space.
  const words = text.split(" ");
  const trailing = words.pop() ?? "";
  const kept: string[] = [];
  for (const word of words) {
    const lower = word.toLowerCase();
    const project = /^\[(.+)]$/.exec(lower);
    const host = /^@(.+)$/.exec(lower);
    const is = /^(?:is|status):(.+)$/.exec(lower);
    if (project) {
      const match = uniqueMatch(sources.projects, (p) => p.name.toLowerCase(), project[1] ?? "");
      if (match) {
        parsed.projects.push(match.id);
        continue;
      }
    } else if (host) {
      const match = uniqueMatch(sources.hosts, (h) => h.toLowerCase(), host[1] ?? "");
      if (match) {
        parsed.hosts.push(match);
        continue;
      }
    } else if (is) {
      const value = resolveIsValue(is[1] ?? "");
      if (value) {
        parsed.isValues.push(value);
        continue;
      }
    }
    kept.push(word);
  }
  parsed.rest = [...kept, trailing].join(" ");
  return parsed;
}

function uniqueMatch<T>(items: readonly T[], nameOf: (item: T) => string, query: string): T | null {
  const exact = items.filter((item) => nameOf(item) === query);
  if (exact.length === 1) return exact[0] ?? null;
  const prefixed = items.filter((item) => nameOf(item).startsWith(query));
  return prefixed.length === 1 ? (prefixed[0] ?? null) : null;
}
