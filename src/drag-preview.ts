/**
 * A dragged row or group. Lifted, not faded: the unit under the cursor is the
 * one the user is acting on, so it should read as the most present thing on
 * the shelf. The two stacked gradients put an opaque sidebar base under the
 * accent tint, because a translucent unit would let the rows it passes over
 * show straight through it.
 */
export const DRAG_LIFT_CLASS =
  "bg-[linear-gradient(var(--sidebar-accent),var(--sidebar-accent)),linear-gradient(var(--sidebar),var(--sidebar))] shadow-lg ring-1 ring-sidebar-border";

/** FLIP only the visual layer; insertion continues to use untransformed li slots. */
export function createDragPreview(list: HTMLElement) {
  const effects = new Map<HTMLElement, Animation>();
  let positions: Map<HTMLElement, number> | null = null;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const visuals = () =>
    Array.from(list.children).flatMap((row) => {
      const visual = row.querySelector<HTMLElement>(":scope > [data-drag-visual]");
      return visual ? [visual] : [];
    });
  function cancelEffects() {
    for (const effect of effects.values()) effect.cancel();
    effects.clear();
  }
  function onMotionChange() {
    if (reducedMotion?.matches) {
      positions = null;
      cancelEffects();
    }
  }
  list.setAttribute("data-drag-preview", "");
  reducedMotion?.addEventListener("change", onMotionChange);
  return {
    capture() {
      // Several pointer events can precede one React commit. Keep the first
      // snapshot, including the current transform of any unfinished effect.
      if (positions || reducedMotion?.matches) return;
      const top = list.getBoundingClientRect().top;
      positions = new Map(visuals().map((visual) => [visual, visual.getBoundingClientRect().top - top]));
    },
    play() {
      if (!positions) return;
      const previous = positions;
      positions = null;
      cancelEffects();
      if (reducedMotion?.matches) return;
      // Relative coordinates exclude scrolling between capture and commit.
      const top = list.getBoundingClientRect().top;
      for (const visual of visuals()) {
        const oldTop = previous.get(visual);
        if (oldTop === undefined || typeof visual.animate !== "function") continue;
        const delta = oldTop - (visual.getBoundingClientRect().top - top);
        if (Math.abs(delta) < 0.5) continue;
        const effect = visual.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
          duration: 150,
          easing: "ease-out",
        });
        effects.set(visual, effect);
        effect.onfinish = () => {
          if (effects.get(visual) === effect) effects.delete(visual);
        };
      }
    },
    destroy() {
      positions = null;
      cancelEffects();
      reducedMotion?.removeEventListener("change", onMotionChange);
      list.removeAttribute("data-drag-preview");
    },
  };
}
