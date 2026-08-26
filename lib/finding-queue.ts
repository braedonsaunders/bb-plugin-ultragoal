import type { FindingStore } from "./findings.js";
import { currentSliceTitle, type ItemStore } from "./items.js";
import { findingAction, findingMatchesItem, normalizeFindingFile } from "./scheduler.js";

export interface FindingQueueResult {
  linked: number;
  minted: number;
  autoFixed: number;
  requeuedMissing: number;
  requeuedInvalid: number;
  healedDuplicates: number;
  remediationWorkItems: number;
  awaitingAssignment: number;
}

export interface StaleFindingLinkResult {
  requeuedMissing: number;
  requeuedInvalid: number;
}

/** Detach open links that no longer have direct concrete-file evidence. The
 * updates are durable and idempotent; the ordinary queue pass decides what
 * valid work receives the detached findings next. */
export function detachStaleFindingLinks(input: {
  threadId: string;
  findings: FindingStore;
  items: ItemStore;
  itemId?: string;
}): StaleFindingLinkResult {
  const itemById = new Map(input.items.list(input.threadId).map((item) => [item.id, item]));
  const queue = input.findings.remediationQueue(input.threadId);
  const primaryByItem = new Map<string, string>();
  // Creator identity survives resolution. If the historical primary is fixed
  // or dismissed, a later open coalesced row must not silently inherit the
  // primary exception merely because remediationQueue contains open rows only.
  for (const finding of input.findings.list(input.threadId)) {
    if (finding.itemId && !primaryByItem.has(finding.itemId)) {
      primaryByItem.set(finding.itemId, finding.id);
    }
  }
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const finding of queue) {
    if (!finding.itemId) continue;
    if (input.itemId && finding.itemId !== input.itemId) continue;
    const item = itemById.get(finding.itemId);
    if (!item) {
      missing.push(finding.id);
      continue;
    }
    // The oldest link across every status is the durable creator association.
    // Historical reports sometimes used a generated migration line as evidence
    // while their repair work correctly owned a schema source file. Preserve
    // that primary; later coalesced links must prove concrete-file overlap.
    if (primaryByItem.get(finding.itemId) === finding.id) continue;
    if (!findingMatchesItem(finding.id, finding.file, finding.fixFiles, item)) {
      invalid.push(finding.id);
    }
  }
  return {
    requeuedMissing: input.findings.unlinkItems(input.threadId, missing),
    requeuedInvalid: input.findings.unlinkItems(input.threadId, invalid),
  };
}

export interface FindingCompletionResult extends StaleFindingLinkResult {
  fixed: number;
}

/**
 * Repair the narrow v0.17.13 false-negative aftermath: a valid finding may
 * already have been backfilled into a new scheduler-generated singleton.
 * Only an unclaimed pending item with the exact auto-mint title is eligible,
 * and only when an older, noncompleted item strongly matches the finding.
 */
export function healAutoMintedFindingDuplicates(input: {
  threadId: string;
  findings: FindingStore;
  items: ItemStore;
}): number {
  const { threadId, findings, items } = input;
  const allItems = items.list(threadId);
  const itemById = new Map(allItems.map((item) => [item.id, item]));
  const creationOrder = items.creationOrder(threadId);
  const age = new Map(creationOrder.map((id, index) => [id, index]));
  allItems.sort((left, right) => (age.get(left.id) ?? 0) - (age.get(right.id) ?? 0));
  const open = findings.remediationQueue(threadId);
  const all = findings.list(threadId);
  const openByItem = new Map<string, typeof open>();
  const allByItem = new Map<string, typeof all>();
  for (const finding of open) {
    if (!finding.itemId) continue;
    const linked = openByItem.get(finding.itemId) ?? [];
    linked.push(finding);
    openByItem.set(finding.itemId, linked);
  }
  for (const finding of all) {
    if (!finding.itemId) continue;
    const linked = allByItem.get(finding.itemId) ?? [];
    linked.push(finding);
    allByItem.set(finding.itemId, linked);
  }

  const removed = new Set<string>();
  let healed = 0;
  for (const finding of open) {
    if (!finding.itemId || removed.has(finding.itemId)) continue;
    const current = itemById.get(finding.itemId);
    if (!current || current.status !== "pending") continue;
    const autoMintedStep = currentSliceTitle(
      `Fix: ${finding.title} [${normalizeFindingFile(finding.file)}]`,
    );
    if (current.step !== autoMintedStep) continue;
    if ((openByItem.get(current.id) ?? []).length !== 1) continue;
    // Do not strand resolved history when removing the singleton item. The
    // live repair shape has exactly this one open association.
    if ((allByItem.get(current.id) ?? []).length !== 1) continue;

    const currentAge = age.get(current.id);
    if (currentAge === undefined) continue;
    const target = allItems.find((item) => {
      if (item.id === current.id || removed.has(item.id) || item.status === "completed") return false;
      const candidateAge = age.get(item.id);
      return (
        candidateAge !== undefined &&
        candidateAge < currentAge &&
        findingMatchesItem(finding.id, finding.file, finding.fixFiles, item)
      );
    });
    if (!target) continue;

    if (!findings.moveItem(threadId, finding.id, current.id, target.id)) continue;
    if (!items.remove(threadId, current.id)) {
      // Preserve the prior consistent state if the unexpected item removal
      // fails; the next pass can retry deterministically.
      findings.moveItem(threadId, finding.id, target.id, current.id);
      continue;
    }
    removed.add(current.id);
    healed += 1;
  }
  return healed;
}

