import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseHistoryText, parseTranscriptText, parseUnknownText } from "./parse-core.js";
import type { PromptEvent } from "./types.js";

export * from "./parse-core.js";

const read = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

export const parseHistory = (file: string): PromptEvent[] => parseHistoryText(read(file));
export const parseTranscript = (file: string): PromptEvent[] => parseTranscriptText(read(file));
export const parseUnknown = (file: string): PromptEvent[] => parseUnknownText(read(file));

/** Every `*.jsonl` under a directory, recursively. */
export function findJsonl(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Expand a user-supplied path into events, following directories. */
export function parsePath(path: string): PromptEvent[] {
  let st;
  try {
    st = statSync(path);
  } catch {
    return [];
  }
  if (st.isDirectory()) return findJsonl(path).flatMap(parseUnknown);
  return parseUnknown(path);
}
