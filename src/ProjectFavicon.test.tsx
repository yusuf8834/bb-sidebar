// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ProjectFavicon } from "./ProjectFavicon";

/** The status the icon route answers when the sidebar asks why an image failed. */
let iconStatus: number | "offline" = 503;
/** Whether a 404 carries the server's "no icon" mark, or is bb's own 404 for a route not loaded yet. */
let markedMissing = true;
const fetchIcon = vi.fn(async () => {
  if (iconStatus === "offline") throw new TypeError("Failed to fetch");
  const headers = new Headers(iconStatus === 404 && markedMissing ? { "x-bb-sidebar-icon-missing": "1" } : {});
  return { status: iconStatus, headers, body: null };
});

beforeEach(() => {
  iconStatus = 503;
  markedMissing = true;
  fetchIcon.mockClear();
  vi.stubGlobal("fetch", fetchIcon);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let the status check after an image error settle. */
const settle = () =>
  act(async () => {
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  });

/** Fail the shown image, let the status check settle, then advance the clock. */
async function failAndWait(view: ReturnType<typeof render>, ms: number) {
  fireEvent.error(view.container.querySelector("img")!);
  await settle();
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("ProjectFavicon", () => {
  it("retries an icon that failed to load instead of hiding it for good", () => {
    vi.useFakeTimers();
    const src = "/project-icon?projectId=proj_retry&revision=0";
    const view = render(<ProjectFavicon src={src} fallback="F" />);

    const first = view.container.querySelector("img")!;
    expect(first.getAttribute("src")).toBe(src);
    fireEvent.error(first);
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.textContent).toBe("F");

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    const retry = view.container.querySelector("img")!;
    expect(retry.getAttribute("src")).toBe(`${src}&attempt=1`);
    fireEvent.load(retry);

    const icon = view.container.querySelector("img.object-contain")!;
    expect(icon.getAttribute("src")).toBe(`${src}&attempt=1`);
  });

  it("shows the project's letter tile while the icon loads and after it fails", () => {
    const view = render(<ProjectFavicon src="/project-icon?projectId=proj_tile&revision=0" name="bb-sidebar" />);
    const tile = () => view.container.querySelector(".bb-sidebar-monogram");
    expect(tile()?.getAttribute("data-letter")).toBe("S");
    // Drawn by CSS, so the letter never joins the row's text.
    expect(view.container.textContent).toBe("");

    fireEvent.error(view.container.querySelector("img")!);
    expect(view.container.querySelector("img")).toBeNull();
    expect(tile()?.getAttribute("data-letter")).toBe("S");
  });

  it("asks a project with no icon again only once an hour", async () => {
    vi.useFakeTimers();
    iconStatus = 404;
    const src = "/project-icon?projectId=proj_missing&revision=0";
    const view = render(<ProjectFavicon src={src} fallback="F" />);

    await failAndWait(view, 10 * 60_000);
    expect(fetchIcon).toHaveBeenCalledWith(src, { cache: "no-store" });
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.textContent).toBe("F");

    act(() => {
      vi.advanceTimersByTime(50 * 60_000);
    });
    expect(view.container.querySelector("img")!.getAttribute("src")).toBe(`${src}&attempt=1`);
  });

  it.each([
    ["unavailable", 503, true],
    ["offline", "offline", true],
    ["not loaded yet", 404, false],
  ] as const)("keeps the short backoff while the icon route is %s", async (_label, status, marked) => {
    vi.useFakeTimers();
    iconStatus = status;
    markedMissing = marked;
    const src = `/project-icon?projectId=proj_${_label.replaceAll(" ", "_")}&revision=0`;
    const view = render(<ProjectFavicon src={src} fallback="F" />);

    await failAndWait(view, 15_000);
    expect(view.container.querySelector("img")!.getAttribute("src")).toBe(`${src}&attempt=1`);
  });

  it("starts over at once when the icon changes in Settings", async () => {
    vi.useFakeTimers();
    iconStatus = 404;
    const view = render(<ProjectFavicon src="/project-icon?projectId=proj_set&revision=0" fallback="F" />);
    await failAndWait(view, 1_000);
    expect(view.container.querySelector("img")).toBeNull();

    // Picking or uploading an icon bumps the revision, so the URL is new.
    view.rerender(<ProjectFavicon src="/project-icon?projectId=proj_set&revision=1" fallback="F" />);
    expect(view.container.querySelector("img")!.getAttribute("src")).toBe(
      "/project-icon?projectId=proj_set&revision=1",
    );
  });

  it("draws nothing without a name or an explicit fallback", () => {
    const view = render(<ProjectFavicon src={null} />);
    expect(view.container.innerHTML).toBe("");
  });
});
