import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import ts from "typescript";
import { beforeEach, expect, it, vi } from "vitest";
import { toast } from "./lib/toast";

const sonner = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast: sonner }));
beforeEach(() => vi.clearAllMocks());

it("keeps every production Sonner path inside the shared styling wrapper", () => {
  const files = [
    "app.tsx",
    ...readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\./.test(file) && !basename(file).startsWith("test-"))
      .map((file) => `src/${file}`),
  ];
  const importers = files.filter((file) => {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    let usesSonner = false;
    function visit(node: ts.Node) {
      if (ts.isStringLiteralLike(node) && node.text === "sonner") usesSonner = true;
      ts.forEachChild(node, visit);
    }
    visit(source);
    return usesSonner;
  });
  expect(importers).toEqual(["src/lib/toast.ts"]);
});

it.each(["success", "error", "message"] as const)("marks %s toasts, including calls without options", (method) => {
  sonner[method].mockReturnValue("toast-id");
  expect(toast[method]("Confirmation")).toBe("toast-id");
  expect(sonner[method]).toHaveBeenCalledWith("Confirmation", { className: "bb-sidebar-toast" });
});

it.each(["success", "error", "message"] as const)("preserves %s content, timing, callbacks and classes", (method) => {
  const options = {
    id: "settled-ports:thread",
    description: "Agent session stopped",
    duration: 10_000,
    action: { label: "Undo", onClick: vi.fn() },
    onDismiss: vi.fn(),
    className: "extra",
    classNames: { description: "description" },
  };
  toast[method]("Thread settled", options);
  expect(sonner[method]).toHaveBeenCalledWith("Thread settled", {
    ...options,
    className: "bb-sidebar-toast extra",
  });
  expect(sonner[method].mock.calls[0][1].action).toBe(options.action);
  expect(options.className).toBe("extra");
});

it("passes dismissals to the host unchanged", () => {
  sonner.dismiss.mockReturnValue("settled-ports:thread");
  expect(toast.dismiss("settled-ports:thread")).toBe("settled-ports:thread");
  expect(sonner.dismiss).toHaveBeenCalledWith("settled-ports:thread");
});
