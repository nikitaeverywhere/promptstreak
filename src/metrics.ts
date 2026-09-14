import type { Archetype, MetricKey, Metrics, PromptEvent, Quote, Stats, TokenStats } from "./types.js";
import { asCandidate, moodScores, pickQuotes, type QuoteCandidate } from "./mood.js";
import { hoursByDay, longestRun, type Run } from "./agent.js";

/** A prompt this long is a spec, not a message. Fixed so any two people compare. */
export const GOD_PROMPT_CHARS = 5000;
/** "yes", "please continue", "yup" — steering, not instructing. */
export const NUDGE_CHARS = 25;
/** Beyond this, you left — it is not one working session any more. */
export const SESSION_BREAK_H = 6;
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

const SPEC_SHAPED = /(^|\n)\s*([-*]|\d+[.)])\s+/;
const PLEASE = /\bplease\b/i;
const THANKS = /\bthanks?\b|\bthank you\b/i;
const SORRY = /\bsorry\b/i;
const THANKS_WORD = /\bthanks?\b|\bthank you\b/i;

/** Local calendar day, `YYYY-MM-DD`. Never UTC — a night owl's day must not split. */
export const dayOf = (ts: number): string => new Date(ts).toLocaleDateString("en-CA");

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

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

/** Gaps between consecutive prompts inside one working session, in minutes. */
interface Gap {
  day: string;
  minutes: number;
}

function sessionGaps(events: PromptEvent[]): Gap[] {
  const out: Gap[] = [];
  const limit = SESSION_BREAK_H * 3600_000;
  // Slash commands are not prompts. Counting them makes every `/model` look
  // like frantic steering and drags the median toward zero.
  const typed = events.filter((e) => !e.isSlash);
  for (let i = 1; i < typed.length; i++) {
    const prev = typed[i - 1];
    const cur = typed[i];
    if (cur.project !== prev.project) continue;
    const ms = cur.ts - prev.ts;
    if (ms <= 0 || ms >= limit) continue;
    out.push({ day: dayOf(cur.ts), minutes: ms / 60_000 });
  }
  return out;
}

/**
 * You prompt every few minutes, or you hand over work and walk away. The median
 * gap says which, and it is the one number that makes two people comparable.
 */
export function archetypeOf(medianLeashMin: number): Archetype {
  if (medianLeashMin < 3) return "Babysitter";
  if (medianLeashMin < 15) return "Collaborator";
  return "Orchestrator";
}

export interface ComputeOptions {
  machines?: string[];
  tokens?: TokenStats;
  /**
   * Agent runs from transcripts. Prompt gaps alone cannot tell the agent
   * working from you at lunch, so without this autonomy stays blank.
   */
  agent?: { runs: Run[]; coverage: { from: string; to: string } };
  /** Skip quote selection entirely (nothing quotable travels). */
  noQuotes?: boolean;
}

