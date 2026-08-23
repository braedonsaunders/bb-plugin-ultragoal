import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { openSqlite } from "./cursor-tokens.js";

// Cumulative token usage straight from each provider's own session store,
// keyed by bb's providerThreadId. bb only relays what a provider chooses to
// emit (OpenCode ACP emits a context-window snapshot, not usage), so the
// stores on disk are the one source that exists for every provider:
//   - OpenCode:    ~/.local/share/opencode/opencode.db message rows carry
//                  tokens {input, output, reasoning, cache{read,write}} per
//                  assistant message; usage is their sum.
//   - Claude Code: ~/.claude/projects/<slug>/<sessionId>.jsonl lines carry
//                  message.usage per request; usage is the sum over lines.
//   - Codex:       ~/.codex/sessions/Y/M/D/rollout-*-<sessionId>.jsonl carries
//                  cumulative total_token_usage; the last one wins.
// Same convention as the Cursor readers: input + cache tokens billed per
// request, summed across requests.

function numberFrom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// OpenCode

function readOpenCodeTokens(sessionId: string): number | null {
  const db = openSqlite(join(homedir(), ".local/share/opencode/opencode.db"));
  if (!db) return null;
  try {
    const rows = db.all<{ total: number | null }>(
      `SELECT SUM(
         COALESCE(json_extract(data, '$.tokens.input'), 0) +
         COALESCE(json_extract(data, '$.tokens.output'), 0) +
         COALESCE(json_extract(data, '$.tokens.reasoning'), 0) +
         COALESCE(json_extract(data, '$.tokens.cache.read'), 0) +
         COALESCE(json_extract(data, '$.tokens.cache.write'), 0)
       ) AS total
       FROM message
       WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'`,
      sessionId,
    );
    const total = rows[0]?.total;
    return typeof total === "number" && total > 0 ? Math.round(total) : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Claude Code

const claudeFiles = new Map<string, string>();
const claudeTokens = new Map<string, { size: number; tokens: number }>();

function claudeSessionFile(sessionId: string): string | null {
  const cached = claudeFiles.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  const root = join(homedir(), ".claude/projects");
  if (!existsSync(root)) return null;
  try {
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, `${sessionId}.jsonl`);
      if (!existsSync(file)) continue;
      claudeFiles.set(sessionId, file);
      return file;
    }
  } catch {
    // Best-effort listing.
  }
  return null;
}

function readClaudeTokens(sessionId: string): number | null {
  const file = claudeSessionFile(sessionId);
  if (!file) return null;
  try {
    const size = statSync(file).size;
    const cached = claudeTokens.get(sessionId);
    if (cached && cached.size === size) return cached.tokens;
    let total = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"usage"')) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const message = rec.message as Record<string, unknown> | undefined;
      const usage = (message?.usage ?? rec.usage) as Record<string, unknown> | undefined;
      if (!usage || typeof usage !== "object") continue;
      total +=
        numberFrom(usage.input_tokens) +
        numberFrom(usage.cache_creation_input_tokens) +
        numberFrom(usage.cache_read_input_tokens) +
        numberFrom(usage.output_tokens);
    }
    if (total <= 0) return null;
    const tokens = Math.round(total);
    claudeTokens.set(sessionId, { size, tokens });
    return tokens;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Codex

const codexFiles = new Map<string, string | null>();
const codexNegativeAt = new Map<string, number>();
const codexTokens = new Map<string, { size: number; tokens: number }>();
const CODEX_RESCAN_MS = 60_000;

function codexSessionFile(sessionId: string): string | null {
  const cached = codexFiles.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  const missedAt = codexNegativeAt.get(sessionId);
  if (missedAt && Date.now() - missedAt < CODEX_RESCAN_MS) return null;
  const root = join(homedir(), ".codex/sessions");
  if (!existsSync(root)) return null;
  const suffix = `${sessionId}.jsonl`;
  try {
    // Newest-first walk of sessions/<year>/<month>/<day>; the target is
    // almost always today, so the scan stays shallow.
    for (const year of readdirSync(root).sort().reverse()) {
      const yearDir = join(root, year);
      for (const month of readdirSync(yearDir).sort().reverse()) {
        const monthDir = join(yearDir, month);
        for (const day of readdirSync(monthDir).sort().reverse()) {
          const dayDir = join(monthDir, day);
          for (const file of readdirSync(dayDir)) {
            if (!file.endsWith(suffix)) continue;
            const path = join(dayDir, file);
            codexFiles.set(sessionId, path);
            codexNegativeAt.delete(sessionId);
            return path;
          }
        }
      }
    }
  } catch {
    // Best-effort walk.
  }
  codexNegativeAt.set(sessionId, Date.now());
  return null;
}

function readCodexTokens(sessionId: string): number | null {
  const file = codexSessionFile(sessionId);
  if (!file) return null;
  try {
    const size = statSync(file).size;
    const cached = codexTokens.get(sessionId);
    if (cached && cached.size === size) return cached.tokens;
    let total = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const at = line.indexOf('"total_token_usage"');
      if (at < 0) continue;
      const open = line.indexOf("{", at);
      const close = line.indexOf("}", open);
      if (open < 0 || close < 0) continue;
      try {
        const usage = JSON.parse(line.slice(open, close + 1)) as Record<string, unknown>;
        const cumulative =
          numberFrom(usage.total_tokens) ||
          numberFrom(usage.input_tokens) + numberFrom(usage.output_tokens);
        if (cumulative > total) total = cumulative;
      } catch {
        continue;
      }
    }
    if (total <= 0) return null;
    const tokens = Math.round(total);
    codexTokens.set(sessionId, { size, tokens });
    return tokens;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

/** Cumulative session tokens from whichever provider store holds the session. */
export function readProviderSessionTokens(sessionId: string): number | null {
  const id = sessionId.trim();
  if (!id) return null;
  if (id.startsWith("ses_")) {
    return readOpenCodeTokens(id);
  }
  return readClaudeTokens(id) ?? readCodexTokens(id);
}