/** Completion guard: invalid open links are detached before the remaining
 * exact-file links can be bulk-fixed for a completed work item. */
export function closeFindingsForCompletedItem(input: {
  threadId: string;
  itemId: string;
  note: string;
  findings: FindingStore;
  items: ItemStore;
}): FindingCompletionResult {
  const detached = detachStaleFindingLinks({ ...input, itemId: input.itemId });
  const item = input.items.list(input.threadId).find((entry) => entry.id === input.itemId);
  const fixed = item?.status === "completed"
    ? input.findings.markFixedByItem(input.threadId, input.itemId, input.note)
    : 0;
  return { ...detached, fixed };
}

/**
 * Fill remediation work capacity from the oldest durable unlinked finding.
 * This function is deliberately synchronous: one server-side guard can make
 * report, pulse, and completion triggers converge without a link/mint race.
 */
export function reconcileFindingQueue(input: {
  threadId: string;
  findings: FindingStore;
  items: ItemStore;
  maxStaffed: number;
}): FindingQueueResult {
  const { threadId, findings, items } = input;
  const maxStaffed = Math.max(0, input.maxStaffed);
  const healedDuplicates = healAutoMintedFindingDuplicates({ threadId, findings, items });
  const allItems = items.list(threadId);
  const itemById = new Map(allItems.map((item) => [item.id, item]));
  const age = new Map(items.creationOrder(threadId).map((id, index) => [id, index]));
  allItems.sort((left, right) => (age.get(left.id) ?? 0) - (age.get(right.id) ?? 0));
  let autoFixed = 0;
  const detached = detachStaleFindingLinks({ threadId, findings, items });
  const requeuedMissing = detached.requeuedMissing;
  const requeuedInvalid = detached.requeuedInvalid;

  // Restart repair: after every stale link is detached, a linked completed
  // work item can safely close only its concretely owned findings.
  const completedItemIds = new Set(
    findings.remediationQueue(threadId).flatMap((finding) => {
      if (!finding.itemId) return [];
      return itemById.get(finding.itemId)?.status === "completed" ? [finding.itemId] : [];
    }),
  );
  for (const itemId of completedItemIds) {
    autoFixed += closeFindingsForCompletedItem({
      threadId,
      itemId,
      note: "Recovered completed remediation during finding-queue reconciliation.",
      findings,
      items,
    }).fixed;
  }

  let queue = findings.remediationQueue(threadId);
  const staffed = new Set(
    queue
      .flatMap((finding) => (finding.itemId ? [finding.itemId] : []))
      .filter((itemId) => itemById.get(itemId)?.status !== "completed"),
  );
  let linked = 0;
  let minted = 0;

  for (const finding of queue) {
    if (finding.itemId) continue;
    const disposition = findingAction({
      findingId: finding.id,
      file: finding.file,
      fixFiles: finding.fixFiles,
      staffedRemediationCount: staffed.size,
      maxStaffedRemediations: maxStaffed,
      openItems: allItems.filter((item) => item.status !== "completed"),
    });
    // A full capacity blocks new work items, not valid links to work already
    // counted in that capacity. Keep scanning so a later declared finding is
    // not stranded behind an older unrelated one.
    if (disposition.action === "record-only") continue;
    if (disposition.action === "attach") {
      const consumesCapacity = !staffed.has(disposition.attachItemId);
      if (consumesCapacity && staffed.size >= maxStaffed) continue;
      if (findings.linkItem(threadId, finding.id, disposition.attachItemId)) {
        staffed.add(disposition.attachItemId);
        linked += 1;
      }
      continue;
    }

    if (staffed.size >= maxStaffed) continue;
    const fixItem = items.add(
      threadId,
      `Fix: ${finding.title} [${normalizeFindingFile(finding.file)}]`,
      "pending",
      { deps: [], files: finding.fixFiles, check: finding.check },
    );
    if (!fixItem) break;
    if (!findings.linkItem(threadId, finding.id, fixItem.id)) {
      items.remove(threadId, fixItem.id);
      continue;
    }
    allItems.push(fixItem);
    itemById.set(fixItem.id, fixItem);
    staffed.add(fixItem.id);
    minted += 1;
  }

  queue = findings.remediationQueue(threadId);
  return {
    linked,
    minted,
    autoFixed,
    requeuedMissing,
    requeuedInvalid,
    healedDuplicates,
    remediationWorkItems: new Set(
      queue.flatMap((finding) => (finding.itemId ? [finding.itemId] : [])),
    ).size,
    awaitingAssignment: queue.filter((finding) => !finding.itemId).length,
  };
}