export function computeMetrics(events: PromptEvent[], opts: ComputeOptions = {}): Metrics {
  if (!events.length) throw new Error("No prompts found.");

  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const typed = sorted.filter((e) => !e.isSlash);
  const from = dayOf(sorted[0].ts);
  const to = dayOf(sorted[sorted.length - 1].ts);
  const days = daysBetween(from, to);
  const index = new Map(days.map((d, i) => [d, i]));

  const zeros = () => new Array(days.length).fill(0);
  const series: Record<MetricKey, number[]> = {
    prompts: zeros(),
    godPrompts: zeros(),
    leash: zeros(),
    promptWords: zeros(),
    nudges: zeros(),
    specShaped: zeros(),
    autonomy: zeros(),
    overnight: zeros(),
    nightOwl: zeros(),
    politeness: zeros(),
    swearing: zeros(),
    annoyed: zeros(),
    caps: zeros(),
    thanks: zeros(),
    emoji: zeros(),
  };

  const aux = { leashN: zeros(), typed: zeros() };
  const byHour = new Array(24).fill(0);
  const byProject = new Map<string, number>();
  const lengthsByDay = new Map<string, number[]>();
  const wordsByDay = new Map<string, number[]>();
  const timesByDay = new Map<string, number[]>();
  const nudgeCounts = new Map<string, number>();
  let totalWords = 0;
  let chars = 0;
  let please = 0;
  let thanks = 0;
  let sorry = 0;
  const mood = { swearing: 0, annoyed: 0, capsRage: 0, banter: 0, ultrathink: 0, goAhead: 0, emoji: 0 };
  const cands: QuoteCandidate[] = [];
  let maxLength = 0;
  let maxLengthDay = from;

  for (const e of sorted) {
    const day = dayOf(e.ts);
    const i = index.get(day);
    if (i === undefined) continue;
    const at = new Date(e.ts);

    series.prompts[i]++;
    byHour[at.getHours()]++;
    byProject.set(e.project, (byProject.get(e.project) ?? 0) + 1);
    (timesByDay.get(day) ?? timesByDay.set(day, []).get(day)!).push(e.ts);
    if (at.getHours() >= 22 || at.getHours() < 5) series.nightOwl[i]++;

    if (e.isSlash) continue;
    aux.typed[i]++;

    const text = e.text;
    const trimmed = text.trim();
    const w = words(text);
    chars += text.length;
    totalWords += w;
    (lengthsByDay.get(day) ?? lengthsByDay.set(day, []).get(day)!).push(text.length);
    (wordsByDay.get(day) ?? wordsByDay.set(day, []).get(day)!).push(w);

    if (text.length >= GOD_PROMPT_CHARS) series.godPrompts[i]++;
    if (trimmed.length <= NUDGE_CHARS) {
      series.nudges[i]++;
      const k = trimmed.toLowerCase();
      nudgeCounts.set(k, (nudgeCounts.get(k) ?? 0) + 1);
    }
    if (SPEC_SHAPED.test(text)) series.specShaped[i]++;
    if (PLEASE.test(text)) {
      series.politeness[i]++;
      please++;
    }
    if (THANKS_WORD.test(text)) thanks++;
    if (SORRY.test(text)) sorry++;

    const ms = moodScores(text);
    if (ms.swearing > 0) { series.swearing[i]++; mood.swearing++; }
    if (ms.annoyed > 0) { series.annoyed[i]++; mood.annoyed++; }
    if (ms.caps > 0) { series.caps[i]++; mood.capsRage++; }
    if (ms.thanks > 0) series.thanks[i]++;
    if (ms.emoji > 0) { series.emoji[i]++; mood.emoji++; }
    if (ms.banter > 0) mood.banter++;
    if (ms.ultrathink > 0) mood.ultrathink++;
    if (ms.goAhead > 0) mood.goAhead++;
    if (!opts.noQuotes) {
      const c = asCandidate(text, e.ts, day);
      if (c) cands.push(c);
    }
    if (text.length > maxLength) {
      maxLength = text.length;
      maxLengthDay = day;
    }
  }

  for (const [day, w] of wordsByDay) {
    const i = index.get(day);
    if (i !== undefined) series.promptWords[i] = Math.round(median(w));
  }

  // Leash comes from the gaps between your own prompts.
  const gaps = sessionGaps(sorted);
  const gapsByDay = new Map<string, number[]>();
  for (const g of gaps) (gapsByDay.get(g.day) ?? gapsByDay.set(g.day, []).get(g.day)!).push(g.minutes);
  for (const [day, mins] of gapsByDay) {
    const i = index.get(day);
    if (i === undefined) continue;
    series.leash[i] = Math.round(median(mins) * 10) / 10;
    aux.leashN[i] = mins.length;
  }

  // Autonomy is the agent's side of the story: hours it kept working after a
  // prompt, from transcripts. Where none survive, the day is unknown, not zero.
  if (opts.agent) {
    for (const [day, h] of hoursByDay(opts.agent.runs)) {
      const i = index.get(day);
      if (i !== undefined) series.autonomy[i] = Math.round(h * 10) / 10;
    }
  }
  const run = longestRun(opts.agent?.runs ?? []);

  // Overnight delivery: you handed work over late and came back the next day.
  let overnightHandoffs = 0;
  let overnightHours = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.project !== prev.project) continue;
    const h = new Date(prev.ts).getHours();
    const elapsed = (cur.ts - prev.ts) / 3600_000;
    if ((h >= 22 || h < 3) && elapsed >= 6 && elapsed <= 20) {
      overnightHandoffs++;
      overnightHours += elapsed;
      const idx = index.get(dayOf(prev.ts));
      if (idx !== undefined) series.overnight[idx]++;
    }
  }

  const leashByMonth: Record<string, number> = {};
  const monthGaps = new Map<string, number[]>();
  for (const g of gaps) {
    const m = g.day.slice(0, 7);
    (monthGaps.get(m) ?? monthGaps.set(m, []).get(m)!).push(g.minutes);
  }
  for (const [m, mins] of [...monthGaps].sort()) leashByMonth[m] = Math.round(median(mins) * 10) / 10;

  const medianLeashMin = Math.round(median(gaps.map((g) => g.minutes)) * 10) / 10;
  const activeDaySet = new Set(sorted.map((e) => dayOf(e.ts)));
  const { longest, longestEnd, current } = streaks(days, activeDaySet, to);
  const daySpans = [...timesByDay.values()]
    .filter((ts) => ts.length > 2)
    .map((ts) => (Math.max(...ts) - Math.min(...ts)) / 3600_000);

  const stats: Stats = {
    totalPrompts: sorted.length,
    typedPrompts: typed.length,
    slashCommands: sorted.length - typed.length,
    activeDays: activeDaySet.size,
    spanDays: days.length,
    words: totalWords,
    chars,
    medianLength: Math.round(median(typed.map((e) => e.text.length))),
    medianWords: Math.round(median(typed.map((e) => words(e.text)))),
    maxLength,
    maxWords: Math.max(0, ...typed.map((e) => words(e.text))),
    maxLengthDay,
    godPrompts: series.godPrompts.reduce((a, b) => a + b, 0),
    godPromptDays: series.godPrompts.filter((n) => n > 0).length,
    nudges: series.nudges.reduce((a, b) => a + b, 0),
    nudgeRatio: typed.length ? series.nudges.reduce((a, b) => a + b, 0) / typed.length : 0,
    specShaped: series.specShaped.reduce((a, b) => a + b, 0),
    medianLeashMin,
    archetype: archetypeOf(medianLeashMin),
    leashByMonth,
    autonomyHours: Math.round(series.autonomy.reduce((a, b) => a + b, 0)),
    longestUnattendedH: run.hours,
    longestUnattendedAt: run.day,
    overnightHandoffs,
    overnightHours: Math.round(overnightHours),
    longestStreak: longest,
    longestStreakEnd: longestEnd,
    currentStreak: current,
    afterMidnight: byHour.slice(0, 5).reduce((a: number, b: number) => a + b, 0),
    medianDaySpanHours: Math.round(median(daySpans) * 10) / 10,
    byHour,
    byProject: [...byProject].sort((a, b) => b[1] - a[1]).slice(0, 12),
    please,
    thanks,
    sorry,
    swearing: mood.swearing,
    annoyed: mood.annoyed,
    capsRage: mood.capsRage,
    emoji: mood.emoji,
    banter: mood.banter,
    ultrathink: mood.ultrathink,
    goAhead: mood.goAhead,
    topNudges: [...nudgeCounts].sort((a, b) => b[1] - a[1]).slice(0, 10),
    machines: opts.machines ?? [],
    ...(opts.tokens ? { tokens: opts.tokens } : {}),
  };

  const quotes: Quote[] | undefined = opts.noQuotes ? undefined : pickQuotes(cands);
  return { from, to, days, series, aux, stats, ...(quotes ? { quotes } : {}), ...(opts.agent ? { coverage: opts.agent.coverage } : {}) };
}

function streaks(days: string[], active: Set<string>, to: string) {
  let longest = 0;
  let longestEnd = "";
  let run = 0;
  for (const d of days) {
    if (active.has(d)) {
      run++;
      if (run > longest) {
        longest = run;
        longestEnd = d;
      }
    } else run = 0;
  }
  let current = 0;
  for (let i = days.length - 1; i >= 0 && active.has(days[i]); i--) current++;
  const today = dayOf(Date.now());
  const yesterday = dayOf(Date.now() - 86_400_000);
  return { longest, longestEnd, current: to === today || to === yesterday ? current : 0 };
}
