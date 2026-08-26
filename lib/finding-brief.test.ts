import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatLinkedDefectBrief,
  MAX_LINKED_DEFECT_BRIEF_CHARS,
  missingLinkedDefectEvidenceIds,
  parseVerifierFindingEvidence,
  parseVerifierVerdict,
} from "./finding-brief.ts";

describe("linked defect worker briefs", () => {
  const linked = [
    {
      id: "fnd_downgrade",
      title: "Downgrade path loses the original actor",
      file: "src/subscriptions.ts:91",
      evidence: "Calling downgrade overwrites actor provenance before the audit insert.",
      check: "npm test -- subscriptions-downgrade",
    },
    {
      id: "fnd_actor_provenance",
      title: "Actor provenance is missing from the audit row",
      file: "src/subscriptions.ts:118",
      evidence: "The persisted audit row contains a null actor despite an authenticated request.",
      check: "npm test -- actor-provenance",
    },
  ];

  it("enumerates every same-file defect with full evidence and its done-check", () => {
    const brief = formatLinkedDefectBrief(linked);
    for (const finding of linked) {
      assert.match(brief, new RegExp(finding.id));
      assert.match(brief, new RegExp(finding.title));
      assert.match(brief, new RegExp(finding.file));
      assert.match(brief, new RegExp(finding.evidence));
      assert.match(brief, new RegExp(finding.check));
    }
    assert.match(brief, /every one is mandatory/i);
    assert.match(brief, /slice_done must satisfy every linked defect/i);
    assert.ok(brief.length <= MAX_LINKED_DEFECT_BRIEF_CHARS);
  });

  it("requires structured affirmative proof for every exact linked finding id", () => {
    assert.deepEqual(
      missingLinkedDefectEvidenceIds(
        [{ findingId: "fnd_downgrade", proof: "fixed by abc123; test passed" }],
        linked,
      ),
      ["fnd_actor_provenance"],
    );
    assert.deepEqual(
      missingLinkedDefectEvidenceIds(
        [
          { findingId: "fnd_downgrade", proof: "downgrade test passed" },
          { findingId: "FND_ACTOR_PROVENANCE", proof: "audit test passed" },
        ],
        linked,
      ),
      [],
    );
  });

  it("does not accept a longer finding id that merely shares a prefix", () => {
    assert.deepEqual(
      missingLinkedDefectEvidenceIds(
        [
          { findingId: "fnd_downgrade_extra", proof: "fixed" },
          { findingId: "fnd_actor_provenance_extra", proof: "fixed" },
        ],
        linked,
      ),
      ["fnd_downgrade", "fnd_actor_provenance"],
    );
    assert.deepEqual(
      missingLinkedDefectEvidenceIds([{ findingId: "fnd_downgrade", proof: "fixed" }], [
        { id: "fnd_downgrade_extra" },
      ]),
      ["fnd_downgrade_extra"],
    );
  });

  it("parses exact verifier JSONL across case and surrounding output punctuation", () => {
    const parsed = parseVerifierFindingEvidence([
      "Review complete:",
      'DEFECT_COVERAGE: {"finding_id":"FND_DOWNGRADE","status":"PASS","proof":"downgrade check passed"}',
      'DEFECT_COVERAGE: {"finding_id":"fnd_actor_provenance","status":"pass","proof":"audit row inspected"}',
      "VERIFY_PASS: all checks passed.",
    ].join("\n"));
    assert.deepEqual(
      missingLinkedDefectEvidenceIds(parsed, linked),
      [],
    );
  });

  it("does not treat negative prose mentions beside VERIFY_PASS as coverage", () => {
    const parsed = parseVerifierFindingEvidence(
      "fnd_downgrade is NOT fixed; check failed. fnd_actor_provenance also failed.\nVERIFY_PASS: done",
    );
    assert.deepEqual(parsed, []);
    assert.deepEqual(missingLinkedDefectEvidenceIds(parsed, linked), [
      "fnd_downgrade",
      "fnd_actor_provenance",
    ]);
  });

  it("fails duplicate or conflicting coverage for the same exact ID closed", () => {
    const duplicate = parseVerifierFindingEvidence([
      'DEFECT_COVERAGE: {"finding_id":"fnd_downgrade","status":"pass","proof":"first check passed"}',
      'DEFECT_COVERAGE: {"finding_id":"FND_DOWNGRADE","status":"fail","proof":"later check failed"}',
    ].join("\n"));
    assert.deepEqual(duplicate, []);
    const malformedLater = parseVerifierFindingEvidence([
      'DEFECT_COVERAGE: {"finding_id":"fnd_actor_provenance","status":"pass","proof":"first check passed"}',
      'DEFECT_COVERAGE: {"finding_id":"fnd_actor_provenance","status":}',
    ].join("\n"));
    assert.deepEqual(malformedLater, []);
  });

  it("accepts only one exact final verifier verdict line", () => {
    assert.equal(parseVerifierVerdict("Evidence checked.\nVERIFY_PASS: all linked checks passed"), "pass");
    assert.equal(parseVerifierVerdict("VERIFY_FAIL: broken"), "fail");
    assert.equal(
      parseVerifierVerdict("VERIFY_PASS: maybe\nVERIFY_FAIL: actually broken"),
      null,
    );
    assert.equal(
      parseVerifierVerdict("VERIFY_PASS: all good\nTrailing contradictory prose"),
      null,
    );
    assert.equal(
      parseVerifierVerdict("Earlier analysis considered VERIFY_FAIL.\nVERIFY_PASS: all good"),
      null,
    );
    assert.equal(parseVerifierVerdict("The text says VERIFY_PASS somewhere"), null);
  });

  it("keeps a large coalesced group bounded without dropping late defect ids", () => {
    const many = Array.from({ length: 3_000 }, (_, index) => ({
      id: `fnd_scale_${index}`,
      title: `Scaled defect ${index}`,
      file: `src/monolith.ts:${index + 1}`,
      evidence: `Evidence ${index}: ${"x".repeat(1_000)}`,
      check: `npm test -- defect-${index}`,
    }));
    const brief = formatLinkedDefectBrief(many);
    assert.ok(brief.length <= MAX_LINKED_DEFECT_BRIEF_CHARS);
    for (const finding of many) assert.match(brief, new RegExp(`\\b${finding.id}\\b`));
  });
});
