import type { RemediationFinding } from "./findings.js";

/** A pathological audit must never make a scheduler prompt grow without a
 * bound. When even the exact-ID manifest cannot fit, formatting fails closed
 * so the scheduler cannot hide defect scope by truncating identifiers. */
export const MAX_LINKED_DEFECT_BRIEF_CHARS = 64_000;

export interface FindingAffirmativeEvidence {
  findingId: string;
  proof: string;
}

function clip(text: string, limit: number): string {
  const normalized = text.trim();
  if (normalized.length <= limit) return normalized;
  if (limit <= 0) return "";
  const marker = "…[truncated]";
  if (limit <= marker.length) return normalized.slice(0, limit);
  return `${normalized.slice(0, limit - marker.length)}${marker}`;
}

function completionContract(): string {
  return [
    "slice_done must satisfy every linked defect with finding_evidence entries containing the exact finding_id and nonempty affirmative proof.",
    'A verifier must emit one machine-readable line per defect: DEFECT_COVERAGE: {"finding_id":"fnd_...","status":"pass","proof":"what was checked"}. Prose mentions and negative findings do not count.',
  ].join(" ");
}

export function formatLinkedDefectBrief(
  linked: readonly Pick<
    RemediationFinding,
    "id" | "title" | "file" | "evidence" | "check"
  >[],
): string {
  if (linked.length === 0) return "";
  const header = [
    `LINKED DEFECTS (${linked.length}; every one is mandatory for this work item):`,
    "Related defects share this implementation unit, but none may be omitted.",
  ].join("\n");
  const footer = completionContract();
  const blocks = linked.map((finding) => [
    `- ${finding.id}`,
    `  Title: ${clip(finding.title, 500)}`,
    `  Evidence file: ${clip(finding.file, 1_000)}`,
    `  Full evidence: ${clip(finding.evidence, 4_000)}`,
    `  Done-check: ${finding.check ? clip(finding.check, 2_000) : "(no defect-specific check; the work-item check still applies)"}`,
  ].join("\n"));
  const full = [header, ...blocks, footer].join("\n\n");
  if (full.length <= MAX_LINKED_DEFECT_BRIEF_CHARS) return full;

  // Keep every exact ID even when verbose legacy evidence cannot fit. Detail
  // rows use the same order as the manifest, avoiding repeated long IDs.
  const ids = linked.map((finding) => finding.id).join(",");
  const compactHeader = `${header}\nExact mandatory finding IDs (detail rows use this order):\n${ids}`;
  const base = `${compactHeader}\n\n${footer}`;
  if (base.length > MAX_LINKED_DEFECT_BRIEF_CHARS) {
    throw new Error(
      `linked defect ID manifest requires ${base.length} characters; refusing to spawn with hidden scope`,
    );
  }
  const remaining = MAX_LINKED_DEFECT_BRIEF_CHARS - base.length;
  const perFinding = Math.floor(Math.max(0, remaining - linked.length - 2) / linked.length);
  if (perFinding < 8) return base;
  const details = linked.map((finding) => {
    const prefix = "T=|F=|E=|C=";
    const payload = Math.max(0, perFinding - prefix.length);
    const title = Math.floor(payload * 0.18);
    const file = Math.floor(payload * 0.18);
    const evidence = Math.floor(payload * 0.44);
    const check = Math.max(0, payload - title - file - evidence);
    return `T=${clip(finding.title, title)}|F=${clip(finding.file, file)}|E=${clip(finding.evidence, evidence)}|C=${clip(finding.check ?? "(none)", check)}`;
  });
  const bounded = `${compactHeader}\n\nBounded detail rows (T=title, F=file, E=evidence, C=check):\n${details.join("\n")}\n\n${footer}`;
  if (bounded.length > MAX_LINKED_DEFECT_BRIEF_CHARS) {
    throw new Error("linked defect brief bound calculation overflowed");
  }
  return bounded;
}

/** Only structured tool fields count. A finding ID appearing in prose is not
 * evidence, and a prefix collision cannot satisfy another finding. */
export function missingLinkedDefectEvidenceIds(
  evidence: readonly FindingAffirmativeEvidence[] | null | undefined,
  linked: readonly Pick<RemediationFinding, "id">[],
): string[] {
  const proven = new Set(
    (evidence ?? [])
      .filter((entry) => entry.proof.trim().length > 0 && /^fnd_[a-z0-9_]+$/i.test(entry.findingId))
      .map((entry) => entry.findingId.toLowerCase()),
  );
  return linked
    .map((finding) => finding.id)
    .filter((id) => !proven.has(id.toLowerCase()));
}

/** Parse only the documented JSONL coverage contract. Free-form mentions —
 * including "fnd_x is NOT fixed" beside VERIFY_PASS — are intentionally
 * invisible to completion logic.
 *
 * Both roles emit this contract: a verifier alongside its verdict, and a worker
 * whose provider cannot dispose the `slice_done` tool as its turn ends and so
 * reports through the ULTRAGOAL_DONE sentinel instead. The evidence bar is
 * identical either way — exact finding id, status pass, nonempty proof. */
export function parseDefectCoverageEvidence(
  output: string | null | undefined,
): FindingAffirmativeEvidence[] {
  const byId = new Map<string, FindingAffirmativeEvidence>();
  const invalid = new Set<string>();
  for (const line of (output ?? "").split(/\r?\n/)) {
    const match = /^\s*DEFECT_COVERAGE:\s*(\{.*\})\s*$/i.exec(line);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]!) as Record<string, unknown>;
      const findingId = typeof parsed.finding_id === "string" ? parsed.finding_id.trim() : "";
      const proof = typeof parsed.proof === "string" ? parsed.proof.trim() : "";
      const status = typeof parsed.status === "string" ? parsed.status.toLowerCase() : "";
      if (!/^fnd_[a-z0-9_]+$/i.test(findingId)) continue;
      const key = findingId.toLowerCase();
      if (byId.has(key) || invalid.has(key) || status !== "pass" || !proof) {
        byId.delete(key);
        invalid.add(key);
        continue;
      }
      byId.set(key, { findingId, proof });
    } catch {
      // If a malformed duplicate still names an ID, invalidate any earlier
      // pass for that same ID instead of retaining the permissive result.
      const named = /["']finding_id["']\s*:\s*["'](fnd_[a-z0-9_]+)["']/i.exec(match[1]!)?.[1];
      if (named) {
        const key = named.toLowerCase();
        byId.delete(key);
        invalid.add(key);
      }
    }
  }
  return [...byId.values()];
}

/** One unambiguous final verdict line. A PASS token in prose, a trailing
 * paragraph, duplicate verdicts, or PASS+FAIL output is not a verdict. */
export function parseVerifierVerdict(
  output: string | null | undefined,
): "pass" | "fail" | null {
  const lines = (output ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  // Reject stray verdict tokens in prose as well as two formally shaped
  // verdict lines. Otherwise contradictory output could look unambiguous
  // merely because only its final token followed the line protocol.
  const verdictTokens = (output ?? "").match(/\bVERIFY_(?:PASS|FAIL)\b/gi) ?? [];
  const final = /^VERIFY_(PASS|FAIL):\s*(\S.*)$/i.exec(lines.at(-1)!);
  if (!final || verdictTokens.length !== 1) return null;
  return final[1]!.toLowerCase() as "pass" | "fail";
}
