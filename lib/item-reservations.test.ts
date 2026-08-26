import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createItemReservationStore } from "./item-reservations.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function connections() {
  const dir = mkdtempSync(join(tmpdir(), "ultragoal-claims-"));
  dirs.push(dir);
  const path = join(dir, "data.db");
  const first = new Database(path);
  first.pragma("journal_mode = WAL");
  first.pragma("busy_timeout = 5000");
  first.exec(`
    CREATE TABLE collab_agents (
      thread_id TEXT PRIMARY KEY,
      root_thread_id TEXT NOT NULL,
      item_id TEXT,
      role TEXT,
      retired_at INTEGER
    );
    CREATE TABLE collab_item_reservations (
      root_thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      claim_token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      slot_limit INTEGER NOT NULL,
      PRIMARY KEY (root_thread_id, item_id)
    );
    CREATE TABLE collab_root_worker_caps (
      root_thread_id TEXT PRIMARY KEY,
      max_workers INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TRIGGER collab_agents_one_live_item_insert
      BEFORE INSERT ON collab_agents
      WHEN NEW.retired_at IS NULL
        AND NEW.item_id IS NOT NULL
        AND COALESCE(NEW.role, 'worker') != 'verifier'
        AND EXISTS (
          SELECT 1 FROM collab_agents
          WHERE root_thread_id = NEW.root_thread_id
            AND item_id = NEW.item_id
            AND retired_at IS NULL
            AND COALESCE(role, 'worker') != 'verifier'
        )
      BEGIN
        SELECT RAISE(ABORT, 'work item already has a live worker');
      END;
    CREATE TRIGGER collab_agents_root_capacity_insert
      BEFORE INSERT ON collab_agents
      WHEN NEW.retired_at IS NULL
        AND COALESCE(NEW.role, 'worker') != 'verifier'
        AND EXISTS (
          SELECT 1 FROM collab_root_worker_caps WHERE root_thread_id = NEW.root_thread_id
        )
        AND (
          (SELECT COUNT(*) FROM collab_agents
           WHERE root_thread_id = NEW.root_thread_id
             AND retired_at IS NULL
             AND COALESCE(role, 'worker') != 'verifier')
          +
          (SELECT COUNT(*) FROM collab_item_reservations
           WHERE root_thread_id = NEW.root_thread_id
             AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
             AND (NEW.item_id IS NULL OR item_id != NEW.item_id))
        ) >= (SELECT max_workers FROM collab_root_worker_caps
              WHERE root_thread_id = NEW.root_thread_id)
      BEGIN
        SELECT RAISE(ABORT, 'root worker capacity is full');
      END;
    CREATE TRIGGER collab_agents_root_capacity_update
      BEFORE UPDATE OF root_thread_id, role, retired_at ON collab_agents
      WHEN NEW.retired_at IS NULL
        AND COALESCE(NEW.role, 'worker') != 'verifier'
        AND EXISTS (
          SELECT 1 FROM collab_root_worker_caps WHERE root_thread_id = NEW.root_thread_id
        )
        AND (
          (SELECT COUNT(*) FROM collab_agents
           WHERE root_thread_id = NEW.root_thread_id
             AND thread_id != OLD.thread_id
             AND retired_at IS NULL
             AND COALESCE(role, 'worker') != 'verifier')
          +
          (SELECT COUNT(*) FROM collab_item_reservations
           WHERE root_thread_id = NEW.root_thread_id
             AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
             AND (NEW.item_id IS NULL OR item_id != NEW.item_id))
        ) >= (SELECT max_workers FROM collab_root_worker_caps
              WHERE root_thread_id = NEW.root_thread_id)
      BEGIN
        SELECT RAISE(ABORT, 'root worker capacity is full');
      END;
  `);
  const second = new Database(path);
  second.pragma("journal_mode = WAL");
  second.pragma("busy_timeout = 5000");
  return { first, second };
}

