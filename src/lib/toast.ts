import { toast as sonner } from "sonner";
import type { ExternalToast } from "sonner";

function themed(options?: ExternalToast): ExternalToast {
  return {
    ...options,
    className: ["bb-sidebar-toast", options?.className].filter(Boolean).join(" "),
  };
}

// BB renders the shimmed Sonner singleton outside the sidebar's DOM tree.
export const toast = {
  success: (...[message, options]: Parameters<typeof sonner.success>) => sonner.success(message, themed(options)),
  error: (...[message, options]: Parameters<typeof sonner.error>) => sonner.error(message, themed(options)),
  message: (...[message, options]: Parameters<typeof sonner.message>) => sonner.message(message, themed(options)),
  dismiss: (id?: string | number) => sonner.dismiss(id),
};

/**
 * A failed call's message, as a toast's description. bb's SDK client puts
 * "HTTP 500: " in front of the message; the toast's title already says what
 * failed, so the status code is left out.
 */
export function errorDetail(error: unknown): string | undefined {
  return (error instanceof Error && error.message.replace(/^HTTP \d+: /, "").trim()) || undefined;
}
