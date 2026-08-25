import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GoalSnapshot, GoalStatus } from "../contract.js";

export const MAX_OBJECTIVE_CHARS = 4000;

export interface GoalWrite {
  threadId: string;
  objective: string;
  status: GoalStatus;
  reason?: string | null;
  tokenBudget?: number | null;
}

interface GoalRow {
  thread_id: string;
  objective: string;
  status: string;
  reason: string | null;
  created_at: number;
  updated_at: number;
  started_at: number;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  last_continue_at: number | null;
  last_seen_tokens: number | null;
  last_accounted_at: number | null;
  last_continue_was_automatic: number;
  blocked_streak: number;
  last_block_key: string | null;
  verify_enabled: number | null;
  verify_provider: string | null;
  verify_model: string | null;
  auto_continue: number | null;
  last_progress_at: number | null;
  progress_update_minutes: number | null;
  max_workers: number | null;
  worker_provider: string | null;
  worker_model: string | null;
  worker_reasoning: string | null;
  worker_service_tier: string | null;
  verify_reasoning: string | null;
  verify_service_tier: string | null;
  intake_row_id: string | null;
  completion_summary: string | null;
  accounting_thread_ids: string | null;
}

// The persistent record. Live fields (agentRunning, items, agents, now, next)
// are computed per snapshot in server.ts, never stored.
export interface StoredGoal
  extends Omit<GoalSnapshot, "agentRunning" | "items" | "agents" | "now" | "next" | "findings" | "decisions" | "completionSummary"> {
  lastSeenTokens: number | null;
  lastAccountedAt: number | null;
  lastContinueWasAutomatic: boolean;
  blockedStreak: number;
  lastBlockKey: string | null;
  verifyEnabledOverride: boolean | null;
  verifyProviderOverride: string | null;
  verifyModelOverride: string | null;
  autoContinueOverride: boolean | null;
  lastProgressAt: number | null;
  progressUpdateMinutesOverride: number | null;
  maxWorkersOverride: number | null;
  workerProviderOverride: string | null;
  workerModelOverride: string | null;
  workerReasoningOverride: string | null;
  workerServiceTierOverride: string | null;
  verifyReasoningOverride: string | null;
  verifyServiceTierOverride: string | null;
  intakeRowId: string | null;
  completionSummary: string | null;
  /** Prior root sessions that remain part of cumulative goal accounting. */
  accountingThreadIds: string[];
}

function parseStringList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function normalizeStatus(status: string): GoalStatus {
  if (status === "limited") return "budget_limited";
  if (
    status === "active" ||
    status === "paused" ||
    status === "blocked" ||
    status === "complete" ||
    status === "budget_limited" ||
    status === "usage_limited"
  ) {
    return status;
  }
  return "active";
}

function rowToGoal(row: GoalRow): StoredGoal {
  return {
    threadId: row.thread_id,
    objective: row.objective,
    status: normalizeStatus(row.status),
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    lastContinueAt: row.last_continue_at,
    lastSeenTokens: row.last_seen_tokens,
    lastAccountedAt: row.last_accounted_at,
    lastContinueWasAutomatic: row.last_continue_was_automatic === 1,
    blockedStreak: row.blocked_streak,
    lastBlockKey: row.last_block_key,
    settings: {
      verifyEnabled: true,
      verifyProvider: "",
      verifyModel: "",
      autoContinue: true,
      progressUpdateMinutes: 5,
      maxWorkers: 5,
      maxOpenFindings: 50,
      workerProvider: "",
      workerModel: "",
      workerReasoning: "",
      workerServiceTier: null,
      verifyReasoning: "medium",
      verifyServiceTier: null,
    },
    lastProgressAt: row.last_progress_at,
    verifyEnabledOverride: row.verify_enabled == null ? null : row.verify_enabled === 1,
    verifyProviderOverride: row.verify_provider,
    verifyModelOverride: row.verify_model,
    autoContinueOverride: row.auto_continue == null ? null : row.auto_continue === 1,
    progressUpdateMinutesOverride: row.progress_update_minutes,
    maxWorkersOverride: row.max_workers,
    workerProviderOverride: row.worker_provider,
    workerModelOverride: row.worker_model,
    workerReasoningOverride: row.worker_reasoning,
    workerServiceTierOverride: row.worker_service_tier,
    verifyReasoningOverride: row.verify_reasoning,
    verifyServiceTierOverride: row.verify_service_tier,
    intakeRowId: row.intake_row_id ?? null,
    completionSummary: row.completion_summary ?? null,
    accountingThreadIds: parseStringList(row.accounting_thread_ids),
  };
}

