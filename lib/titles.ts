export function currentSliceTitle(step: string): string {
  const text = step.trim();
  const match = text.match(
    /^Leftover\s+.+?\s+(?:NEXT|STILL OPEN):\s+.+?\.\s+(\S[\s\S]*)$/i,
  );
  const current = match?.[1]?.trim();
  return current || text;
}
