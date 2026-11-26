const timing = { duration: 150, easing: "ease-out" };
const MAX_CHANGED_ROWS = 40;

type Position = { top: number; left: number };
type List = { scroller: HTMLElement; positions: Map<HTMLElement, Position> };

/** One geometry pass per inbox commit, followed by transform/opacity writes.
 * Removed rows stay removed: no detached React trees are put back into the DOM.
 */
export function createListAnimationController(enabled = true) {
  const lists = new Map<HTMLElement, List>();
  const running = new Map<HTMLElement, { animation: Animation; top: number; left: number }>();
  let observer: MutationObserver | undefined;
  let resizes: ResizeObserver | undefined;
  let frame: number | undefined;
  let holds = 0;
  let animateNext = true;

  const translations = () =>
    new Map(
      [...running].map(([node, { animation, top, left }]) => {
        const progress = Number(animation.effect?.getComputedTiming().progress ?? 1);
        return [node, { top: top * (1 - progress), left: left * (1 - progress) }];
      }),
    );
  const inheritedTranslation = (node: HTMLElement, scroller: HTMLElement, offsets: Map<HTMLElement, Position>) => {
    const total = { top: 0, left: 0 };
    for (let current: HTMLElement | null = node; current && current !== scroller; current = current.parentElement) {
      const offset = offsets.get(current);
      total.top += offset?.top ?? 0;
      total.left += offset?.left ?? 0;
    }
    return total;
  };
  const read = (parent: HTMLElement, scroller: HTMLElement, origin: Position, offsets: Map<HTMLElement, Position>) =>
    new Map(
      Array.from(parent.children)
        .filter((node): node is HTMLElement => node instanceof HTMLElement)
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const offset = inheritedTranslation(node, scroller, offsets);
          return [node, { top: rect.top - origin.top - offset.top, left: rect.left - origin.left - offset.left }];
        }),
    );
  const origin = (scroller: HTMLElement) => {
    const rect = scroller.getBoundingClientRect();
    return { top: rect.top - scroller.scrollTop, left: rect.left - scroller.scrollLeft };
  };
  const cancel = () => {
    for (const { animation } of running.values()) animation.cancel();
    running.clear();
  };
  // Rectangles share the scroll container's coordinates. Compensate our active
  // translations (including ancestors) without cancelling them between reads.
  const readAll = (offsets: Map<HTMLElement, Position>) => {
    const origins = new Map<HTMLElement, Position>();
    for (const { scroller } of lists.values()) {
      if (!origins.has(scroller)) origins.set(scroller, origin(scroller));
    }
    return [...lists].map(([parent, list]) => ({
      list,
      next: read(parent, list.scroller, origins.get(list.scroller)!, offsets),
    }));
  };
  // A row can grow, a header can wrap, or the scroller can resize without any
  // list gaining or losing a child. Re-measure then, so the next motion starts
  // from what is on screen instead of from the layout before that change.
  const rebaseline = () => {
    if (frame !== undefined || holds > 0) return;
    for (const { list, next } of readAll(translations())) list.positions = next;
  };
  const update = () => {
    frame = undefined;
    const offsets = translations();
    const snapshots = readAll(offsets);
    let changed = 0;
    for (const { list, next } of snapshots) {
      for (const node of list.positions.keys()) if (!next.has(node)) changed++;
      for (const node of next.keys()) if (!list.positions.has(node)) changed++;
    }
    const animate =
      animateNext &&
      holds === 0 &&
      changed <= MAX_CHANGED_ROWS &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    animateNext = true;
    // Plan global displacements first, then subtract the nearest animated
    // ancestor's displacement so nested rows do not receive the same move twice.
    const moves = new Map<HTMLElement, Position | null>();
    if (animate) {
      for (const { list, next } of snapshots) {
        for (const [node, position] of next) {
          const previous = list.positions.get(node);
          const offset = inheritedTranslation(node, list.scroller, offsets);
          moves.set(
            node,
            previous
              ? {
                  top: previous.top - position.top + offset.top,
                  left: previous.left - position.left + offset.left,
                }
              : null,
          );
        }
      }
    }
    const ancestorMove = (node: HTMLElement): Position => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (!moves.has(parent)) continue;
        const move = moves.get(parent);
        if (move) return move;
        const inherited = ancestorMove(parent);
        return { top: inherited.top - 4, left: inherited.left };
      }
      return { top: 0, left: 0 };
    };
    cancel();
    for (const { list, next } of snapshots) {
      if (animate) {
        for (const node of next.keys()) {
          const previous = list.positions.get(node);
          const move = moves.get(node);
          const ancestor = ancestorMove(node);
          const top = move ? move.top - ancestor.top : -4;
          const left = move ? move.left - ancestor.left : 0;
          if (previous && top === 0 && left === 0) continue;
          const animation = node.animate(
            [
              { transform: `translate(${left}px, ${top}px)`, opacity: previous ? 1 : 0 },
              { transform: "translate(0, 0)", opacity: 1 },
            ],
            timing,
          );
          running.set(node, { animation, top, left });
          animation.addEventListener(
            "finish",
            () => {
              if (running.get(node)?.animation === animation) running.delete(node);
            },
            { once: true },
          );
        }
      }
      list.positions = next;
    }
  };
  const schedule = (animate: boolean) => {
    animateNext &&= animate;
    frame ??= requestAnimationFrame(update);
  };
  return {
    enabled,
    // On a group fold, sliding the following group from its old position would
    // draw it on top of the newly revealed rows. Record the new layout in place.
    skipNextMotion() {
      if (lists.size > 0 && holds === 0) schedule(false);
    },
    suspend() {
      holds++;
      cancel();
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    },
    resume() {
      if (holds === 0) return;
      if (--holds === 0 && lists.size > 0) schedule(false);
    },
    register(parent: HTMLElement) {
      const scroller = parent.closest<HTMLElement>("[data-list-motion-scroller]") ?? document.documentElement;
      lists.set(parent, { scroller, positions: read(parent, scroller, origin(scroller), translations()) });
      observer ??= new MutationObserver(() => {
        if (holds === 0) schedule(true);
      });
      observer.observe(parent, { childList: true });
      resizes ??= typeof ResizeObserver === "function" ? new ResizeObserver(rebaseline) : undefined;
      resizes?.observe(parent);
      resizes?.observe(scroller);
      // A list can mount inside a shelf that is not itself a list (a shelf's rows
      // appearing on expand). No observed list changes then, but what follows moves.
      if (holds === 0) schedule(true);
      return () => {
        lists.delete(parent);
        resizes?.unobserve(parent);
        if (![...lists.values()].some((list) => list.scroller === scroller)) resizes?.unobserve(scroller);
        for (const [node, { animation }] of running) {
          if (parent.contains(node) || !node.isConnected) {
            animation.cancel();
            running.delete(node);
          }
        }
        observer?.disconnect();
        for (const node of lists.keys()) observer?.observe(node, { childList: true });
        if (lists.size > 0) {
          // Disconnecting drops queued records; this frame covers them too.
          if (holds === 0) schedule(true);
        } else if (frame !== undefined) {
          cancelAnimationFrame(frame);
          frame = undefined;
        }
      };
    },
  };
}
