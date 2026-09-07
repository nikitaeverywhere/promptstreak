import type { PromptEvent } from "./types.js";

/**
 * Pure parsing — no filesystem, so the browser and the CLI share one
 * implementation and can never disagree about what counts as a prompt.
 */

/** Synthetic "user" messages transcripts record that a human never typed. */
const SYNTHETIC = [
  "<command-name>",
  "<local-command-stdout>",
  "<command-message>",
  "<task-notification>",
  "<system-reminder>",
  "<bash-input>",
  "<bash-stdout>",
  "<user-prompt-submit-hook>",
  "[Request interrupted",
  "Caveat: The messages below",
  "This session is being continued from a previous",
];

const isSynthetic = (text: string) => SYNTHETIC.some((p) => text.startsWith(p));

function rows(raw: string): any[] {
  const out: any[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A partially-flushed final line is normal on a live file.
    }
  }
  return out;
}

/** `history.jsonl` — the source that reaches back a full year. */
export function parseHistoryText(raw: string): PromptEvent[] {
  const out: PromptEvent[] = [];
  for (const o of rows(raw)) {
    if (typeof o?.display !== "string" || typeof o?.timestamp !== "number") continue;
    out.push({
      ts: o.timestamp,
      text: o.display,
      project: typeof o.project === "string" ? o.project : "",
      isSlash: o.display.trimStart().startsWith("/"),
      pasted: Object.keys(o.pastedContents ?? {}).length > 0,
    });
  }
  return out;
}

/**
 * A session transcript. Pruned after `cleanupPeriodDays`, so it only covers
 * recent weeks — but it catches headless sessions that skip `history.jsonl`.
 */
export function parseTranscriptText(raw: string): PromptEvent[] {
  const out: PromptEvent[] = [];
  const seenUuid = new Set<string>();
  for (const o of rows(raw)) {
    if (o?.type !== "user" || o.isSidechain === true || o.isMeta === true) continue;
    if (o.origin?.kind && o.origin.kind !== "human") continue;
    if (o.promptSource === "system") continue;
    if (o.uuid) {
      if (seenUuid.has(o.uuid)) continue;
      seenUuid.add(o.uuid);
    }

    const content = o.message?.content;
    let text: string;
    if (typeof content === "string") text = content;
    else if (Array.isArray(content))
      text = content
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text)
        .join("\n");
    else continue;

    text = text.trim();
    if (!text || isSynthetic(text)) continue;

    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) continue;

    out.push({
      ts,
      text,
      project: typeof o.cwd === "string" ? o.cwd : "",
      isSlash: text.startsWith("/"),
      pasted: false,
    });
  }
  return out;
}

/** Route by sniffing the first parsable line, so callers need not know the kind. */
export function parseUnknownText(raw: string): PromptEvent[] {
  for (const o of rows(raw)) {
    if (typeof o?.display === "string") return parseHistoryText(raw);
    if (typeof o?.type === "string") return parseTranscriptText(raw);
  }
  return [];
}

/**
 * Merge event lists, dropping duplicates and sorting chronologically.
 * `history.jsonl` legitimately repeats lines — `/mcp` writes three per call —
 * and resumed sessions replay records, so dedupe is not optional.
 */
export function merge(...lists: PromptEvent[][]): PromptEvent[] {
  const seen = new Set<string>();
  const out: PromptEvent[] = [];
  for (const list of lists) {
    for (const e of list) {
      const k = `${e.ts}|${e.text}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}
