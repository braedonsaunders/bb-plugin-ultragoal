/**
 * Commit attribution inside a resolution note.
 *
 * A finding was closed citing `2e4f7dd`, a commit that does not exist — typed
 * from memory rather than read back. The register accepted it, recorded the
 * finding fixed, and nothing objected. That is the same class the reachability
 * audit exists to count, and it counted ten of them; the API that creates them
 * was letting them through unexamined.
 *
 * Parsing is separated from verification on purpose. Deciding WHAT looks like a
 * commit is pure and can be tested exhaustively; deciding whether that commit
 * EXISTS needs a repository, which the server side of a plugin does not have.
 */

/** A hex run long enough to be a git object and short enough to be a prefix. */
const COMMIT_TOKEN = /\b[0-9a-f]{7,40}\b/gi;

/**
 * Words that are hex-only by coincidence. `deadbeef` and friends are real hex,
 * but a note saying "the accade case" should not be read as a commit citation.
 * Kept deliberately small: a false positive costs a verification lookup, while
 * a false negative is exactly the defect being fixed.
 */
const NOT_A_COMMIT = new Set(["decade", "facade", "deface", "efface", "accede", "cabbage"]);

export interface ParsedAttribution {
  /** Distinct lowercase commit-like tokens, in first-seen order. */
  commits: string[];
  /** Tag-like references, which resolve differently and are not hex. */
  tags: string[];
}

export function parseAttribution(note: string | null | undefined): ParsedAttribution {
  const text = note ?? "";
  const commits: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(COMMIT_TOKEN)) {
    const token = match[0].toLowerCase();
    if (NOT_A_COMMIT.has(token) || seen.has(token)) continue;
    seen.add(token);
    commits.push(token);
  }
  const tags = [...new Set((text.match(/\bv\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g) ?? []))];
  return { commits, tags };
}

/**
 * Three answers, not two. "I looked and it is not there" and "I did not look"
 * are different claims, and collapsing them is how an unverified citation gets
 * recorded as verified — the defect this file exists for.
 */
export type CommitLookup = "present" | "absent" | "unknown";
export type CommitResolver = (token: string) => CommitLookup;

export interface AttributionVerdict {
  /** Tokens the repository was searched for and did not contain. */
  unresolved: string[];
  /** Tokens nobody was able to check at all. */
  unverified: string[];
  /** The note to store: annotated when something did not resolve. */
  note: string;
}

/**
 * Annotate rather than refuse.
 *
 * Refusing the closure outright would let a lookup failure — a detached
 * checkout, a repository not yet fetched — block work that is genuinely done,
 * and an agent that cannot close a slice tends to retry rather than
 * investigate. Recording the doubt in the note keeps the closure honest while
 * leaving it visible to the audit, which is what "fail closed" has to mean for
 * a claim rather than an operation.
 */
export function verifyAttribution(
  note: string,
  resolves: CommitResolver,
  /** Where the lookup happened, so the note can say what was searched. */
  repository?: string | null,
): AttributionVerdict {
  const { commits } = parseAttribution(note);
  const absent: string[] = [];
  const unknown: string[] = [];
  for (const token of commits) {
    let verdict: CommitLookup;
    try {
      verdict = resolves(token);
    } catch {
      verdict = "unknown";
    }
    if (verdict === "absent") absent.push(token);
    else if (verdict === "unknown") unknown.push(token);
  }
  if (absent.length === 0 && unknown.length === 0) {
    return { unresolved: [], unverified: [], note };
  }
  const where = repository ? ` in ${repository}` : "";
  const parts: string[] = [];
  if (absent.length > 0) {
    parts.push(
      `ATTRIBUTION UNRESOLVED: ${absent.join(", ")} — cited as the fix but not resolvable${where}; treat this closure as unverified`,
    );
  }
  if (unknown.length > 0) {
    // Never silently accept. A citation nobody checked is not evidence, and
    // saying so is the difference between an honest register and a confident
    // one.
    parts.push(
      `ATTRIBUTION UNVERIFIED: ${unknown.join(", ")} — no repository was available to check this citation${where ? ` (${repository} was not searchable)` : ""}`,
    );
  }
  return {
    unresolved: absent,
    unverified: unknown,
    note: `${note.trim()} [${parts.join("; ")}]`,
  };
}
