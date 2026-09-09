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

/**
 * Anthropic list prices per million tokens. Cache writes are 1.25× input and
 * cache reads 0.1× input, except Fable 5.1 reads at a flat $0.25. This table
 * goes stale — the as-of month travels with the number so nobody mistakes it
 * for a bill.
 */
export const PRICE_AS_OF = "Jun 2026";
const PRICE: Record<string, { in: number; out: number; cw: number; cr: number }> = {
  "claude-fable-5-1": { in: 10, out: 50, cw: 12.5, cr: 0.25 },
  "claude-fable-5": { in: 10, out: 50, cw: 12.5, cr: 1 },
  "claude-opus-5": { in: 5, out: 25, cw: 6.25, cr: 0.5 },
  "claude-opus-4-8": { in: 5, out: 25, cw: 6.25, cr: 0.5 },
  "claude-opus-4-7": { in: 5, out: 25, cw: 6.25, cr: 0.5 },
  "claude-opus-4-6": { in: 5, out: 25, cw: 6.25, cr: 0.5 },
  "claude-sonnet-5": { in: 2, out: 10, cw: 2.5, cr: 0.2 },
  "claude-sonnet-4-6": { in: 3, out: 15, cw: 3.75, cr: 0.3 },
  "claude-haiku-4-5": { in: 1, out: 5, cw: 1.25, cr: 0.1 },
};
const priceFor = (model: string) => PRICE[model.replace(/-\d{8}$/, "")];

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
  let usd = 0;
  const unpriced = new Set<string>();

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
          const model = typeof o.message.model === "string" ? o.message.model : "";
          const price = model ? priceFor(model) : undefined;
          if (price) {
            usd +=
              ((u.input_tokens || 0) * price.in +
                (u.output_tokens || 0) * price.out +
                (u.cache_creation_input_tokens || 0) * price.cw +
                (u.cache_read_input_tokens || 0) * price.cr) /
              1e6;
          } else if (model && !model.startsWith("<")) unpriced.add(model);
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
  if (usd > 0) {
    tokens.usd = Math.round(usd);
    tokens.usdAsOf = PRICE_AS_OF;
    if (unpriced.size) tokens.unpriced = [...unpriced];
  }
  tokens.fromDay = Number.isFinite(minTs) ? new Date(minTs).toLocaleDateString("en-CA") : "";
  tokens.toDay = maxTs ? new Date(maxTs).toLocaleDateString("en-CA") : "";

  return { events, tokens, longestRunH: Math.round(longestRunH * 10) / 10, longestRunDay };
}
