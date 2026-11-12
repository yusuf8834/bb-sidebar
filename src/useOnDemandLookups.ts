import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** A looked-up result shows on its row for this long, then needs another look. */
export const ON_DEMAND_TTL_MS = 5 * 60_000;
/** Opening the card again within this window reuses the last answer. */
const REUSE_MS = 30_000;

/**
 * Lookups for things the recurring polls skip (settled threads), run when the
 * user looks at one. One request per key at a time; a result is reused for
 * 30s and dropped after `ON_DEMAND_TTL_MS`, or as soon as its key leaves
 * `eligible` (deleted, archived, or no longer settled), so a stale result
 * cannot sit on a row. `forget` drops keys at once, answers in flight included,
 * after the thing they describe changed (ports closed), and returns the keys
 * that had anything to drop.
 */
export function useOnDemandLookups<T>(
  fetch: (key: string) => Promise<T>,
  eligible: ReadonlySet<string>,
): {
  values: ReadonlyMap<string, T>;
  lookUp: (key: string, force?: boolean) => void;
  forget: (keys: readonly string[]) => string[];
} {
  const [entries, setEntries] = useState<ReadonlyMap<string, { value: T; at: number }>>(new Map());
  // Each look's own token: a forgotten one cannot store or clear a newer look.
  const inFlight = useRef(new Map<string, object>());
  const latest = useRef({ entries, eligible, fetch });
  latest.current = { entries, eligible, fetch };

  const lookUp = useCallback((key: string, force = false) => {
    const { entries, eligible, fetch } = latest.current;
    if (!eligible.has(key) || inFlight.current.has(key)) return;
    const entry = entries.get(key);
    if (!force && entry && Date.now() - entry.at < REUSE_MS) return;
    const token = {};
    inFlight.current.set(key, token);
    fetch(key)
      .then(
        (value) => {
          if (inFlight.current.get(key) === token && latest.current.eligible.has(key))
            setEntries((previous) => new Map(previous).set(key, { value, at: Date.now() }));
        },
        () => {
          void 0; // A failed look leaves the row as it was; the next look retries.
        },
      )
      .finally(() => {
        if (inFlight.current.get(key) === token) inFlight.current.delete(key);
      });
  }, []);

  const forget = useCallback((keys: readonly string[]) => {
    const dropped = keys.filter((key) => latest.current.entries.has(key) || inFlight.current.has(key));
    if (dropped.length === 0) return dropped;
    for (const key of dropped) inFlight.current.delete(key);
    setEntries((previous) => {
      const next = new Map(previous);
      for (const key of dropped) next.delete(key);
      return next;
    });
    return dropped;
  }, []);

  useEffect(() => {
    if (entries.size === 0) return;
    const prune = () =>
      setEntries((previous) => {
        const now = Date.now();
        const next = new Map(
          [...previous].filter(([key, entry]) => eligible.has(key) && now - entry.at < ON_DEMAND_TTL_MS),
        );
        return next.size === previous.size ? previous : next;
      });
    if ([...entries.keys()].some((key) => !eligible.has(key))) prune();
    const oldest = Math.min(...[...entries.values()].map((entry) => entry.at));
    const timer = setTimeout(prune, Math.max(0, oldest + ON_DEMAND_TTL_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [entries, eligible]);

  const values = useMemo(
    () => new Map([...entries].filter(([key]) => eligible.has(key)).map(([key, entry]) => [key, entry.value])),
    [entries, eligible],
  );
  return { values, lookUp, forget };
}
