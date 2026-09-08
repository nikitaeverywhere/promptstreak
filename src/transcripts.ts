import { readFileSync } from "node:fs";
import { parseTranscriptText } from "./parse-core.js";
import type { PromptEvent, TokenStats } from "./types.js";

/**
 * The agent went quiet for longer than this, so the session was idle rather
 * than working. Without it, sessions left open overnight read as 142-hour runs.
 */
const IDLE_BREAK_MS = 2 * 3600_000;
/** Transcripts are pruned unevenly, so tokens are reported for a fixed window. */
export const TOKEN_WINDOW_DAYS = 30;

export interface TranscriptScan {
  events: PromptEvent[];
  tokens: TokenStats;
  /** Longest stretch with proven agent activity and no prompt from you. */
  longestRunH: number;
  longestRunDay: string;
}

interface Row {
  ts: number;
  human: boolean;
}

const SYNTHETIC_PREFIX =
  /^(<command-name>|<local-command-stdout>|<command-message>|<task-notification>|<system-reminder>|<bash-input>|<bash-stdout>|<user-prompt-submit-hook>|\[Request interrupted|Caveat: The messages below|This session is being continued from a previous)/;

function humanText(o: any): string | null {
  if (o?.type !== "user" || o.isSidechain === true || o.isMeta === true) return null;
  if (o.origin?.kind && o.origin.kind !== "human") return null;
  if (o.promptSource === "system") return null;
  const c = o.message?.content;
  let text: string;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) text = c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
  else return null;
  text = text.trim();
  return !text || SYNTHETIC_PREFIX.test(text) ? null : text;
}

/**
 * One pass over every transcript. Transcripts are pruned by
 * `cleanupPeriodDays`, so everything here covers recent weeks only — the
 * caller must label it rather than presenting it as a yearly figure.
 */
export function scanTranscripts(files: string[], onProgress?: (done: number, total: number) => void): TranscriptScan {
  const windowStart = Date.now() - TOKEN_WINDOW_DAYS * 86_400_000;
  const events: PromptEvent[] = [];
  const tokens: TokenStats = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0,
    fromDay: "", toDay: "", toolCalls: 0, subagents: 0,
  };
  let longestRunH = 0;
  let longestRunDay = "";
  let minTs = Infinity;
  let maxTs = 0;
  const seenUsage = new Set<string>();
  const subagentIds = new Set<string>();

  files.forEach((file, fi) => {
    onProgress?.(fi + 1, files.length);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return;
    }
    events.push(...parseTranscriptText(raw));

    const rows: Row[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = Date.parse(o?.timestamp);
      if (!Number.isFinite(ts)) continue;

      if (o.type === "assistant" && o.message && ts >= windowStart) {
        if (ts < minTs) minTs = ts;
        if (ts > maxTs) maxTs = ts;
        // Records repeat across resumed sessions; count each message once.
        if (o.uuid && seenUsage.has(o.uuid)) continue;
        if (o.uuid) seenUsage.add(o.uuid);
        const u = o.message.usage;
        if (u) {
          tokens.input += u.input_tokens || 0;
          tokens.output += u.output_tokens || 0;
          tokens.cacheWrite += u.cache_creation_input_tokens || 0;
          tokens.cacheRead += u.cache_read_input_tokens || 0;
        }
        for (const b of o.message.content ?? []) {
          if (b?.type === "tool_use") {
            tokens.toolCalls++;
            if (b.name === "Agent" || b.name === "Task") tokens.subagents++;
          }
        }
        if (o.isSidechain === true && o.sessionId) subagentIds.add(o.sessionId);
      }

      rows.push({ ts, human: o.isSidechain !== true && humanText(o) !== null });
    }

    // A run is your prompt, then unbroken agent activity, until you prompt again.
    rows.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].human) continue;
      let last = rows[i].ts;
      for (let j = i + 1; j < rows.length && !rows[j].human; j++) {
        if (rows[j].ts - last > IDLE_BREAK_MS) break;
        last = rows[j].ts;
      }
      const h = (last - rows[i].ts) / 3600_000;
      if (h > longestRunH) {
        longestRunH = h;
        longestRunDay = new Date(rows[i].ts).toLocaleDateString("en-CA");
      }
    }
  });

  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  tokens.fromDay = Number.isFinite(minTs) ? new Date(minTs).toLocaleDateString("en-CA") : "";
  tokens.toDay = maxTs ? new Date(maxTs).toLocaleDateString("en-CA") : "";

  return { events, tokens, longestRunH: Math.round(longestRunH * 10) / 10, longestRunDay };
}
