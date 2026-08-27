import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAttribution, verifyAttribution } from "./attribution.ts";

// The real incident: d29990c is the commit that carried the fix and v0.26.0
// points at it; 2e4f7dd was typed from memory and does not exist.
const REAL = new Set(["d29990c", "d29990c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7"]);
const resolves = (token: string): "present" | "absent" =>
  [...REAL].some((sha) => sha.startsWith(token)) ? "present" : "absent";

describe("parsing an attribution", () => {
  it("finds a short commit citation", () => {
    assert.deepEqual(parseAttribution("fixed in d29990c").commits, ["d29990c"]);
  });

  it("finds a full-length sha and a tag alongside it", () => {
    const p = parseAttribution("landed as d29990c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7, tagged v0.26.0");
    assert.deepEqual(p.commits, ["d29990c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7"]);
    assert.deepEqual(p.tags, ["v0.26.0"]);
  });

  it("is case-insensitive and does not report the same commit twice", () => {
    assert.deepEqual(parseAttribution("D29990C and d29990c").commits, ["d29990c"]);
  });

  it("ignores runs too short to be a commit", () => {
    assert.deepEqual(parseAttribution("abc123 and ffff").commits, []);
  });

  it("does not mistake an ordinary hex-looking word for a commit", () => {
    assert.deepEqual(parseAttribution("a facade over the decade").commits, []);
  });

  it("reports nothing for a note that cites no commit at all", () => {
    assert.deepEqual(parseAttribution("worker says the guard is in place").commits, []);
    assert.deepEqual(parseAttribution(null).commits, []);
  });
});

describe("verifying an attribution", () => {
  it("leaves a resolvable citation untouched", () => {
    const v = verifyAttribution("fixed in d29990c", resolves);
    assert.deepEqual(v.unresolved, []);
    assert.equal(v.note, "fixed in d29990c");
  });

  it("marks the exact incident: a commit-shaped token that does not exist", () => {
    const v = verifyAttribution("resolved against 2e4f7dd", resolves);
    assert.deepEqual(v.unresolved, ["2e4f7dd"]);
    assert.match(v.note, /ATTRIBUTION UNRESOLVED: 2e4f7dd/);
    assert.match(v.note, /treat this closure as unverified/);
  });

  it("names only the token that failed when a note cites both", () => {
    const v = verifyAttribution("superseded 2e4f7dd, actually d29990c", resolves);
    assert.deepEqual(v.unresolved, ["2e4f7dd"]);
    assert.match(v.note, /2e4f7dd/);
  });

  it("separates 'looked and absent' from 'never looked'", () => {
    // Collapsing these is how an unchecked citation gets recorded as verified.
    const absent = verifyAttribution("resolved against 2e4f7dd", resolves, "openbooks");
    assert.deepEqual(absent.unresolved, ["2e4f7dd"]);
    assert.deepEqual(absent.unverified, []);
    assert.match(absent.note, /UNRESOLVED: 2e4f7dd .* not resolvable in openbooks/);

    const never = verifyAttribution("fixed in d29990c", () => "unknown");
    assert.deepEqual(never.unresolved, []);
    assert.deepEqual(never.unverified, ["d29990c"]);
    assert.match(never.note, /UNVERIFIED: d29990c/);
  });

  it("treats a resolver that throws as not-checked, never as a bad citation", () => {
    const v = verifyAttribution("fixed in d29990c", () => {
      throw new Error("not a git repository");
    });
    assert.deepEqual(v.unresolved, []);
    assert.deepEqual(v.unverified, ["d29990c"]);
  });

  it("annotates rather than refuses, so a lookup failure cannot block real work", () => {
    const v = verifyAttribution("resolved against 2e4f7dd", resolves);
    assert.ok(v.note.startsWith("resolved against 2e4f7dd"), "the original note survives");
  });
});
