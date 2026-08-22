import type { GoalItemStatus } from "../contract.js";

const SECTION =
  /(?:still open[^\n:]{0,80}|remaining work|left to do)[:\s*]+([\s\S]+)/i;

function stripMarkup(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .trim();
}

function splitTopLevel(text: string, separators: string[]): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const match = separators.find((sep) => text.startsWith(sep, i));
      if (match) {
        const piece = current.trim();
        if (piece) parts.push(piece);
        current = "";
        i += match.length - 1;
        continue;
      }
    }
    current += char;
  }
  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
}

export function seedPlanFromOutput(
  output: string | null | undefined,
  reason?: string | null,
): Array<{ step: string; status: GoalItemStatus }> {
  const steps: string[] = [];
  const text = output?.trim() ?? "";
  const section = text.match(SECTION)?.[1] ?? "";
  const body = stripMarkup(section.split(/\n\n/)[0] ?? "");
  if (body) {
    const sentences = splitTopLevel(body, [". "]).flatMap((sentence) =>
      splitTopLevel(sentence.replace(/\.$/, ""), [", ", "; ", ", and ", " and "]),
    );
    for (const sentence of sentences) {
      const step = sentence.replace(/^and\s+/i, "").trim();
      if (step.length >= 12 && step.length <= 240) steps.push(step);
    }
  }
  if (reason) {
    const extra = reason.trim();
    if (extra && !steps.some((step) => step.toLowerCase().includes(extra.toLowerCase().slice(0, 32)))) {
      steps.unshift(extra);
    }
  }
  const remaining = steps.slice(0, 12).map((step, index) => ({
    step,
    status: (index === 0 ? "in_progress" : "pending") as GoalItemStatus,
  }));
  return [...remaining, ...extractCompleted(text)];
}

const DONE_HEADING = /\*\*([^*]+)\.\*\*\s+([^\n]+)/g;

export function extractCompleted(output: string | null | undefined): Array<{
  step: string;
  status: GoalItemStatus;
}> {
  const text = output?.trim() ?? "";
  if (!text) return [];
  const steps: string[] = [];
  for (const match of text.matchAll(DONE_HEADING)) {
    const title = stripMarkup(match[1] ?? "").replace(/\.$/, "").trim();
    const body = stripMarkup(match[2] ?? "").trim();
    if (!title || /still open|remaining/i.test(title)) continue;
    const step = body.length >= 12 ? `${title}: ${body}` : title;
    if (step.length >= 8 && step.length <= 240) steps.push(step);
  }
  return steps.slice(0, 24).map((step) => ({ step, status: "completed" as const }));
}
