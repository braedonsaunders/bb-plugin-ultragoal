import type { FindingStore } from "./findings.js";
import type { ItemStore } from "./items.js";
import { findingAction, normalizeFindingFile } from "./scheduler.js";

export interface FindingQueueResult {
  linked: number;
  minted: number;
  autoFixed: number;
  requeuedMissing: number;
  remediationWorkItems: number;
  awaitingAssignment: number;
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
  let allItems = items.list(threadId);
  let itemById = new Map(allItems.map((item) => [item.id, item]));
  let autoFixed = 0;
  let requeuedMissing = 0;

  // Restart repair: a linked completed slice is fixed even if its completion
  // event was missed; a deleted slice returns its finding to the durable queue.
  for (const finding of findings.remediationQueue(threadId)) {
    if (!finding.itemId) continue;
    const item = itemById.get(finding.itemId);
    if (item?.status === "completed") {
      autoFixed += findings.markFixedByItem(
        threadId,
        item.id,
        "Recovered completed remediation during finding-queue reconciliation.",
      );
    } else if (!item && findings.unlinkItem(threadId, finding.id)) {
      requeuedMissing += 1;
    }
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
    allItems = items.list(threadId);
    itemById = new Map(allItems.map((item) => [item.id, item]));
    const disposition = findingAction({
      file: finding.file,
      fixFiles: finding.fixFiles,
      staffedRemediationCount: staffed.size,
      maxStaffedRemediations: maxStaffed,
      openItems: allItems.filter((item) => item.status !== "completed"),
    });
    if (disposition.action === "record-only") break;
    if (disposition.action === "attach") {
      const consumesCapacity = !staffed.has(disposition.attachItemId);
      if (consumesCapacity && staffed.size >= maxStaffed) break;
      if (findings.linkItem(threadId, finding.id, disposition.attachItemId)) {
        staffed.add(disposition.attachItemId);
        linked += 1;
      }
      continue;
    }

    if (staffed.size >= maxStaffed) break;
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
    staffed.add(fixItem.id);
    minted += 1;
  }

  queue = findings.remediationQueue(threadId);
  return {
    linked,
    minted,
    autoFixed,
    requeuedMissing,
    remediationWorkItems: new Set(
      queue.flatMap((finding) => (finding.itemId ? [finding.itemId] : [])),
    ).size,
    awaitingAssignment: queue.filter((finding) => !finding.itemId).length,
  };
}
