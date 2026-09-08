import type { MetricKey, Metrics } from "./types.js";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  gold: "\x1b[38;5;220m",
  gold2: "\x1b[38;5;178m",
  g: (n: 1 | 2 | 3 | 4) => ["\x1b[38;5;22m", "\x1b[38;5;28m", "\x1b[38;5;34m", "\x1b[38;5;40m"][n - 1],
  empty: "\x1b[38;5;236m",
};

export const METRIC_LABELS: Record<MetricKey, string> = {
  prompts: "Prompts",
  godPrompts: "God prompts (>=5000 chars)",
  leash: "Leash length (min between prompts)",
  promptWords: "Median prompt length (words)",
  nudges: "Nudges (<=25 chars)",
  specShaped: "Spec-shaped prompts",
  autonomy: "Autonomy (hours agent worked alone)",
  overnight: "Overnight deliveries",
  nightOwl: "Night prompts (22:00-05:00)",
  politeness: '"Please" prompts',
};

/** Sunday-first weeks, exactly like GitHub, so the shape reads instantly. */
function weeks(days: string[]): (string | null)[][] {
  const first = new Date(`${days[0]}T12:00:00`);
  const pad = first.getDay();
  const cells: (string | null)[] = [...new Array(pad).fill(null), ...days];
  const out: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
  const last = out[out.length - 1];
  while (last.length < 7) last.push(null);
  return out;
}

function scale(values: number[]): (v: number) => 0 | 1 | 2 | 3 | 4 {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(nz.length * p))];
  const [a, b, c] = [q(0.25), q(0.5), q(0.75)];
  return (v) => (v <= 0 ? 0 : v <= a ? 1 : v <= b ? 2 : v <= c ? 3 : 4);
}

export function renderGrid(m: Metrics, metric: MetricKey, color = true): string {
  const values = m.series[metric];
  const at = new Map(m.days.map((d, i) => [d, values[i]]));
  const bucket = scale(values);
  const gold = metric === "godPrompts";
  const cols = weeks(m.days);

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let header = "    ";
  let lastMonth = -1;
  for (const w of cols) {
    const firstReal = w.find((d): d is string => d !== null);
    const d = firstReal ? new Date(`${firstReal}T12:00:00`) : null;
    if (d && d.getMonth() !== lastMonth && d.getDate() <= 7) {
      header += months[d.getMonth()][0];
      lastMonth = d.getMonth();
    } else header += " ";
  }

  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const rows: string[] = [];
  for (let r = 0; r < 7; r++) {
    let line = `${C.dim}${names[r]}${C.reset} `;
    for (const w of cols) {
      const day = w[r];
      if (!day) {
        line += " ";
        continue;
      }
      const v = at.get(day) ?? 0;
      const b = bucket(v);
      if (!color) {
        line += b === 0 ? "·" : ["░", "▒", "▓", "█"][b - 1];
        continue;
      }
      if (v <= 0) line += `${C.empty}■${C.reset}`;
      else if (gold) line += `${v > 2 ? C.gold : C.gold2}■${C.reset}`;
      else line += `${C.g(b as 1 | 2 | 3 | 4)}■${C.reset}`;
    }
    rows.push(line);
  }
  return `${C.dim}${header}${C.reset}\n${rows.join("\n")}`;
}

const n = (v: number) => v.toLocaleString("en-US");

export function renderStats(m: Metrics): string {
  const s = m.stats;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const trend = Object.entries(s.leashByMonth);
  const arrow =
    trend.length > 1 && trend[trend.length - 1][1] > trend[0][1]
      ? "rising — you are delegating more"
      : trend.length > 1
        ? "falling — you are steering more closely"
        : "";

  return [
    `${C.bold}${n(s.totalPrompts)} prompts${C.reset} ${C.dim}·${C.reset} ${s.activeDays} active days of ${s.spanDays} ${C.dim}(${m.from} → ${m.to})${C.reset}`,
    ``,
    `  ${C.bold}${s.archetype}${C.reset} ${C.dim}— median ${s.medianLeashMin} min between prompts${C.reset}${arrow ? `, ${arrow}` : ""}`,
    `  ${C.gold}■${C.reset} ${n(s.godPrompts)} god prompts across ${s.godPromptDays} days ${C.dim}· longest ${n(s.maxLength)} chars on ${s.maxLengthDay}${C.reset}`,
    `  ${n(s.words)} words written ${C.dim}· median prompt ${s.medianLength} chars · ${pct(s.nudgeRatio)} are nudges${C.reset}`,
    `  ${n(s.autonomyHours)} h of unattended agent time ${C.dim}· ${s.overnightHandoffs} overnight deliveries${C.reset}`,
    `  Longest streak ${C.bold}${s.longestStreak} days${C.reset}${s.longestStreakEnd ? ` ${C.dim}(ended ${s.longestStreakEnd})${C.reset}` : ""}${s.currentStreak ? ` · current ${s.currentStreak}` : ""}`,
    `  ${n(s.afterMidnight)} prompts after midnight ${C.dim}· median ${s.medianDaySpanHours} h/day between first and last prompt${C.reset}`,
    `  ${s.please} "please", ${s.thanks} "thanks", ${s.sorry} "sorry"`,
  ].join("\n");
}

export function renderLegend(metric: MetricKey): string {
  return `${C.dim}${METRIC_LABELS[metric]}${C.reset}`;
}
