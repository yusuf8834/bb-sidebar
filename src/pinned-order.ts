type DropPlacement = "before" | "after";

/** Move one pinned id relative to another without mutating the source order. */
export function movePinnedId(
  ids: readonly string[],
  movingId: string,
  targetId: string,
  placement: DropPlacement,
): string[] {
  if (movingId === targetId || !ids.includes(movingId) || !ids.includes(targetId)) {
    return [...ids];
  }

  const withoutMoving = ids.filter((id) => id !== movingId);
  const targetIndex = withoutMoving.indexOf(targetId);
  const insertionIndex = placement === "after" ? targetIndex + 1 : targetIndex;
  return [...withoutMoving.slice(0, insertionIndex), movingId, ...withoutMoving.slice(insertionIndex)];
}

/** Move one id by a keyboard-sized step. */
export function movePinnedIdByOffset(ids: readonly string[], movingId: string, offset: -1 | 1): string[] {
  const currentIndex = ids.indexOf(movingId);
  const targetIndex = currentIndex + offset;
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= ids.length) {
    return [...ids];
  }
  return movePinnedId(ids, movingId, ids[targetIndex]!, offset < 0 ? "before" : "after");
}

/** The neighboring ids expected by bb's threads.reorderPinned operation. */
export function pinnedNeighbors(
  ids: readonly string[],
  movingId: string,
): { previousThreadId: string | null; nextThreadId: string | null } {
  const index = ids.indexOf(movingId);
  if (index < 0) {
    return { previousThreadId: null, nextThreadId: null };
  }
  return {
    previousThreadId: ids[index - 1] ?? null,
    nextThreadId: ids[index + 1] ?? null,
  };
}

/** Sort the SDK's project groups by bb's global, binary-ordered pin key. */
export function sortPinnedThreads<T extends { readonly id: string; readonly pinSortKey?: string | null }>(
  threads: readonly T[],
): T[] {
  return [...threads].sort((left, right) => {
    // Older SDKs omit pinSortKey; preserve their incoming order.
    const leftKey = left.pinSortKey;
    const rightKey = right.pinSortKey;
    if (leftKey == null && rightKey == null) return 0;
    if (leftKey == null) return 1;
    if (rightKey == null) return -1;
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** Apply an optimistic or server-confirmed id order to the visible rows. */
export function orderPinnedThreads<T extends { readonly id: string }>(
  threads: readonly T[],
  orderedIds: readonly string[] | null,
): T[] {
  if (orderedIds === null) return [...threads];
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  return [...threads].sort((left, right) => {
    const leftRank = rank.get(left.id);
    const rightRank = rank.get(right.id);
    if (leftRank === undefined && rightRank === undefined) return 0;
    if (leftRank === undefined) return 1;
    if (rightRank === undefined) return -1;
    return leftRank - rightRank;
  });
}

/**
 * Apply plugin-owned inbox order while keeping newly created rows at the top.
 * Rows absent from the durable order retain their incoming (newest-first)
 * order; known rows follow in the saved order.
 */
export function orderInboxThreads<T extends { readonly id: string }>(
  threads: readonly T[],
  orderedIds: readonly string[] | null,
): T[] {
  if (orderedIds === null) return [...threads];
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  return [...threads].sort((left, right) => {
    const leftRank = rank.get(left.id);
    const rightRank = rank.get(right.id);
    if (leftRank === undefined && rightRank === undefined) return 0;
    if (leftRank === undefined) return -1;
    if (rightRank === undefined) return 1;
    return leftRank - rightRank;
  });
}

/**
 * Re-apply a finished move to the order as it stands now, expressed as a move
 * relative to the nearest row that outlived the gesture.
 *
 * Replaying the preview wholesale is not safe. It was built when the drag
 * began, so by the time it lands it can reinstate rows that have since
 * disappeared, ignore rows that have since arrived, and revert reorders made
 * elsewhere while the pointer was down. Only the moved row's position relative
 * to its neighbours is what the user actually asked for; everything else in
 * the preview is incidental.
 */
export function rebaseMovedId(
  currentIds: readonly string[],
  previewIds: readonly string[],
  movingId: string,
): string[] {
  const index = previewIds.indexOf(movingId);
  if (index < 0 || !currentIds.includes(movingId)) return [...currentIds];
  const survives = new Set(currentIds);
  // The row above is what the drop was aimed past, so prefer it; fall forward
  // only when everything above the moved row is gone.
  for (let above = index - 1; above >= 0; above--) {
    const anchor = previewIds[above]!;
    if (anchor !== movingId && survives.has(anchor)) {
      return movePinnedId(currentIds, movingId, anchor, "after");
    }
  }
  for (let below = index + 1; below < previewIds.length; below++) {
    const anchor = previewIds[below]!;
    if (anchor !== movingId && survives.has(anchor)) {
      return movePinnedId(currentIds, movingId, anchor, "before");
    }
  }
  return [...currentIds];
}

/** A run of rows that moves as one: a lone thread, or a project's threads. */
export interface OrderUnit {
  key: string;
  ids: readonly string[];
}

/**
 * Re-apply a finished move of a whole unit to the full order as it stands now.
 *
 * The move is replayed on the live units with {@link rebaseMovedId}, so it
 * lands relative to the nearest unit that outlived the gesture. The units'
 * rows then take back exactly the slots those rows held in the full order,
 * which leaves rows outside the units (other projects' threads under a scope
 * filter) where they were, and packs each unit's rows together.
 */
export function rebaseMovedUnit(
  currentIds: readonly string[],
  liveUnits: readonly OrderUnit[],
  previewKeys: readonly string[],
  movingKey: string,
): string[] {
  const movedKeys = rebaseMovedId(
    liveUnits.map((unit) => unit.key),
    previewKeys,
    movingKey,
  );
  const idsByKey = new Map(liveUnits.map((unit) => [unit.key, unit.ids]));
  const present = new Set(currentIds);
  const expanded = movedKeys.flatMap((key) => idsByKey.get(key) ?? []).filter((id) => present.has(id));
  const slots = new Set(expanded);
  let next = 0;
  return currentIds.map((id) => (slots.has(id) ? expanded[next++]! : id));
}

/**
 * Put the listed rows in the listed order, each taking a slot one of them
 * already held, so every other row keeps its place. A preview of part of a
 * list must not push the rest of it aside.
 */
export function orderSubsetInPlace<T extends { readonly id: string }>(
  threads: readonly T[],
  orderedIds: readonly string[],
): T[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const subset = [...new Set(orderedIds)].filter((id) => byId.has(id));
  const slots = new Set(subset);
  let next = 0;
  return threads.map((thread) => (slots.has(thread.id) ? byId.get(subset[next++]!)! : thread));
}