function flag(value: boolean | null | undefined): number | null {
  if (value == null) return null;
  return value ? 1 : 0;
}

export function validateObjective(objective: string): string | null {
  const text = objective.trim();
  if (!text) return "UltraGoal objective must not be empty";
  if (text.length > MAX_OBJECTIVE_CHARS) {
    return `UltraGoal objective is too long: ${text.length} characters. Limit: ${MAX_OBJECTIVE_CHARS} characters. Put longer instructions in a file and reference that file from the UltraGoal.`;
  }
  return null;
}

function importLegacyGoalDatabase(db: { prepare: (sql: string) => { get: () => unknown }; exec: (sql: string) => void }): void {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM goals").get() as { n: number }).n;
  if (count > 0) return;
  const legacy = join(homedir(), ".bb", "plugins", "goal", "data.db");
  if (!existsSync(legacy)) return;
  const escaped = legacy.replaceAll("'", "''");
  db.exec(`ATTACH DATABASE '${escaped}' AS legacy`);
  try {
    db.exec("INSERT OR IGNORE INTO goals SELECT * FROM legacy.goals");
    db.exec("INSERT OR IGNORE INTO goal_items SELECT * FROM legacy.goal_items");
    db.exec("INSERT OR IGNORE INTO collab_agents SELECT * FROM legacy.collab_agents");
  } finally {
    db.exec("DETACH DATABASE legacy");
  }
}

