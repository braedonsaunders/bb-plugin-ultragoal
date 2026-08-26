import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** A goal's standing worker brief: house rules every slice inherits. */
export const MAX_WORKER_BRIEF_CHARS = 4000;

/**
 * Rules that must reach EVERY worker, held by the goal rather than retyped into
 * each slice.
 *
 * The orchestrator was carrying these by hand, and the ones it forgot are
 * exactly the ones that cost the most: a critical concurrency fix landed with
 * ninety-five lines of code and no committed regression because its
 * reproduction was ephemeral, and workers kept starting private databases on
 * PostgreSQL majors the product does not ship on. A rule that depends on
 * someone remembering to repeat it is not a rule.
 *
 * Kept per goal, not global: house rules are about the repository being worked
 * on, and two goals on one machine can have different ones.
 */
export function createWorkerBriefStore(db: ReturnType<BbPluginApi["storage"]["database"]>) {
  // Owned here rather than in the shared migration list, which records progress
  // by array index and has silently skipped an appended statement before.
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_worker_briefs (
      thread_id TEXT PRIMARY KEY,
      brief TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const write = db.prepare(`
    INSERT INTO goal_worker_briefs (thread_id, brief, updated_at)
    VALUES (@thread_id, @brief, @updated_at)
    ON CONFLICT(thread_id) DO UPDATE SET brief = excluded.brief, updated_at = excluded.updated_at
  `);
  const read = db.prepare("SELECT brief FROM goal_worker_briefs WHERE thread_id = ?");
  const remove = db.prepare("DELETE FROM goal_worker_briefs WHERE thread_id = ?");
  return {
    /** Returns an error message, or null when stored. */
    set(threadId: string, brief: string): string | null {
      const text = brief.trim();
      if (!text) return "worker brief must not be empty; use --clear to remove it";
      if (text.length > MAX_WORKER_BRIEF_CHARS) {
        return `worker brief is too long: ${text.length} characters. Limit: ${MAX_WORKER_BRIEF_CHARS}. Put the long form in a repository file and point workers at it.`;
      }
      write.run({ thread_id: threadId, brief: text, updated_at: Date.now() });
      return null;
    },
    get(threadId: string): string | null {
      return (read.get(threadId) as { brief: string } | undefined)?.brief ?? null;
    },
    clear(threadId: string): boolean {
      return remove.run(threadId).changes > 0;
    },
  };
}

export type WorkerBriefStore = ReturnType<typeof createWorkerBriefStore>;

/**
 * Append the goal's standing rules to a worker's instructions.
 *
 * Placed last and clearly labelled so a worker reads them as binding house
 * rules rather than as part of its own slice description.
 */
export function withStandingBrief(instructions: string, brief: string | null): string {
  const text = (brief ?? "").trim();
  if (!text) return instructions;
  return `${instructions}\n\nSTANDING RULES for every slice on this goal — these bind you as much as your slice brief does:\n${text}`;
}
