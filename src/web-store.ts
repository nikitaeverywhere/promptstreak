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
    return raw ? (JSON.parse(raw) as Snapshot[]) : [];
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

/**
 * Store one snapshot per machine. Re-running the CLI on the same machine
 * replaces its entry rather than piling up near-identical years.
 */
export function upsert(payload: Payload): Snapshot[] {
  const machine = payload.label || payload.stats.machines[0] || "this machine";
  const list = load().filter((s) => s.machine !== machine);
  list.push({ ...payload, id: `${machine}:${Date.now()}`, machine, savedAt: Date.now(), on: true });
  list.sort((a, b) => b.savedAt - a.savedAt);
  save(list);
  return list;
}

const daysBetween = (from: string, to: string): string[] => {
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
  stats: p.stats,
});

/**
 * Combine snapshots into one view.
 *
 * Counts add up cleanly. Medians do not — you cannot recover a combined median
 * from two medians — so on the rare day two machines overlap they are averaged,
 * weighted by that day's prompts. Days on a single machine stay exact.
 */
export function combine(snaps: Snapshot[]): Metrics {
  if (snaps.length === 1) return expand(snaps[0]);

  const from = snaps.map((s) => s.from).sort()[0];
  const to = snaps.map((s) => s.to).sort().at(-1)!;
  const days = daysBetween(from, to);
  const at = new Map(days.map((d, i) => [d, i]));

  const series = Object.fromEntries(
    METRICS.map((m) => [m.key, new Array(days.length).fill(0)]),
  ) as Record<MetricKey, number[]>;
  const weight = new Array(days.length).fill(0);

  for (const snap of snaps) {
    const snapDays = daysBetween(snap.from, snap.to);
    snapDays.forEach((day, si) => {
      const i = at.get(day);
      if (i === undefined) return;
      const prompts = snap.series.prompts[si] ?? 0;
      for (const m of METRICS) {
        const v = snap.series[m.key]?.[si] ?? 0;
        if (m.median) series[m.key][i] += v * prompts; // weighted, divided below
        else series[m.key][i] += v;
      }
      weight[i] += prompts;
    });
  }
  for (const m of METRICS) {
    if (!m.median) continue;
    for (let i = 0; i < days.length; i++) {
      series[m.key][i] = weight[i] ? Math.round((series[m.key][i] / weight[i]) * 10) / 10 : 0;
    }
  }

  const sum = (pick: (s: Stats) => number) => snaps.reduce((a, s) => a + pick(s.stats), 0);
  const active = series.prompts.filter((n) => n > 0).length;
  const leash =
    weight.reduce((a, w, i) => a + series.leash[i] * w, 0) / (weight.reduce((a, b) => a + b, 0) || 1);
  const medianLeashMin = Math.round(leash * 10) / 10;
  const best = snaps.reduce((a, b) => (a.stats.totalPrompts >= b.stats.totalPrompts ? a : b)).stats;
  const longest = snaps.reduce((a, b) =>
    a.stats.longestUnattendedH >= b.stats.longestUnattendedH ? a : b,
  ).stats;

  const stats: Stats = {
    ...best,
    totalPrompts: sum((s) => s.totalPrompts),
    typedPrompts: sum((s) => s.typedPrompts),
    slashCommands: sum((s) => s.slashCommands),
    activeDays: active,
    spanDays: days.length,
    words: sum((s) => s.words),
    chars: sum((s) => s.chars),
    godPrompts: sum((s) => s.godPrompts),
    godPromptDays: series.godPrompts.filter((n) => n > 0).length,
    nudges: sum((s) => s.nudges),
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
    nudgeRatio: sum((s) => s.nudges) / (sum((s) => s.typedPrompts) || 1),
    machines: snaps.map((s) => s.machine),
    ...streaks(days, series.prompts),
  };

  return { from, to, days, series, stats };
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
