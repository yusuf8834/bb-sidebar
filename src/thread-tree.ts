/** The root and all descendants, across projects, with cycles visited once. */
export function threadTreeIds(
  threads: readonly { id: string; parentThreadId: string | null }[],
  rootId: string,
): string[] {
  const children = new Map<string, string[]>();
  for (const thread of threads) {
    if (thread.parentThreadId === null) continue;
    const siblings = children.get(thread.parentThreadId) ?? [];
    siblings.push(thread.id);
    children.set(thread.parentThreadId, siblings);
  }
  const result = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return [...result];
}
