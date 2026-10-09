import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { createTitleRegenerator } from "./regenerate-title";

// Give BB's native title request time to settle before recovery. BB also skips
// first prompts shorter than five words, which still need a sidebar title.
const RECOVERY_DELAY_MS = 10_000;
const MAX_CONCURRENT_RECOVERIES = 2;

export const AUTO_TITLE_RECOVERY_MIGRATION = `CREATE TABLE IF NOT EXISTS title_recovery_attempts (
  thread_id TEXT PRIMARY KEY
)`;

/** Recover a missing title once, without tying naming to sidebar mounts. */
export function createAutoTitleRecovery(
  bb: BbPluginApi,
  regenerateTitle: ReturnType<typeof createTitleRegenerator>,
) {
  const db = bb.storage.database();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const queued = new Set<string>();
  const running = new Set<string>();
  const deleted = new Set<string>();
  let disposed = false;
  const attempted = db.prepare("SELECT 1 FROM title_recovery_attempts WHERE thread_id = ?");
  const claim = db.prepare("INSERT OR IGNORE INTO title_recovery_attempts (thread_id) VALUES (?)");

  async function recover(threadId: string) {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (disposed || thread.title !== null || thread.visibility !== "visible" ||
          thread.archivedAt !== null || thread.deletedAt !== null) return;
      const { selections } = await bb.sdk.system.aiServices();
      if (disposed || deleted.has(threadId) || selections["thread-title"].mode === "off") return;
      if (claim.run(threadId).changes === 0) return;
      await regenerateTitle(threadId, { onlyIfUntitled: true });
    } catch (error) {
      if (!disposed) bb.log.info(
        `Automatic title recovery did not complete for ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function drain() {
    while (!disposed && running.size < MAX_CONCURRENT_RECOVERIES && queued.size > 0) {
      const threadId = queued.values().next().value!;
      queued.delete(threadId);
      running.add(threadId);
      void recover(threadId).finally(() => {
        running.delete(threadId);
        deleted.delete(threadId);
        drain();
      });
    }
  }

  // Events include hidden title helpers, which must never start another helper.
  const onThread = ({ thread }: { thread: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>> }) => {
    if (disposed || thread.title !== null || thread.visibility !== "visible" ||
        thread.archivedAt !== null || thread.deletedAt !== null ||
        timers.has(thread.id) || queued.has(thread.id) || running.has(thread.id) ||
        attempted.get(thread.id)) return;
    const timer = setTimeout(() => {
      timers.delete(thread.id);
      queued.add(thread.id);
      drain();
    }, RECOVERY_DELAY_MS);
    timer.unref?.();
    timers.set(thread.id, timer);
  };
  bb.events.on("thread.active", onThread);
  bb.events.on("thread.idle", onThread);
  bb.events.on("thread.deleted", ({ thread }) => {
    if (running.has(thread.id)) deleted.add(thread.id);
    clearTimeout(timers.get(thread.id));
    timers.delete(thread.id);
    queued.delete(thread.id);
    db.prepare("DELETE FROM title_recovery_attempts WHERE thread_id = ?").run(thread.id);
  });
  bb.onDispose(() => {
    disposed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    queued.clear();
  });
}
