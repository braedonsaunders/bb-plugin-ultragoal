export type SlashGoal =
  | { kind: "set" | "edit"; objective: string }
  | { kind: "pause" | "resume" | "clear" | "status" };

const LIFECYCLE = /^(pause|resume|continue|clear|status|edit)\b/i;

export function parseSlashGoal(text: string | null | undefined): SlashGoal | null {
  if (!text) return null;
  const trimmed = text.trim();
  const match = trimmed.match(/^\/(?:ultra)?goal(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (!rest) return { kind: "status" };
  const verb = rest.match(LIFECYCLE)?.[1]?.toLowerCase();
  if (verb === "pause") return { kind: "pause" };
  if (verb === "clear") return { kind: "clear" };
  if (verb === "status") return { kind: "status" };
  if (verb === "resume" || verb === "continue") return { kind: "resume" };
  if (verb === "edit") {
    const objective = rest.replace(/^edit\s+/i, "").trim();
    return objective ? { kind: "edit", objective } : { kind: "status" };
  }
  return { kind: "set", objective: rest };
}

export function lastUserText(rows: readonly unknown[]): string | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i] as {
      kind?: string;
      role?: string;
      initiator?: string;
      text?: string;
    };
    if (row?.kind !== "conversation" || row.role !== "user") continue;
    if (row.initiator && row.initiator !== "user") continue;
    const text = row.text?.trim();
    if (text) return text;
  }
  return null;
}
