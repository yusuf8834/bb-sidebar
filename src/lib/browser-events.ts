// DOM events, not persisted storage keys.
export const BROWSER_EVENTS = {
  portLinkHostChanged: "bb-sidebar:port-link-host-changed",
  threadHoverCardOpened: "bb-sidebar:thread-hover-card-opened",
  // The "Filter threads" command focuses the sidebar's filter bar.
  focusFilter: "bb-sidebar:focus-filter",
} as const;
