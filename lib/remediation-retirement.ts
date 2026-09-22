
/**
 * When a remediation work item stops being work.
 *
 * A finding that is fixed elsewhere — or was never a defect — leaves the slice
 * it minted behind as a ready, unstaffed plan row. The scheduler cannot tell it
 * from real work, so it staffs a worker to re-fix already-guarded code. Two of
 * these survived a resolve pass and stayed ready in the plan.
 *
 * Retirement is deliberately narrow. It removes the row rather than completing
 * it, because completion carries per-defect evidence rules and a shortcut
 * through them would be worth more than the tidiness it buys.
 */
export interface RetirementInput {
  item: { id: string; status: string };
  /** Only `finding` proves that the plugin, rather than a user plan, owns it. */
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
  // A mutable finding link proves overlap, never ownership. Only the dedicated
  // mint seam may make a row disposable when its findings are resolved.
  if (origin !== "finding") return { retire: false, reason: "not a remediation item" };
  if (linkedFindings.length === 0) return { retire: false, reason: "no linked finding" };
  if (item.status !== "pending") return { retire: false, reason: `status is ${item.status}` };
  if (staffed) return { retire: false, reason: "staffed" };
  const open = linkedFindings.filter((finding) => finding.status === "open").length;
  if (open > 0) return { retire: false, reason: `${open} linked finding(s) still open` };
  return { retire: true };
}
