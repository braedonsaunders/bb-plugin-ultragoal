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

// Words that carry no flavor of the slice's actual work.
const KEYWORD_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "for", "to", "with", "into",
  "from", "via", "per", "all", "every", "only", "not", "none", "new", "its",
  "it", "this", "that", "then", "than", "until", "after", "before", "when",
  "while", "each", "one", "two", "three", "make", "add", "run", "keep", "get",
  "set", "fix", "item", "slice", "wave", "worker", "fresh", "prior", "done",
  "main", "repo", "code", "file", "files", "them", "what", "whatever", "prove",
  "proves", "proven", "still", "then", "your", "over", "under",
]);

const WORK_TEMPLATES = [
  (k: string) => `Captain ${k}`,
  (k: string) => `The ${k} Whisperer`,
  (k: string) => `${k} Wrangler`,
  (k: string) => `Sir ${k}-a-Lot`,
  (k: string) => `Duke of ${k}`,
  (k: string) => `The ${k} Reckoning`,
  (k: string) => `Doctor ${k}`,
  (k: string) => `Baron von ${k}`,
  (k: string) => `Lady ${k}`,
  (k: string) => `${k} Buster`,
  (k: string) => `The ${k} Gambit`,
  (k: string) => `Agent ${k}`,
];

function keywordsOf(work: string): string[] {
  const tokens = work
    .replace(/\bitm_[a-z0-9_]+\b/gi, " ")
    .replace(/\bthr_[a-z0-9]+\b/gi, " ")
    .split(/[^a-zA-Z]+/)
    .filter((token) => token.length >= 4 && !KEYWORD_STOPWORDS.has(token.toLowerCase()));
  // Longest first, earliest wins ties: the most specific word in the slice.
  return [...new Set(tokens.map((token) => token[0]!.toUpperCase() + token.slice(1)))].sort(
    (a, b) => b.length - a.length,
  );
}

/**
 * A humorous display name derived from the slice's own text ("Green mandated
 * suites" -> "Captain Suites"), so plugin-spawned workers read like crew on
 * that job instead of random pool picks. Falls back to the generic pool when
 * the text yields nothing usable.
 */
export function workRelatedName(work: string, used: Iterable<string>): string {
  const taken = new Set([...used].map((name) => name.trim().toLowerCase()).filter(Boolean));
  for (const keyword of keywordsOf(work).slice(0, 4)) {
    const shuffled = [...WORK_TEMPLATES].sort(() => Math.random() - 0.5);
    for (const template of shuffled) {
      const name = template(keyword);
      if (name.length > 40) continue;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }
  return nextHumorousName(used);
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

const AUDITOR_TEMPLATES = [
  (k: string) => `The ${k} Skeptic`,
  (k: string) => `Inspector ${k}`,
  (k: string) => `${k} Auditor`,
  (k: string) => `The ${k} Cross-Examiner`,
  (k: string) => `Doubting ${k}`,
  (k: string) => `${k} Notary`,
];

/** Skeptic name derived from the work under audit; pool as fallback. */
export function auditorNameFor(work: string, used: Iterable<string>): string {
  const taken = new Set([...used].map((name) => name.trim().toLowerCase()).filter(Boolean));
  for (const keyword of keywordsOf(work).slice(0, 4)) {
    for (const template of [...AUDITOR_TEMPLATES].sort(() => Math.random() - 0.5)) {
      const name = template(keyword);
      if (name.length <= 40 && !taken.has(name.toLowerCase())) return name;
    }
  }
  return nextAuditorName(used);
}

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
