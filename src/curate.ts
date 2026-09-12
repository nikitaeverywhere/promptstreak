import { spawnSync } from "node:child_process";
import { asCandidate, pickQuotes } from "./mood.js";
import type { PromptEvent, Quote } from "./types.js";
import { dayOf } from "./metrics.js";

/**
 * Optional: let Claude Code choose the funniest lines from a wider candidate
 * pool. Uses the `claude` CLI the user already has, so there is nothing to
 * configure — and these prompts were sent to Anthropic once already when they
 * were typed, so nothing new leaves the machine.
 */
export async function curateQuotes(events: PromptEvent[], fallback: Quote[]): Promise<Quote[] | null> {
  const cands = events
    .filter((e) => !e.isSlash)
    .map((e) => asCandidate(e.text, e.ts, dayOf(e.ts)))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .sort((a, b) => b.score - a.score)
    .slice(0, 60);
  if (cands.length < 5) return null;

  const list = cands.map((c, i) => `${i}\t${c.text}`).join("\n");
  const prompt = `Below are short things a developer typed to an AI coding agent over a year, one per line, prefixed with an index.
Pick the 8 funniest, most human, most quotable ones — swearing, exasperation, sarcasm, apologising to a machine, banter.
Avoid anything that looks like it contains a secret, a real person's name, or a company name. Prefer short lines.
Reply with ONLY a JSON array of the chosen indices, most quotable first, e.g. [12,3,40].

${list}`;

  const run = spawnSync("claude", ["-p", "--output-format", "text"], { input: prompt, encoding: "utf8", timeout: 120_000 });
  if (run.status !== 0 || !run.stdout) return null;
  const match = run.stdout.match(/\[[\d,\s]+\]/);
  if (!match) return null;
  let idx: number[];
  try {
    idx = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const chosen = idx.map((i) => cands[i]).filter(Boolean);
  if (chosen.length < 3) return null;
  // Keep the ranked picker's dedupe and category tagging.
  const picked = pickQuotes(chosen, 10);
  return picked.length ? picked : fallback;
}
