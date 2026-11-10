import type { ComponentProps } from "react";
import { ThreadStatusGlyph } from "./bb-sdk";
import "./still-glyphs.css";

/** bb's status glyph for another plugin's row status, with its motion removed (see still-glyphs.css). */
export function StillThreadStatusGlyph(props: ComponentProps<typeof ThreadStatusGlyph>) {
  return (
    <span className="bb-sidebar-still contents">
      <ThreadStatusGlyph {...props} />
    </span>
  );
}
