import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GoalFinding, GoalFindingStatus } from "../contract.js";

interface FindingRow {
  id: string;
  thread_id: string;
  fingerprint: string;
  title: string;
  file: string;
  evidence: string;
  status: GoalFindingStatus;
  item_id: string | null;
  resolution_note: string | null;
  created_at: number;
  updated_at: number;
}

// The seen-set key: same file + same defect statement is the same finding,
// however a re-sweep phrases the details. Line numbers shift between sweeps,
// so they are stripped from the file part.
export function fingerprintOf(file: string, title: string): string {
  const normalizedFile = file.trim().toLowerCase().replace(/[:#]\d+([-:]\d+)?$/, "");
  const normalizedTitle = title.trim().toLowerCase().replace(/\s+/g, " ").replace(/\d+/g, "#");
  return createHash("sha1").update(`${normalizedFile}|${normalizedTitle}`).digest("hex").slice(0, 16);
}

function rowToFinding(row: FindingRow): GoalFinding {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    title: row.title,
    file: row.file,
    evidence: row.evidence,
    status: row.status,
    itemId: row.item_id,
    createdAt: row.created_at,
  };
}

function newId(): string {
  return `fnd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createFindingStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  const byThread = db.prepare(
    "SELECT * FROM goal_findings WHERE thread_id = ? ORDER BY created_at ASC",
  );
  const byFingerprint = db.prepare(
    "SELECT * FROM goal_findings WHERE thread_id = ? AND fingerprint = ?",
  );
  const byId = db.prepare("SELECT * FROM goal_findings WHERE thread_id = ? AND id = ?");
  const byItem = db.prepare("SELECT * FROM goal_findings WHERE thread_id = ? AND item_id = ?");
  const insert = db.prepare(`
    INSERT INTO goal_findings (
      id, thread_id, fingerprint, title, file, evidence, status, item_id,
      resolution_note, created_at, updated_at
    ) VALUES (
      @id, @thread_id, @fingerprint, @title, @file, @evidence, @status, @item_id,
      @resolution_note, @created_at, @updated_at
    )
  `);
  const setStatus = db.prepare(`
    UPDATE goal_findings
    SET status = @status, resolution_note = @resolution_note, updated_at = @updated_at
    WHERE thread_id = @thread_id AND id = @id
  `);
  const setItem = db.prepare(
    "UPDATE goal_findings SET item_id = @item_id, updated_at = @updated_at WHERE thread_id = @thread_id AND id = @id",
  );
  const clearStmt = db.prepare("DELETE FROM goal_findings WHERE thread_id = ?");

  return {
    /** Records a finding; a repeat fingerprint returns the existing one instead. */
    report(
      threadId: string,
      input: { title: string; file: string; evidence: string },
    ): { created: boolean; finding: GoalFinding } {
      const fingerprint = fingerprintOf(input.file, input.title);
      const existing = byFingerprint.get(threadId, fingerprint) as FindingRow | undefined;
      if (existing) return { created: false, finding: rowToFinding(existing) };
      const now = Date.now();
      const row: FindingRow = {
        id: newId(),
        thread_id: threadId,
        fingerprint,
        title: input.title.trim(),
        file: input.file.trim(),
        evidence: input.evidence.trim(),
        status: "open",
        item_id: null,
        resolution_note: null,
        created_at: now,
        updated_at: now,
      };
      insert.run(row);
      return { created: true, finding: rowToFinding(row) };
    },

    linkItem(threadId: string, findingId: string, itemId: string): void {
      setItem.run({ thread_id: threadId, id: findingId, item_id: itemId, updated_at: Date.now() });
    },

    get(threadId: string, ref: string): GoalFinding | null {
      const viaId = byId.get(threadId, ref) as FindingRow | undefined;
      if (viaId) return rowToFinding(viaId);
      const viaFp = byFingerprint.get(threadId, ref) as FindingRow | undefined;
      return viaFp ? rowToFinding(viaFp) : null;
    },

    list(threadId: string, status?: GoalFindingStatus): GoalFinding[] {
      const rows = (byThread.all(threadId) as FindingRow[]).map(rowToFinding);
      return status ? rows.filter((finding) => finding.status === status) : rows;
    },

    counts(threadId: string): { open: number; fixed: number; dismissed: number } {
      const rows = byThread.all(threadId) as FindingRow[];
      return {
        open: rows.filter((row) => row.status === "open").length,
        fixed: rows.filter((row) => row.status === "fixed").length,
        dismissed: rows.filter((row) => row.status === "dismissed").length,
      };
    },

    resolve(
      threadId: string,
      ref: string,
      status: Exclude<GoalFindingStatus, "open">,
      note: string,
    ): GoalFinding | null {
      const finding = this.get(threadId, ref);
      if (!finding) return null;
      setStatus.run({
        thread_id: threadId,
        id: finding.id,
        status,
        resolution_note: note.trim() || null,
        updated_at: Date.now(),
      });
      return this.get(threadId, finding.id);
    },

    /** A completed fix slice closes every finding that spawned it. */
    markFixedByItem(threadId: string, itemId: string, note: string): number {
      const rows = (byItem.all(threadId, itemId) as FindingRow[]).filter(
        (row) => row.status === "open",
      );
      for (const row of rows) {
        setStatus.run({
          thread_id: threadId,
          id: row.id,
          status: "fixed",
          resolution_note: note.trim().slice(0, 400) || null,
          updated_at: Date.now(),
        });
      }
      return rows.length;
    },

    clear(threadId: string): void {
      clearStmt.run(threadId);
    },
  };
}

export type FindingStore = ReturnType<typeof createFindingStore>;
