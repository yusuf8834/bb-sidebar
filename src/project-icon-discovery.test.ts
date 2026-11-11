import { describe, expect, it } from "vitest";
import {
  isDiscoverableProjectIcon,
  manifestProjectIconPath,
  rankDiscoveredProjectIcons,
} from "./project-icon-discovery";

const manifest = (value: unknown) => {
  const content = JSON.stringify(value);
  return { content, contentEncoding: "utf8", sizeBytes: content.length };
};

describe("project icon discovery", () => {
  it("keeps only conventional icon filenames outside build output", () => {
    expect(isDiscoverableProjectIcon("apps/frontend/src/assets/img/favicon.ico")).toBe(true);
    expect(isDiscoverableProjectIcon("apps/web/public/favicons/apple-touch-icon.png")).toBe(true);
    expect(isDiscoverableProjectIcon("web/icons/Icon-512.png")).toBe(true);
    expect(isDiscoverableProjectIcon("public/logo-dark.svg")).toBe(true);
    expect(isDiscoverableProjectIcon("docs/screenshots/icon-picker.png")).toBe(false);
    expect(isDiscoverableProjectIcon("node_modules/pkg/favicon.ico")).toBe(false);
    expect(isDiscoverableProjectIcon("apps/web/dist/favicon.svg")).toBe(false);
    expect(isDiscoverableProjectIcon("src/icons.ts")).toBe(false);
  });

  it("ranks candidates by name, location, format, and depth", () => {
    expect(
      rankDiscoveredProjectIcons([
        "web/icons/Icon-512.png",
        "src/web/public/favicon.svg",
        "app/frontend/public/pictures/logo.svg",
        "public/favicon.ico",
        "public/favicon.svg",
        "public/logo-dark.svg",
        "../outside/favicon.svg",
        "README.md",
        "public/favicon.svg",
      ]),
    ).toEqual([
      "public/favicon.svg",
      "public/favicon.ico",
      "src/web/public/favicon.svg",
      "app/frontend/public/pictures/logo.svg",
      "public/logo-dark.svg",
      "web/icons/Icon-512.png",
    ]);
  });

  it("reads image paths declared through bb.branding in package.json", () => {
    expect(manifestProjectIconPath(manifest({ bb: { branding: { icon: "./brand/mark.svg" } } }))).toBe(
      "brand/mark.svg",
    );
    expect(
      manifestProjectIconPath(manifest({ bb: { branding: { icon: "PanelLeft", logo: { light: "logo.png" } } } })),
    ).toBe("logo.png");
    expect(manifestProjectIconPath(manifest({ bb: { branding: { icon: "PanelLeft" } } }))).toBeNull();
    expect(manifestProjectIconPath(manifest({ bb: { branding: { icon: "../secret.svg" } } }))).toBeNull();
    expect(manifestProjectIconPath({ content: "{", contentEncoding: "utf8", sizeBytes: 1 })).toBeNull();
    expect(manifestProjectIconPath(manifest(null))).toBeNull();
  });
});
