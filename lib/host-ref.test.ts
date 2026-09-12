import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommit } from "../host.ts";

const repositories: string[] = [];

afterEach(() => {
  while (repositories.length > 0) rmSync(repositories.pop()!, { recursive: true, force: true });
});

function repository() {
  const path = mkdtempSync(join(tmpdir(), "ultragoal-ref-"));
  repositories.push(path);
  execFileSync("git", ["init", "-b", "main"], { cwd: path });
  execFileSync("git", ["config", "user.name", "UltraGoal Test"], { cwd: path });
  execFileSync("git", ["config", "user.email", "ultragoal@example.invalid"], { cwd: path });
  writeFileSync(join(path, "file.txt"), "one\n");
  execFileSync("git", ["add", "file.txt"], { cwd: path });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: path });
  execFileSync("git", ["tag", "-a", "release", "-m", "release"], { cwd: path });
  return path;
}

describe("host commit-ish validation", () => {
  it("peels SHA, branch, and annotated tag to the same commit", async () => {
    const path = repository();
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
    for (const token of [sha, "main", "release"]) {
      const result = await resolveCommit(path, token);
      assert.deepEqual(result, { status: "valid", commit: sha, repository: path });
    }
  });

  it("rejects missing and non-commit refs without classifying repository failures as input", async () => {
    const path = repository();
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: path, encoding: "utf8" }).trim();
    for (const token of ["missing-ref", tree]) {
      const result = await resolveCommit(path, token);
      assert.equal(result.status, "invalid");
      assert.equal(result.repository, path);
    }
    const unavailable = await resolveCommit(join(path, "absent"), "main");
    assert.equal(unavailable.status, "operational_error");
  });
});
