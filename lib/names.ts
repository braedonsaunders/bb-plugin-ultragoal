const NAMES = [
  "Sir Syncs-a-Lot",
  "Madame OrgId",
  "The Decimal Avenger",
  "Calendar Cowboy",
  "Permission Gremlin",
  "Payroll Paladin",
  "Sandbox Saboteur",
  "Join Knight",
  "UTC Unicorn",
  "Ledger Lemur",
  "Auntie Rounding Error",
  "Captain Floaty",
  "Baron von Bootstrap",
  "The Tenant Whisperer",
  "Null Pointer Parish",
  "Deputy Deadlock",
  "Count Cashflow",
  "Sister Schema",
  "Professor Off-By-One",
  "The Feature Gatekeeper",
  "Lord Leftover",
  "Miss Match-and-Merge",
  "Ambassador As-Of",
  "The Idempotent Imp",
  "Warden of Writes",
  "Duke of Duplicates",
  "The Quiet Reconciler",
  "Major Minor-Version",
  "The Bound Query",
  "Lady Last-Write-Wins",
];

export function nextHumorousName(used: Iterable<string>): string {
  const taken = new Set([...used].map((name) => name.trim().toLowerCase()).filter(Boolean));
  const available = NAMES.filter((name) => !taken.has(name.toLowerCase()));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)] ?? NAMES[0]!;
  }
  return `Agent ${taken.size + 1} the Relentless`;
}

const AUDITORS = [
  "The Skeptical Auditor",
  "Proof Reader Prime",
  "Inspector Doubt",
  "Cross-Examine Carmen",
  "The Burden of Proof",
  "Captain Counterexample",
  "Null Hypothesis Nell",
  "The Red-Team Notary",
];

export function nextAuditorName(used: Iterable<string>): string {
  const taken = new Set([...used].map((name) => name.trim().toLowerCase()).filter(Boolean));
  const available = AUDITORS.filter((name) => !taken.has(name.toLowerCase()));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)] ?? AUDITORS[0]!;
  }
  return `Auditor ${taken.size + 1} the Unconvinced`;
}

export function slugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return slug || "worker";
}
