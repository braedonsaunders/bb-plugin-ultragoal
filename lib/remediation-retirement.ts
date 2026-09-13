
/**
 * When a remediation work item stops being work.
 *
 * A finding that is fixed elsewhere — or was never a defect — leaves the slice
 * it minted behind as a ready, unstaffed plan row. The scheduler cannot tell it
 * from real work, so it staffs a worker to re-fix already-guarded code. Two of
 * these survived a resolve pass and stayed ready in the plan.
 *
 * Retirement is deliberately narrow. It only touches an item the plugin minted
 * for a finding (see ItemOrigin), and it removes the row rather than completing
 * it, because completion carries per-defect evidence rules and a shortcut
 * through them would be worth more than the tidiness it buys.
 */
export interface RetirementInput {
  item: { id: string; status: string };
  /**
   * Durable provenance from goal_items.origin. Only "finding" means the plugin
   * minted this row for a defect; anything else — a plan step, a declared
   * deliverable, a legacy row an older build mirrored — is not remediation work.
   */
  origin: string | null;
  /** Every finding that has ever pointed at this item, resolved ones included. */
  linkedFindings: ReadonlyArray<{ status: string }>;
  /** Workers or claims currently holding the item. */
  staffed: boolean;
}

export type RetirementVerdict =
  | { retire: true }
  | { retire: false; reason: string };

export function remediationItemRetirement(input: RetirementInput): RetirementVerdict {
  const { item, origin, linkedFindings, staffed } = input;
  // Ownership is durable, not the mutable finding link. A finding that merely
  // coalesced onto an older item because one concrete file overlapped proves
  // overlap, never authorship — the defect this gate exists to prevent was a
  // dismissed finding deleting the owner's pre-existing held item. An item the
  // plugin did not mint for a finding exists on its own terms and is never
  // removed just because the finding queue went quiet.
  if (origin !== "finding") return { retire: false, reason: "not a remediation item" };
  // Fail closed: with no finding left to reason about, the row may be all that
  // remains of work a crashed mint never linked, so this is not a safe delete.
  if (linkedFindings.length === 0) return { retire: false, reason: "no linked finding" };
  if (item.status !== "pending") return { retire: false, reason: `status is ${item.status}` };
  if (staffed) return { retire: false, reason: "staffed" };
  const open = linkedFindings.filter((finding) => finding.status === "open").length;
  if (open > 0) return { retire: false, reason: `${open} linked finding(s) still open` };
  return { retire: true };
}
