export function currentSliceTitle(step: string): string {
  const text = step.trim();
  const match = text.match(
    /^Leftover\s+.+?\s+(?:NEXT|STILL OPEN):\s+.+?\.\s+(\S[\s\S]*)$/i,
  );
  const current = match?.[1]?.trim();
  return current || text;
}

export function isPromptLikeTitle(title: string): boolean {
  const text = title.trim();
  return (
    text.length > 80 ||
    /^(you are|parent goal|assigned slice|complete only|the new agent's)/i.test(text)
  );
}

export function shortSliceTitle(step: string, max = 64): string {
  const text = currentSliceTitle(step)
    // Plans may annotate assignments ("… — worker thr_x"); that's link
    // metadata, not part of the slice's name.
    .replace(/\s*[—–-]*\s*\(?\s*worker\s+thr_[a-z0-9]+\s*\)?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const clause = text.split(/(?<=[.!?;])\s+| — | -- /)[0]?.trim() || text;
  const cleaned = clause.replace(/[.,;:]+$/, "");
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > 32 ? cut.slice(0, at) : cut).trim()}…`;
}