export function createGoalStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS goals (
      thread_id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      turn_count INTEGER NOT NULL,
      max_turns INTEGER NOT NULL,
      max_minutes INTEGER NOT NULL,
      last_continue_at INTEGER,
      last_assistant_hash TEXT
    )`,
    `ALTER TABLE goals ADD COLUMN token_budget INTEGER`,
    `ALTER TABLE goals ADD COLUMN tokens_used INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE goals ADD COLUMN time_used_seconds INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE goals ADD COLUMN last_seen_tokens INTEGER`,
    `ALTER TABLE goals ADD COLUMN last_accounted_at INTEGER`,
    `ALTER TABLE goals ADD COLUMN last_continue_was_automatic INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE goals ADD COLUMN blocked_streak INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE goals ADD COLUMN last_block_key TEXT`,
    `CREATE TABLE IF NOT EXISTS goal_items (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      step TEXT NOT NULL,
      status TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS collab_agents (
      thread_id TEXT PRIMARY KEY,
      root_thread_id TEXT NOT NULL,
      parent_thread_id TEXT,
      task_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS collab_agents_root ON collab_agents(root_thread_id)`,
    `ALTER TABLE collab_agents ADD COLUMN display_name TEXT`,
    `ALTER TABLE collab_agents ADD COLUMN item_id TEXT`,
    `ALTER TABLE goals ADD COLUMN verify_enabled INTEGER`,
    `ALTER TABLE goals ADD COLUMN verify_provider TEXT`,
    `ALTER TABLE goals ADD COLUMN verify_model TEXT`,
    `ALTER TABLE goals ADD COLUMN auto_continue INTEGER`,
    `ALTER TABLE collab_agents ADD COLUMN role TEXT`,
    `ALTER TABLE collab_agents ADD COLUMN source_thread_id TEXT`,
    `ALTER TABLE collab_agents ADD COLUMN last_verify_hash TEXT`,
    `ALTER TABLE goals ADD COLUMN last_progress_at INTEGER`,
    `ALTER TABLE goals ADD COLUMN progress_update_minutes INTEGER`,
    `ALTER TABLE goals ADD COLUMN last_plan_seq INTEGER`,
    `ALTER TABLE goal_items ADD COLUMN origin TEXT`,
    // DAG metadata; NULL normalizes to empty (deps/files) and none (check).
    `ALTER TABLE goal_items ADD COLUMN deps TEXT`,
    `ALTER TABLE goal_items ADD COLUMN files TEXT`,
    `ALTER TABLE goal_items ADD COLUMN check_cmd TEXT`,
    `ALTER TABLE goals ADD COLUMN max_workers INTEGER`,
    `CREATE TABLE IF NOT EXISTS goal_findings (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      title TEXT NOT NULL,
      file TEXT NOT NULL,
      evidence TEXT NOT NULL,
      status TEXT NOT NULL,
      item_id TEXT,
      resolution_note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(thread_id, fingerprint)
    )`,
    `CREATE INDEX IF NOT EXISTS goal_findings_thread ON goal_findings(thread_id, status)`,
    // Pre-0.5.1 discovery copied a child thread's title into display_name;
    // equality with task_name is the structural marker of that copy. Null it
    // so the naming pass generates a real (work-related) name.
    `UPDATE collab_agents SET display_name = NULL WHERE display_name = task_name AND (role IS NULL OR role != 'verifier')`,
    // Retirement tombstones: forgetting a worker must survive rediscovery of
    // its (dead) thread, so rows are retired, never deleted. Migrations are
    // positional — new statements append at the END, never mid-array.
    `ALTER TABLE collab_agents ADD COLUMN retired_at INTEGER`,
    `ALTER TABLE collab_agents ADD COLUMN verify_fails INTEGER`,
    // Nudge state is durable: in-memory cooldowns reset on plugin reload,
    // which turned a 15-minute cooldown into a nudge per release.
    `ALTER TABLE collab_agents ADD COLUMN last_nudge_at INTEGER`,
    `ALTER TABLE collab_agents ADD COLUMN nudge_count INTEGER`,
    `CREATE TABLE IF NOT EXISTS goal_decisions (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      question TEXT NOT NULL,
      context TEXT,
      options TEXT,
      status TEXT NOT NULL,
      answer TEXT,
      created_at INTEGER NOT NULL,
      answered_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS goal_decisions_thread ON goal_decisions(thread_id, status)`,
    `ALTER TABLE goals ADD COLUMN worker_provider TEXT`,
    `ALTER TABLE goals ADD COLUMN worker_model TEXT`,
    // Formal slice reports: workers signal done/blocked via tool call, recorded
    // here; completion reads the durable claim, not output text.
    `ALTER TABLE collab_agents ADD COLUMN report_status TEXT`,
    `ALTER TABLE collab_agents ADD COLUMN report_evidence TEXT`,
    // Durable intake cursor: an in-memory cursor re-baselined on every plugin
    // reload and silently skipped the first owner message after each reload.
    `ALTER TABLE goals ADD COLUMN intake_row_id TEXT`,
    `ALTER TABLE goals ADD COLUMN completion_summary TEXT`,
    `ALTER TABLE goals ADD COLUMN worker_reasoning TEXT`,
    `ALTER TABLE goals ADD COLUMN worker_service_tier TEXT`,
    `ALTER TABLE goals ADD COLUMN verify_reasoning TEXT`,
    `ALTER TABLE goals ADD COLUMN verify_service_tier TEXT`,
    // Record-only findings must retain enough information to mint the same
    // remediation slice later when staffed capacity reopens.
    `ALTER TABLE goal_findings ADD COLUMN fix_files TEXT`,
    `ALTER TABLE goal_findings ADD COLUMN check_cmd TEXT`,
    // Root transfers retain old provider sessions for cumulative accounting.
    `ALTER TABLE goals ADD COLUMN accounting_thread_ids TEXT`,
    // Durable cross-system transfer phase. Incomplete rows freeze both roots
    // until the idempotent admin command repairs and completes the takeover.
    `CREATE TABLE IF NOT EXISTS goal_root_transfers (
      source_thread_id TEXT PRIMARY KEY,
      target_thread_id TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL,
      target_intake_row_id TEXT NOT NULL,
      wake_marker TEXT NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ]);
  importLegacyGoalDatabase(db);

  const select = db.prepare("SELECT * FROM goals WHERE thread_id = ?");
  const selectActive = db.prepare(
    "SELECT thread_id FROM goals WHERE status IN ('active', 'budget_limited', 'paused', 'blocked')",
  );
  const selectAll = db.prepare("SELECT thread_id FROM goals");
  const upsert = db.prepare(`
    INSERT INTO goals (
      thread_id, objective, status, reason, created_at, updated_at, started_at,
      token_budget, tokens_used, time_used_seconds, last_continue_at,
      last_seen_tokens, last_accounted_at, last_continue_was_automatic,
      blocked_streak, last_block_key, turn_count, max_turns, max_minutes,
      verify_enabled, verify_provider, verify_model, auto_continue,
      last_progress_at, progress_update_minutes, max_workers,
      worker_provider, worker_model, worker_reasoning, worker_service_tier,
      verify_reasoning, verify_service_tier, intake_row_id, completion_summary,
      accounting_thread_ids
    ) VALUES (
      @thread_id, @objective, @status, @reason, @created_at, @updated_at, @started_at,
      @token_budget, @tokens_used, @time_used_seconds, @last_continue_at,
      @last_seen_tokens, @last_accounted_at, @last_continue_was_automatic,
      @blocked_streak, @last_block_key, 0, 40, 180,
      @verify_enabled, @verify_provider, @verify_model, @auto_continue,
      @last_progress_at, @progress_update_minutes, @max_workers,
      @worker_provider, @worker_model, @worker_reasoning, @worker_service_tier,
      @verify_reasoning, @verify_service_tier, @intake_row_id, @completion_summary,
      @accounting_thread_ids
    )
    ON CONFLICT(thread_id) DO UPDATE SET
      objective = excluded.objective,
      status = excluded.status,
      reason = excluded.reason,
      updated_at = excluded.updated_at,
      started_at = excluded.started_at,
      token_budget = excluded.token_budget,
      tokens_used = excluded.tokens_used,
      time_used_seconds = excluded.time_used_seconds,
      last_continue_at = excluded.last_continue_at,
      last_seen_tokens = excluded.last_seen_tokens,
      last_accounted_at = excluded.last_accounted_at,
      last_continue_was_automatic = excluded.last_continue_was_automatic,
      blocked_streak = excluded.blocked_streak,
      last_block_key = excluded.last_block_key,
      verify_enabled = excluded.verify_enabled,
      verify_provider = excluded.verify_provider,
      verify_model = excluded.verify_model,
      auto_continue = excluded.auto_continue,
      last_progress_at = excluded.last_progress_at,
      progress_update_minutes = excluded.progress_update_minutes,
      max_workers = excluded.max_workers,
      worker_provider = excluded.worker_provider,
      worker_model = excluded.worker_model,
      worker_reasoning = excluded.worker_reasoning,
      worker_service_tier = excluded.worker_service_tier,
      verify_reasoning = excluded.verify_reasoning,
      verify_service_tier = excluded.verify_service_tier,
      intake_row_id = excluded.intake_row_id,
      completion_summary = excluded.completion_summary,
      accounting_thread_ids = excluded.accounting_thread_ids
  `);
  const remove = db.prepare("DELETE FROM goals WHERE thread_id = ?");
  const writeIntakeRow = db.prepare("UPDATE goals SET intake_row_id = ? WHERE thread_id = ?");

  return {
    get(threadId: string): StoredGoal | null {
      const row = select.get(threadId) as GoalRow | undefined;
      return row ? rowToGoal(row) : null;
    },

    listActiveThreadIds(): string[] {
      return (selectActive.all() as Array<{ thread_id: string }>).map((row) => row.thread_id);
    },

    listThreadIds(): string[] {
      return (selectAll.all() as Array<{ thread_id: string }>).map((row) => row.thread_id);
    },

    set(write: GoalWrite): StoredGoal {
      const now = Date.now();
      const existing = this.get(write.threadId);
      const next: GoalRow = {
        thread_id: write.threadId,
        objective: write.objective,
        status: write.status,
        reason: write.reason ?? null,
        created_at: existing?.createdAt ?? now,
        updated_at: now,
        started_at: existing?.startedAt ?? now,
        token_budget: write.tokenBudget === undefined ? (existing?.tokenBudget ?? null) : write.tokenBudget,
        tokens_used: existing?.tokensUsed ?? 0,
        time_used_seconds: existing?.timeUsedSeconds ?? 0,
        last_continue_at: existing?.lastContinueAt ?? null,
        last_seen_tokens: existing?.lastSeenTokens ?? null,
        last_accounted_at: existing?.lastAccountedAt ?? null,
        last_continue_was_automatic: existing?.lastContinueWasAutomatic ? 1 : 0,
        blocked_streak: existing?.blockedStreak ?? 0,
        last_block_key: existing?.lastBlockKey ?? null,
        verify_enabled: existing ? flag(existing.verifyEnabledOverride) : null,
        verify_provider: existing?.verifyProviderOverride ?? null,
        verify_model: existing?.verifyModelOverride ?? null,
        auto_continue: existing ? flag(existing.autoContinueOverride) : null,
        last_progress_at: existing?.lastProgressAt ?? null,
        progress_update_minutes: existing?.progressUpdateMinutesOverride ?? null,
        max_workers: existing?.maxWorkersOverride ?? null,
        worker_provider: existing?.workerProviderOverride ?? null,
        worker_model: existing?.workerModelOverride ?? null,
        worker_reasoning: existing?.workerReasoningOverride ?? null,
        worker_service_tier: existing?.workerServiceTierOverride ?? null,
        verify_reasoning: existing?.verifyReasoningOverride ?? null,
        verify_service_tier: existing?.verifyServiceTierOverride ?? null,
        intake_row_id: existing?.intakeRowId ?? null,
        completion_summary: existing?.completionSummary ?? null,
        accounting_thread_ids: existing?.accountingThreadIds.length
          ? JSON.stringify(existing.accountingThreadIds)
          : null,
      };
      upsert.run(next);
      return rowToGoal(next);
    },

    replace(write: GoalWrite): StoredGoal {
      const now = Date.now();
      const next: GoalRow = {
        thread_id: write.threadId,
        objective: write.objective,
        status: write.status,
        reason: write.reason ?? null,
        created_at: now,
        updated_at: now,
        started_at: now,
        token_budget: write.tokenBudget ?? null,
        tokens_used: 0,
        time_used_seconds: 0,
        last_continue_at: null,
        last_seen_tokens: null,
        last_accounted_at: now,
        last_continue_was_automatic: 0,
        blocked_streak: 0,
        last_block_key: null,
        verify_enabled: null,
        verify_provider: null,
        verify_model: null,
        auto_continue: null,
        last_progress_at: now,
        progress_update_minutes: null,
        max_workers: null,
        worker_provider: null,
        worker_model: null,
        worker_reasoning: null,
        worker_service_tier: null,
        verify_reasoning: null,
        verify_service_tier: null,
        intake_row_id: null,
        completion_summary: null,
        accounting_thread_ids: null,
      };
      upsert.run(next);
      return rowToGoal(next);
    },

    update(
      threadId: string,
      patch: Partial<{
        status: GoalStatus;
        reason: string | null;
        objective: string;
        tokenBudget: number | null;
        tokensUsed: number;
        timeUsedSeconds: number;
        lastContinueAt: number | null;
        lastSeenTokens: number | null;
        lastAccountedAt: number | null;
        lastContinueWasAutomatic: boolean;
        blockedStreak: number;
        lastBlockKey: string | null;
        startedAt: number;
        verifyEnabledOverride: boolean | null;
        verifyProviderOverride: string | null;
        verifyModelOverride: string | null;
        autoContinueOverride: boolean | null;
        lastProgressAt: number | null;
        progressUpdateMinutesOverride: number | null;
        maxWorkersOverride: number | null;
        workerProviderOverride: string | null;
        workerModelOverride: string | null;
        workerReasoningOverride: string | null;
        workerServiceTierOverride: string | null;
        verifyReasoningOverride: string | null;
        verifyServiceTierOverride: string | null;
        completionSummary: string | null;
        accountingThreadIds: string[];
      }>,
    ): StoredGoal | null {
      const existing = this.get(threadId);
      if (!existing) return null;
      const next: GoalRow = {
        thread_id: existing.threadId,
        objective: patch.objective ?? existing.objective,
        status: patch.status ?? existing.status,
        reason: patch.reason === undefined ? existing.reason : patch.reason,
        created_at: existing.createdAt,
        updated_at: Date.now(),
        started_at: patch.startedAt ?? existing.startedAt,
        token_budget:
          patch.tokenBudget === undefined ? existing.tokenBudget : patch.tokenBudget,
        tokens_used: patch.tokensUsed ?? existing.tokensUsed,
        time_used_seconds: patch.timeUsedSeconds ?? existing.timeUsedSeconds,
        last_continue_at:
          patch.lastContinueAt === undefined
            ? existing.lastContinueAt
            : patch.lastContinueAt,
        last_seen_tokens:
          patch.lastSeenTokens === undefined
            ? existing.lastSeenTokens
            : patch.lastSeenTokens,
        last_accounted_at:
          patch.lastAccountedAt === undefined
            ? existing.lastAccountedAt
            : patch.lastAccountedAt,
        last_continue_was_automatic:
          patch.lastContinueWasAutomatic === undefined
            ? existing.lastContinueWasAutomatic
              ? 1
              : 0
            : patch.lastContinueWasAutomatic
              ? 1
              : 0,
        blocked_streak: patch.blockedStreak ?? existing.blockedStreak,
        last_block_key:
          patch.lastBlockKey === undefined ? existing.lastBlockKey : patch.lastBlockKey,
        verify_enabled:
          patch.verifyEnabledOverride === undefined
            ? flag(existing.verifyEnabledOverride)
            : flag(patch.verifyEnabledOverride),
        verify_provider:
          patch.verifyProviderOverride === undefined
            ? existing.verifyProviderOverride
            : patch.verifyProviderOverride,
        verify_model:
          patch.verifyModelOverride === undefined
            ? existing.verifyModelOverride
            : patch.verifyModelOverride,
        auto_continue:
          patch.autoContinueOverride === undefined
            ? flag(existing.autoContinueOverride)
            : flag(patch.autoContinueOverride),
        last_progress_at:
          patch.lastProgressAt === undefined ? existing.lastProgressAt : patch.lastProgressAt,
        progress_update_minutes:
          patch.progressUpdateMinutesOverride === undefined
            ? existing.progressUpdateMinutesOverride
            : patch.progressUpdateMinutesOverride,
        max_workers:
          patch.maxWorkersOverride === undefined
            ? existing.maxWorkersOverride
            : patch.maxWorkersOverride,
        worker_provider:
          patch.workerProviderOverride === undefined
            ? existing.workerProviderOverride
            : patch.workerProviderOverride,
        worker_model:
          patch.workerModelOverride === undefined
            ? existing.workerModelOverride
            : patch.workerModelOverride,
        worker_reasoning:
          patch.workerReasoningOverride === undefined
            ? existing.workerReasoningOverride
            : patch.workerReasoningOverride,
        worker_service_tier:
          patch.workerServiceTierOverride === undefined
            ? existing.workerServiceTierOverride
            : patch.workerServiceTierOverride,
        verify_reasoning:
          patch.verifyReasoningOverride === undefined
            ? existing.verifyReasoningOverride
            : patch.verifyReasoningOverride,
        verify_service_tier:
          patch.verifyServiceTierOverride === undefined
            ? existing.verifyServiceTierOverride
            : patch.verifyServiceTierOverride,
        intake_row_id: existing.intakeRowId,
        completion_summary:
          patch.completionSummary === undefined
            ? existing.completionSummary
            : patch.completionSummary,
        accounting_thread_ids:
          patch.accountingThreadIds === undefined
            ? existing.accountingThreadIds.length
              ? JSON.stringify(existing.accountingThreadIds)
              : null
            : patch.accountingThreadIds.length
              ? JSON.stringify([...new Set(patch.accountingThreadIds)])
              : null,
      };
      upsert.run(next);
      return rowToGoal(next);
    },

    setIntakeRow(threadId: string, rowId: string): void {
      writeIntakeRow.run(rowId, threadId);
    },

    clear(threadId: string): boolean {
      return remove.run(threadId).changes > 0;
    },
  };
}

export type GoalStore = ReturnType<typeof createGoalStore>;
