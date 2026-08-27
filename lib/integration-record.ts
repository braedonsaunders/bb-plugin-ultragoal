import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Which commit actually carried a slice onto the base branch.
 *
 * A finding was closed on its worker's report and nothing ever recorded where
 * the work landed — the register stored a paragraph of prose and no commit. So
 * of 417 register entries, 256 could not be attributed to any commit at all and
 * 75 named a fix that is not an ancestor of main. "Fixed" meant "a worker said
 * so", which is a claim, not a fact.
 *
 * Worse, the claim was written BEFORE the merge was attempted: completion closes
 * the finding, and integration is queued afterwards. An integration that then
 * fails leaves the register asserting a fix that is provably not in the tree,
 * and nothing revisits it.
 *
 * This records the outcome either way, so the reachability gate has something
 * to check and a failed merge is visible instead of silent.
 */
export interface IntegrationOutcome {
  itemId: string;
  /** Commit on the base branch, when the merge succeeded. */
  commit: string | null;
  /** Branch the work came from, which survives even when the merge fails. */
  branch: string | null;
  status: "integrated" | "failed";
  detail: string | null;
}

export function createIntegrationRecordStore(
  db: ReturnType<BbPluginApi["storage"]["database"]>,
) {
  // Created here rather than in the shared migration list, which records
  // progress by array index and has silently skipped an appended statement.
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_item_integrations (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      commit_sha TEXT,
      branch TEXT,
      status TEXT NOT NULL,
      detail TEXT,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, item_id)
    )
  `);
  const upsert = db.prepare(`
    INSERT INTO goal_item_integrations
      (thread_id, item_id, commit_sha, branch, status, detail, recorded_at)
    VALUES (@thread_id, @item_id, @commit_sha, @branch, @status, @detail, @recorded_at)
    ON CONFLICT(thread_id, item_id) DO UPDATE SET
      commit_sha = excluded.commit_sha,
      branch = excluded.branch,
      status = excluded.status,
      detail = excluded.detail,
      recorded_at = excluded.recorded_at
  `);
  const one = db.prepare(
    "SELECT commit_sha, branch, status, detail FROM goal_item_integrations WHERE thread_id = ? AND item_id = ?",
  );
  const failed = db.prepare(
    "SELECT item_id, branch, detail FROM goal_item_integrations WHERE thread_id = ? AND status = 'failed' ORDER BY recorded_at",
  );
  return {
    record(threadId: string, outcome: IntegrationOutcome, now: number): void {
      upsert.run({
        thread_id: threadId,
        item_id: outcome.itemId,
        commit_sha: outcome.commit,
        branch: outcome.branch,
        status: outcome.status,
        detail: outcome.detail?.slice(0, 400) ?? null,
        recorded_at: now,
      });
    },
    get(threadId: string, itemId: string) {
      return (one.get(threadId, itemId) ?? null) as
        | { commit_sha: string | null; branch: string | null; status: string; detail: string | null }
        | null;
    },
    /** Slices whose work is NOT on the base branch, however the register reads. */
    unintegrated(threadId: string): Array<{ itemId: string; branch: string | null; detail: string | null }> {
      return (failed.all(threadId) as Array<{ item_id: string; branch: string | null; detail: string | null }>).map(
        (row) => ({ itemId: row.item_id, branch: row.branch, detail: row.detail }),
      );
    },
  };
}

export type IntegrationRecordStore = ReturnType<typeof createIntegrationRecordStore>;