describe("durable scheduler item reservations", () => {
  it("allows only one pre-spawn owner across independent SQLite connections", () => {
    const { first, second } = connections();
    try {
      const oldGeneration = createItemReservationStore(first);
      const newGeneration = createItemReservationStore(second);
      const token = oldGeneration.acquire("thr_root", "itm_shared", 1);
      assert.ok(token);
      assert.equal(newGeneration.acquire("thr_root", "itm_shared", 1), null);

      assert.equal(
        oldGeneration.commit("thr_root", "itm_shared", token, () => {
          first.prepare(`
            INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
            VALUES ('thr_worker', 'thr_root', 'itm_shared', 'worker')
          `).run();
        }),
        true,
      );
      assert.throws(
        () => second.prepare(`
          INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
          VALUES ('thr_late_old_generation', 'thr_root', 'itm_shared', 'worker')
        `).run(),
        /already has a live worker|root worker capacity is full/,
        "an old generation that passed its pre-spawn check cannot land a duplicate after commit",
      );
      assert.equal(newGeneration.acquire("thr_root", "itm_shared", 1), null);
      assert.equal(
        (first.prepare("SELECT COUNT(*) AS n FROM collab_agents").get() as { n: number }).n,
        1,
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it("enforces maxWorkers across different items and plugin generations", () => {
    const { first, second } = connections();
    try {
      const oldGeneration = createItemReservationStore(first);
      const newGeneration = createItemReservationStore(second);
      const firstToken = oldGeneration.acquire("thr_root", "itm_a", 1);
      assert.ok(firstToken);
      assert.equal(newGeneration.acquire("thr_root", "itm_a", 1), null);
      assert.equal(
        newGeneration.acquire("thr_root", "itm_b", 1),
        null,
        "a reservation for item A must consume the root's only worker slot",
      );
      assert.equal(
        oldGeneration.commit("thr_root", "itm_a", firstToken, () => {
          first.prepare(`
            INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
            VALUES ('thr_a', 'thr_root', 'itm_a', 'worker')
          `).run();
        }),
        true,
      );
      assert.throws(
        () => second.prepare(`
          INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
          VALUES ('thr_b', 'thr_root', 'itm_b', 'worker')
        `).run(),
        /root worker capacity is full/,
        "a v0.17.14 spawn returning after item A commits must be rejected at storage",
      );
      assert.equal(newGeneration.acquire("thr_root", "itm_b", 1), null);
      assert.deepEqual(
        first.prepare(
          "SELECT thread_id, item_id FROM collab_agents WHERE retired_at IS NULL ORDER BY thread_id",
        ).all(),
        [{ thread_id: "thr_a", item_id: "itm_a" }],
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it("fails an expired reservation closed when another worker lands before commit", () => {
    const { first, second } = connections();
    try {
      const reservation = createItemReservationStore(first);
      const token = reservation.acquire("thr_root", "itm_rescue", 1);
      assert.ok(token);
      second.prepare(`
        UPDATE collab_item_reservations SET expires_at = 0
        WHERE root_thread_id = 'thr_root' AND item_id = 'itm_rescue'
      `).run();
      second.prepare(`
        INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
        VALUES ('thr_winner', 'thr_root', 'itm_rescue', 'worker')
      `).run();
      let inserted = false;
      assert.equal(
        reservation.commit("thr_root", "itm_rescue", token, () => {
          inserted = true;
        }),
        false,
      );
      assert.equal(inserted, false);
      assert.equal(
        (first.prepare("SELECT thread_id FROM collab_agents").get() as { thread_id: string }).thread_id,
        "thr_winner",
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it("fences a legacy different-item insert while a reservation is in flight", () => {
    const { first, second } = connections();
    try {
      const reservation = createItemReservationStore(first);
      const token = reservation.acquire("thr_root", "itm_reserved", 1);
      assert.ok(token);
      assert.throws(
        () => second.prepare(`
          INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
          VALUES ('thr_legacy', 'thr_root', 'itm_other', 'worker')
        `).run(),
        /root worker capacity is full/,
      );
      assert.equal(
        reservation.commit("thr_root", "itm_reserved", token, () => {
          first.prepare(`
            INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
            VALUES ('thr_reserved', 'thr_root', 'itm_reserved', 'worker')
          `).run();
        }),
        true,
      );
      assert.deepEqual(
        first.prepare("SELECT thread_id, item_id FROM collab_agents").all(),
        [{ thread_id: "thr_reserved", item_id: "itm_reserved" }],
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it("lets a legacy child that lands first consume the slot and rejects the new reservation", () => {
    const { first, second } = connections();
    try {
      second.prepare(`
        INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
        VALUES ('thr_legacy_first', 'thr_root', 'itm_b', 'worker')
      `).run();
      const reservation = createItemReservationStore(first);
      assert.equal(reservation.acquire("thr_root", "itm_a", 1), null);
      assert.deepEqual(
        first.prepare("SELECT thread_id, item_id FROM collab_agents").all(),
        [{ thread_id: "thr_legacy_first", item_id: "itm_b" }],
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it("fences revival or adoption updates after the root slot is full", () => {
    const { first, second } = connections();
    try {
      const reservations = createItemReservationStore(first);
      const token = reservations.acquire("thr_root", "itm_a", 1);
      assert.ok(token);
      assert.equal(
        reservations.commit("thr_root", "itm_a", token, () => {
          first.prepare(`
            INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
            VALUES ('thr_a', 'thr_root', 'itm_a', 'worker')
          `).run();
        }),
        true,
      );
      second.prepare(`
        INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role, retired_at)
        VALUES ('thr_b', 'thr_root', NULL, 'worker', 1)
      `).run();
      assert.throws(
        () => second.prepare(`
          UPDATE collab_agents SET retired_at = NULL, item_id = 'itm_b'
          WHERE thread_id = 'thr_b'
        `).run(),
        /root worker capacity is full/,
      );
      assert.deepEqual(
        first.prepare(`
          SELECT thread_id, item_id FROM collab_agents
          WHERE retired_at IS NULL ORDER BY thread_id
        `).all(),
        [{ thread_id: "thr_a", item_id: "itm_a" }],
      );
    } finally {
      first.close();
      second.close();
    }
  });
});
