import type { Payload } from "./codec.js";
import type { MetricKey, Metrics, Stats } from "./types.js";
import { archetypeOf } from "./metrics.js";
import { METRICS } from "./web-metrics.js";

const KEY = "promptstreak:machines";

export interface Snapshot extends Payload {
  id: string;
  machine: string;
  savedAt: number;
  on: boolean;
}

export function load(): Snapshot[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as Snapshot[]) : [];
    // Links made before per-day counts existed still open; they just merge coarsely.
    return list.map((s) => ({ ...s, aux: s.aux ?? { leashN: [], typed: [] } }));
  } catch {
    return [];
  }
}

export function save(list: Snapshot[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Private mode, or the quota is full. The view still works for this visit.
  }
}

/** One snapshot per machine; re-running the CLI replaces, never piles up. */
const sameMachine = (a: string, b: string) => a.replace(/\.local$/, "") === b.replace(/\.local$/, "");

export function upsert(payload: Payload): Snapshot[] {
  const machine = (payload.label || payload.stats.machines[0] || "this machine").replace(/\.local$/, "");
  const list = load().filter((s) => !sameMachine(s.machine, machine));
  list.push({ ...payload, id: `${machine}:${Date.now()}`, machine, savedAt: Date.now(), on: true });
  list.sort((a, b) => b.savedAt - a.savedAt);
  save(list);
  return list;
}

export const daysBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  while (d <= end) {
    out.push(d.toLocaleDateString("en-CA"));
    d.setDate(d.getDate() + 1);
  }
  return out;
};

export const expand = (p: Payload): Metrics => ({
  from: p.from,
  to: p.to,
  days: daysBetween(p.from, p.to),
  series: p.series,
  aux: p.aux,
  stats: p.stats,
});

/**
 * Combine snapshots into one view.
 *
 * Counts add up. The two median metrics (leash, prompt length) cannot be
 * re-derived from other medians, so on a day two machines overlap they are
 * averaged, weighted by that day's gap count or typed-prompt count. A day on
 * one machine only — the usual case — stays exact.
 */
export function combine(snaps: Snapshot[]): Metrics {
  if (snaps.length === 1) return expand(snaps[0]);

  const from = snaps.map((s) => s.from).sort()[0];
  const to = snaps.map((s) => s.to).sort().at(-1)!;
  const days = daysBetween(from, to);
  const at = new Map(days.map((d, i) => [d, i]));
  const zeros = () => new Array(days.length).fill(0);

  const series = Object.fromEntries(METRICS.map((m) => [m.key, zeros()])) as Record<MetricKey, number[]>;
  const aux = { leashN: zeros(), typed: zeros() };

  for (const snap of snaps) {
    daysBetween(snap.from, snap.to).forEach((day, si) => {
      const i = at.get(day);
      if (i === undefined) return;
      const leashN = snap.aux.leashN[si] ?? (snap.series.leash[si] ? 1 : 0);
      const typed = snap.aux.typed[si] ?? snap.series.prompts[si] ?? 0;
      for (const m of METRICS) {
        const v = snap.series[m.key]?.[si] ?? 0;
        if (m.key === "leash") series.leash[i] += v * leashN;
        else if (m.key === "promptWords") series.promptWords[i] += v * typed;
        else series[m.key][i] += v;
      }
      aux.leashN[i] += leashN;
      aux.typed[i] += typed;
    });
  }
  for (let i = 0; i < days.length; i++) {
    series.leash[i] = aux.leashN[i] ? Math.round((series.leash[i] / aux.leashN[i]) * 10) / 10 : 0;
    series.promptWords[i] = aux.typed[i] ? Math.round(series.promptWords[i] / aux.typed[i]) : 0;
  }

  const sum = (pick: (s: Stats) => number) => snaps.reduce((a, s) => a + pick(s.stats), 0);
  const gapTotal = aux.leashN.reduce((a, b) => a + b, 0) || 1;
  const medianLeashMin =
    Math.round((series.leash.reduce((a, v, i) => a + v * aux.leashN[i], 0) / gapTotal) * 10) / 10;
  const biggest = snaps.reduce((a, b) => (a.stats.totalPrompts >= b.stats.totalPrompts ? a : b)).stats;
  const longest = snaps.reduce((a, b) => (a.stats.longestUnattendedH >= b.stats.longestUnattendedH ? a : b)).stats;
  const typedTotal = sum((s) => s.typedPrompts) || 1;

  const stats: Stats = {
    ...biggest,
    totalPrompts: sum((s) => s.totalPrompts),
    typedPrompts: sum((s) => s.typedPrompts),
    slashCommands: sum((s) => s.slashCommands),
    activeDays: series.prompts.filter((n) => n > 0).length,
    spanDays: days.length,
    words: sum((s) => s.words),
    chars: sum((s) => s.chars),
    medianWords: Math.round(snaps.reduce((a, s) => a + s.stats.medianWords * s.stats.typedPrompts, 0) / typedTotal),
    godPrompts: sum((s) => s.godPrompts),
    godPromptDays: series.godPrompts.filter((n) => n > 0).length,
    nudges: sum((s) => s.nudges),
    nudgeRatio: sum((s) => s.nudges) / typedTotal,
    specShaped: sum((s) => s.specShaped),
    autonomyHours: Math.round(series.autonomy.reduce((a, b) => a + b, 0)),
    overnightHandoffs: sum((s) => s.overnightHandoffs),
    overnightHours: sum((s) => s.overnightHours),
    afterMidnight: sum((s) => s.afterMidnight),
    please: sum((s) => s.please),
    thanks: sum((s) => s.thanks),
    sorry: sum((s) => s.sorry),
    medianLeashMin,
    archetype: archetypeOf(medianLeashMin),
    longestUnattendedH: longest.longestUnattendedH,
    longestUnattendedAt: longest.longestUnattendedAt,
    maxLength: Math.max(...snaps.map((s) => s.stats.maxLength)),
    maxWords: Math.max(...snaps.map((s) => s.stats.maxWords)),
    machines: snaps.map((s) => s.machine),
    ...streaks(days, series.prompts),
  };

  return { from, to, days, series, aux, stats };
}

function streaks(days: string[], prompts: number[]) {
  let longestStreak = 0;
  let longestStreakEnd = "";
  let run = 0;
  prompts.forEach((n, i) => {
    if (n > 0) {
      run++;
      if (run > longestStreak) {
        longestStreak = run;
        longestStreakEnd = days[i];
      }
    } else run = 0;
  });
  let currentStreak = 0;
  for (let i = prompts.length - 1; i >= 0 && prompts[i] > 0; i--) currentStreak++;
  return { longestStreak, longestStreakEnd, currentStreak };
}
