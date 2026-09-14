/**
 * Agent runs, from session transcripts.
 *
 * A run starts at a prompt of yours and lasts as long as the agent keeps
 * producing records — replies, tool calls, subagent traffic — without another
 * prompt from you. It ends when the agent stops, or when you prompt again.
 * Only transcripts show the agent's side, so this is exact where they exist
 * and unknown where Claude Code has already pruned them.
 */

/** One transcript record: when, and whether a person typed it. */
export interface Row {
  ts: number;
  human: boolean;
}

/** Longer than this without a record and the session was idle, not working. */
export const IDLE_BREAK_MS = 2 * 3600_000;

/** [start, end] in ms, one per prompt that the agent worked on. */
export type Run = [number, number];

export function agentRuns(rows: Row[]): Run[] {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const runs: Run[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (!sorted[i].human) continue;
    let last = sorted[i].ts;
    for (let j = i + 1; j < sorted.length && !sorted[j].human; j++) {
      if (sorted[j].ts - last > IDLE_BREAK_MS) break;
      last = sorted[j].ts;
    }
    if (last > sorted[i].ts) runs.push([sorted[i].ts, last]);
  }
  return runs;
}

const dayOf = (ts: number) => new Date(ts).toLocaleDateString("en-CA");

/**
 * Wall-clock hours per local day with at least one agent running. Parallel
 * sessions overlap rather than add, so a day never exceeds 24 hours.
 */
export function hoursByDay(runs: Run[]): Map<string, number> {
  const merged: Run[] = [];
  for (const r of [...runs].sort((a, b) => a[0] - b[0])) {
    const prev = merged[merged.length - 1];
    if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out = new Map<string, number>();
  for (const [s, e] of merged) {
    let at = s;
    while (at < e) {
      const midnight = new Date(at);
      midnight.setHours(24, 0, 0, 0);
      const stop = Math.min(e, midnight.getTime());
      const day = dayOf(at);
      out.set(day, (out.get(day) ?? 0) + (stop - at) / 3600_000);
      at = stop;
    }
  }
  return out;
}

/** The single longest run, and the day it started. */
export function longestRun(runs: Run[]): { hours: number; day: string } {
  let best: Run | null = null;
  for (const r of runs) if (!best || r[1] - r[0] > best[1] - best[0]) best = r;
  return best ? { hours: Math.round(((best[1] - best[0]) / 3600_000) * 10) / 10, day: dayOf(best[0]) } : { hours: 0, day: "" };
}
