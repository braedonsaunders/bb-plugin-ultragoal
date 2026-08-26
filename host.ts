import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, rename, stat, readdir, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { hostContract } from "./host-contract.ts";

const run = promisify(execFile);

/**
 * Filesystem work on the daemon that owns the worktree.
 *
 * The plugin creates a worktree per slice and, until this existed, never
 * removed one: 217 worktrees and 9.9 GB for a goal with 177 completed items,
 * plus thirteen private copies of the same 1.1 GB dependency tree. Cleaning up
 * after itself is the plugin's job, not a chore for whoever notices the disk.
 */

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function directoryBytes(path: string): Promise<number> {
  try {
    const { stdout } = await run("du", ["-sk", path], { maxBuffer: 4 * 1024 * 1024 });
    return Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "0", 10) * 1024;
  } catch {
    return 0;
  }
}

/** Which dependency set a checkout belongs to; a wrong tree is worse than none. */
async function lockKey(checkoutPath: string): Promise<string | null> {
  for (const name of ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "package.json"]) {
    try {
      const body = await readFile(join(checkoutPath, name));
      return createHash("sha256").update(body).digest("hex").slice(0, 16);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Copy by reference where the filesystem supports it (APFS clonefile, Btrfs
 * reflink). `-c` FAILS rather than falling back to a full copy, which is the
 * point: a silent 1.1 GB duplicate is the thing being prevented.
 */
async function cloneTree(from: string, to: string): Promise<boolean> {
  for (const args of [["-c", "-R", from, to], ["--reflink=always", "-r", from, to]]) {
    try {
      await run("cp", args, { maxBuffer: 4 * 1024 * 1024 });
      return true;
    } catch {
      // try the next dialect
    }
  }
  return false;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async reclaimWorktree({ checkoutPath, mergedInto, force }) {
      const keep = (reason: string) => ({ removed: false, freedBytes: 0, reason });
      try {
        await stat(join(checkoutPath, ".git"));
      } catch {
        return keep("not a checkout");
      }

      let branch = "";
      let commonDir = "";
      try {
        branch = await git(checkoutPath, "rev-parse", "--abbrev-ref", "HEAD");
        commonDir = await git(checkoutPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
      } catch {
        return keep("git could not read the checkout");
      }

      if (!force) {
        // Uncommitted work is unrecoverable once the directory is gone, so it
        // outranks any disk saving.
        const dirty = await git(checkoutPath, "status", "--porcelain").catch(() => "x");
        if (dirty.length > 0) return keep("checkout has uncommitted changes");
        // Three dots, and the distinction is the whole check. An ancestor test
        // declines every squash-merge, because squashing rewrites the work into
        // a new commit. A two-dot diff declines almost as often for the
        // opposite reason: the base has moved on, and every later commit on it
        // reads as a difference. `base...HEAD` asks the only question that
        // matters — does this branch still ADD anything the base lacks — by
        // diffing from where the two parted company.
        try {
          await git(checkoutPath, "diff", "--quiet", `${mergedInto}...HEAD`);
        } catch {
          return keep(`still adds work ${mergedInto} does not have`);
        }
      }

      // The managed worktree is the directory that CONTAINS the checkout; the
      // server hands over <worktrees>/<env>/<repo> and the environment owns
      // the level above it.
      const envDir = dirname(checkoutPath);
      const freedBytes = await directoryBytes(envDir);
      try {
        await git(checkoutPath, "worktree", "remove", "--force", checkoutPath);
      } catch {
        // A worktree git has already forgotten still leaves its files behind.
      }
      await rm(envDir, { recursive: true, force: true });

      const mainRepo = commonDir.replace(/\/\.git$/, "");
      if (mainRepo) {
        await git(mainRepo, "worktree", "prune").catch(() => "");
        if (branch && branch !== "HEAD") {
          await git(mainRepo, "branch", "-D", branch).catch(() => "");
        }
      }
      return { removed: true, freedBytes, reason: null };
    },

    async shareNodeModules({ checkoutPath, storeDir, seedIfEmpty }, context) {
      const key = await lockKey(checkoutPath);
      if (!key) return { shared: false, seeded: false, key: null, reason: "no lockfile or package.json" };
      const store = storeDir ?? join(context.experimental_paths.dataDir, "node-modules-store");
      const storePath = join(store, key);

      let storeHas = false;
      try {
        storeHas = (await readdir(storePath)).length > 0;
      } catch {
        storeHas = false;
      }

      const target = join(checkoutPath, "node_modules");
      let checkoutHas = false;
      try {
        checkoutHas = (await readdir(target)).length > 0;
      } catch {
        checkoutHas = false;
      }

      if (!storeHas) {
        if (!seedIfEmpty || !checkoutHas) {
          return { shared: false, seeded: false, key, reason: "store is empty and there is nothing to seed it with" };
        }
        await mkdir(store, { recursive: true });
        // Land under a temporary name and rename: a half-written store entry
        // would be cloned into every later worktree.
        const staging = `${storePath}.incoming.${process.pid}`;
        await rm(staging, { recursive: true, force: true });
        if (!(await cloneTree(target, staging))) {
          await rm(staging, { recursive: true, force: true });
          return { shared: false, seeded: false, key, reason: "filesystem does not support copy-by-reference" };
        }
        await rename(staging, storePath);
        return { shared: false, seeded: true, key, reason: null };
      }

      if (checkoutHas) return { shared: false, seeded: false, key, reason: "checkout already has node_modules" };

      const staging = join(checkoutPath, `node_modules.incoming.${process.pid}`);
      await rm(staging, { recursive: true, force: true });
      if (!(await cloneTree(storePath, staging))) {
        await rm(staging, { recursive: true, force: true });
        return { shared: false, seeded: false, key, reason: "filesystem does not support copy-by-reference" };
      }
      await rename(staging, target);
      return { shared: true, seeded: false, key, reason: null };
    },
  },
});
