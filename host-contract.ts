import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * Work the server cannot do itself.
 *
 * A slice's worktree lives on the host filesystem, and removing one means git
 * and rm — neither of which the server-side plugin API offers. The host entry
 * runs on the daemon that owns the directory, so the plugin can clean up after
 * its own slices instead of leaving that to whoever notices the disk filling.
 */
export const hostContract = defineRpcContract({
  reclaimWorktree: {
    input: z.object({
      /** Absolute path of the checkout inside the managed worktree. */
      checkoutPath: z.string().min(1),
      /**
       * Branch whose commits must already be reachable from the merge base.
       * The server passes what it just squash-merged.
       */
      mergedInto: z.string().min(1),
      /** Remove even when the checkout is dirty or ahead. Never set routinely. */
      force: z.boolean().default(false),
    }),
    output: z.object({
      removed: z.boolean(),
      freedBytes: z.number(),
      /** Why it was left alone, when it was. */
      reason: z.string().nullable(),
    }),
  },
  /**
   * Does this branch still add anything the base lacks?
   *
   * bb reports a failed squash as `HTTP 502: git merge --squash <branch>
   * failed` and does not pass git's own words through, so matching the message
   * for "already up to date" — which is what 0.25.3 did — can never work. Only
   * the repository can answer, so ask it.
   */
  /** Does this commit-like token resolve to an object in the repository? */
  commitExists: {
    input: z.object({
      checkoutPath: z.string().min(1),
      token: z.string().min(1),
    }),
    output: z.object({ exists: z.boolean() }),
  },
  branchAddsWork: {
    input: z.object({
      checkoutPath: z.string().min(1),
      branch: z.string().min(1),
      base: z.string().min(1),
    }),
    output: z.object({
      adds: z.boolean(),
      /** Null when the question could not be answered; treat that as "adds". */
      reason: z.string().nullable(),
    }),
  },
  /**
   * Replace a checkout's node_modules with a reference-clone of a store copy.
   * Thirteen worktrees each installed the same 1.1 GB tree because one agent =
   * one slice means one worktree per slice.
   */
  shareNodeModules: {
    input: z.object({
      checkoutPath: z.string().min(1),
      /**
       * Directory holding one subtree per lockfile hash. Omitted means the
       * host's own plugin data directory — the server does not know the host's
       * filesystem layout and should not be guessing at it.
       */
      storeDir: z.string().optional(),
      /** Adopt this checkout's tree into the store when it holds nothing yet. */
      seedIfEmpty: z.boolean().default(true),
    }),
    output: z.object({
      shared: z.boolean(),
      seeded: z.boolean(),
      key: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  },
});
