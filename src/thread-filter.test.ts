import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { idleSidebarThreadFields } from "./test-fixtures";
import {
  EMPTY_FILTER,
  extractCompletedTokens,
  filterThreads,
  fuzzyScore,
  hostNames,
  keywordOf,
  rememberRecent,
  suggestionsFor,
  toggleIsValue,
  type ThreadFacts,
  type ThreadFilter,
} from "./thread-filter";

function thread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    ...idleSidebarThreadFields,
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

const projects = [
  { id: "proj_ik", name: "influencekit" },
  { id: "proj_ol", name: "offerlab" },
  { id: "proj_ol2", name: "offerlab-docs" },
];
const hosts = ["ivo", "mona"];
const noFacts = () => ({ needsYou: false, working: false });
const filterOf = (overrides: Partial<ThreadFilter>): ThreadFilter => ({ ...EMPTY_FILTER, ...overrides });

describe("suggestionsFor", () => {
  it("finds a project from a bracket prefix", () => {
    const names = suggestionsFor("[infl", { projects, hosts, scope: [], filter: EMPTY_FILTER }).map((s) =>
      s.kind === "project" ? s.name : null,
    );
    expect(names).toEqual(["influencekit"]);
  });

  it("searches every group for a bare word", () => {
    const kinds = suggestionsFor("snoo", { projects, hosts, scope: [], filter: EMPTY_FILTER }).map((s) => s.kind);
    expect(kinds).toEqual(["is"]);
    const mona = suggestionsFor("mo", { projects, hosts, scope: [], filter: EMPTY_FILTER });
    expect(mona).toEqual([{ kind: "host", name: "mona", selected: false }]);
  });

  it("resolves an alias to its is: value", () => {
    const values = suggestionsFor("is:waiting", { projects, hosts, scope: [], filter: EMPTY_FILTER }).map((s) =>
      s.kind === "is" ? s.value : null,
    );
    expect(values[0]).toBe("needs-you");
  });

  it("marks what is already selected", () => {
    const [first] = suggestionsFor("[offerlab", { projects, hosts, scope: ["proj_ol"], filter: EMPTY_FILTER });
    expect(first).toMatchObject({ id: "proj_ol", selected: true });
  });
});

describe("fuzzy matching", () => {
  it("matches letters in order, not only prefixes", () => {
    expect(fuzzyScore("offerlab", "ofl")).toBeGreaterThan(0);
    expect(fuzzyScore("offerlab", "lfo")).toBe(-1);
    const names = suggestionsFor("[ofl", { projects, hosts, scope: [], filter: EMPTY_FILTER }).map((s) =>
      s.kind === "project" ? s.name : null,
    );
    expect(names).toEqual(["offerlab", "offerlab-docs"]);
  });

  it("ranks word starts above scattered letters", () => {
    const names = suggestionsFor("[od", { projects, hosts, scope: [], filter: EMPTY_FILTER }).map((s) =>
      s.kind === "project" ? s.name : null,
    );
    expect(names[0]).toBe("offerlab-docs");
  });
});

describe("recents", () => {
  const recents = ["host:mona", "project:proj_ol", "is:snoozed"];

  it("leads an empty dropdown with recent picks, without repeating them", () => {
    const all = suggestionsFor("", { projects, hosts, scope: [], filter: EMPTY_FILTER, recents });
    expect(all.slice(0, 3)).toMatchObject([
      { kind: "host", name: "mona", recent: true },
      { kind: "project", id: "proj_ol", recent: true },
      { kind: "is", value: "snoozed", recent: true },
    ]);
    expect(all.filter((s) => s.kind === "host" && s.name === "mona")).toHaveLength(1);
  });

  it("keeps only the matching kind after a sigil, and drops recents once typing starts", () => {
    const bracket = suggestionsFor("[", { projects, hosts, scope: [], filter: EMPTY_FILTER, recents });
    expect(bracket[0]).toMatchObject({ id: "proj_ol", recent: true });
    const typed = suggestionsFor("[o", { projects, hosts, scope: [], filter: EMPTY_FILTER, recents });
    expect(typed.some((s) => s.recent)).toBe(false);
  });

  it("moves a reused pick to the front and caps the list", () => {
    expect(rememberRecent(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    const many = Array.from({ length: 20 }, (_, i) => `k${i}`);
    expect(rememberRecent(many, "new")).toHaveLength(8);
  });
});

describe("extractCompletedTokens", () => {
  it("turns pasted finished tokens into selections and leaves the rest", () => {
    const parsed = extractCompletedTokens("[influencekit] @mona is:snoozed deploy [off", { projects, hosts });
    expect(parsed).toEqual({ projects: ["proj_ik"], hosts: ["mona"], isValues: ["snoozed"], rest: "deploy [off" });
  });

  it("leaves an ambiguous project as text", () => {
    expect(extractCompletedTokens("[offer] ", { projects, hosts }).projects).toEqual([]);
    expect(extractCompletedTokens("[offerlab] ", { projects, hosts }).projects).toEqual(["proj_ol"]);
  });
});

describe("keywordOf", () => {
  it("ignores half-typed tokens", () => {
    expect(keywordOf("Deploy [infl @mo is:sn")).toBe("deploy");
  });
});

describe("filterThreads", () => {
  const threads = [
    thread({ id: "a", displayTitle: "Deploy fix", host: { id: "h1", name: "mona" }, isUnread: true }),
    thread({ id: "b", displayTitle: "Refactor", host: { id: "h2", name: "ivo" }, indicator: "unread-error" }),
    thread({ id: "c", displayTitle: "Deploy docs", host: null }),
  ];
  const ids = (filter: ThreadFilter, facts: (thread: PluginSidebarThread) => ThreadFacts = noFacts) =>
    filterThreads(threads, filter, facts).map((t) => t.id);

  it("keeps everything for an empty filter", () => {
    expect(ids(EMPTY_FILTER)).toEqual(["a", "b", "c"]);
  });

  it("ORs machines and ANDs them with the keyword", () => {
    expect(ids(filterOf({ hosts: ["mona", "ivo"] }))).toEqual(["a", "b"]);
    expect(ids(filterOf({ hosts: ["mona", "ivo"], keyword: "deploy" }))).toEqual(["a"]);
  });

  it("ORs states", () => {
    expect(ids(filterOf({ states: ["unread", "failed"] }))).toEqual(["a", "b"]);
    expect(ids(filterOf({ states: ["needs-you"] }), (t) => ({ needsYou: t.id === "c", working: false }))).toEqual([
      "c",
    ]);
  });
});

describe("hostNames", () => {
  it("lists each machine once, sorted", () => {
    const threads = [
      thread({ host: { id: "2", name: "mona" } }),
      thread({ host: { id: "1", name: "ivo" } }),
      thread({ host: { id: "2", name: "mona" } }),
    ];
    expect(hostNames(threads)).toEqual(["ivo", "mona"]);
  });
});

describe("toggleIsValue", () => {
  it("files shelves and states separately", () => {
    const filter = toggleIsValue(toggleIsValue(EMPTY_FILTER, "snoozed"), "needs-you");
    expect(filter).toMatchObject({ shelves: ["snoozed"], states: ["needs-you"] });
    expect(toggleIsValue(filter, "snoozed").shelves).toEqual([]);
  });
});
