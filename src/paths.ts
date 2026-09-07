import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Every Claude Code config directory that exists on this machine.
 *
 * Claude Code resolves its config dir from `CLAUDE_CONFIG_DIR`, falling back to
 * `~/.claude` (and `$XDG_CONFIG_HOME/claude` on some setups). We merge all of
 * them rather than picking the first, so a relocated dir never silently hides
 * history.
 */
export function configDirs(): string[] {
  const candidates = [
    process.env.CLAUDE_CONFIG_DIR,
    join(homedir(), ".claude"),
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "claude") : undefined,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, ".claude") : undefined,
  ].filter((p): p is string => Boolean(p));

  return [...new Set(candidates)].filter((p) => existsSync(p));
}

/** `history.jsonl` files across every config dir. This is the long-memory source. */
export function historyFiles(): string[] {
  return configDirs()
    .map((d) => join(d, "history.jsonl"))
    .filter((p) => existsSync(p));
}

/** `projects/` roots holding session transcripts. Pruned by `cleanupPeriodDays`. */
export function projectRoots(): string[] {
  return configDirs()
    .map((d) => join(d, "projects"))
    .filter((p) => existsSync(p));
}
