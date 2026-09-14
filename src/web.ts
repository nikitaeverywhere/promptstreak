import { decode, encode } from "./codec.js";
import { merge, parseUnknownText } from "./parse-core.js";
import { computeMetrics } from "./metrics.js";
import { METRICS, byKey, type MetricDef } from "./web-metrics.js";
import { combine, daysBetween, expand, holds, load, save, upsert, type Snapshot } from "./web-store.js";
import type { MetricKey, Metrics, Quote, Stats } from "./types.js";
import { applyEdits, hasEdits, hideRange, parts, removeQuote, resetEdits, undo, type Shown } from "./web-quotes.js";
import { censor } from "./mood.js";
import { startSnake, stopSnake } from "./web-snake.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const n = (v: number) => Math.round(v).toLocaleString("en-US");
/** Headline numbers: 8,269 stays exact, 511,664 becomes 512K. Full precision lives in "More numbers". */
const short = (v: number) => {
  const a = Math.abs(v);
  if (a < 10_000) return n(v);
  const f = (x: number, u: string) => `${x < 100 ? x.toFixed(1).replace(/\.0$/, "") : Math.round(x)}${u}`;
  return a < 1e6 ? f(v / 1e3, "K") : a < 1e9 ? f(v / 1e6, "M") : f(v / 1e9, "B");
};
const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const CHEV = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const GAP = 3;

let metrics: Metrics | null = null;
let main: MetricKey = "prompts";
let overlay: MetricKey | null = null;
let snaps: Snapshot[] = [];
/** A merged link opened in a browser that holds none of its machines: show it, never store it. */
let shared: Metrics | null = null;

/* ---------- helpers ---------- */

function levels(values: number[]): (v: number) => 0 | 1 | 2 | 3 | 4 {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(nz.length * p))];
  const [a, b, c] = [q(0.25), q(0.5), q(0.75)];
  return (v) => (v <= 0 ? 0 : v <= a ? 1 : v <= b ? 2 : v <= c ? 3 : 4);
}

/**
 * Overlay strength as a share of the accent colour laid over the base cell:
 * the busiest day is the pure accent, everything else fades toward the base.
 * Square-root so a single event on a heavy-tailed metric still shows.
 */
function overlayAlpha(values: number[] | null): (v: number) => number {
  const max = values ? Math.max(0, ...values) : 0;
  if (!max) return () => 0;
  return (v) => (v <= 0 ? 0 : Math.min(1, 0.3 + 0.7 * Math.sqrt(v / max)));
}

/** Mix two #rrggbb colours: `a` of the first over the second. */
function hexMix(top: string, base: string, a: number): string {
  const c = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [t, b] = [c(top), c(base)];
  return `rgb(${t.map((v, i) => Math.round(v * a + b[i] * (1 - a))).join(",")})`;
}

/** Whether transcripts cover a day, so agent-side metrics are real rather than blank. */
const known = (day: string): boolean => {
  const c = metrics?.coverage;
  return !!c && day >= c.from && day <= c.to;
};

/** Sunday-first columns with a leading pad, exactly like GitHub. */
function columns(days: string[]): (string | null)[][] {
  const pad = new Date(`${days[0]}T12:00:00`).getDay();
  const cells: (string | null)[] = [...new Array(pad).fill(null), ...days];
  const out: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
  while (out[out.length - 1].length < 7) out[out.length - 1].push(null);
  return out;
}

/**
 * Month boundaries in cell coordinates. A month that starts mid-week gets a
 * stepped outline — down the left of its first column from its first day,
 * across, then up the next column — so the line traces the actual calendar.
 * Straight only when the month starts on a Sunday.
 */
type Seg = { x1: number; y1: number; x2: number; y2: number };
function monthSegments(cols: (string | null)[][]): Seg[] {
  const out: Seg[] = [];
  let lastMonth = -1;
  cols.forEach((col, c) => {
    col.forEach((day, r) => {
      if (!day) return;
      const month = new Date(`${day}T12:00:00`).getMonth();
      if (month === lastMonth) return;
      const first = lastMonth === -1;
      lastMonth = month;
      if (first) return;
      if (r === 0) out.push({ x1: c, y1: 0, x2: c, y2: 7 });
      else {
        out.push({ x1: c, y1: r, x2: c, y2: 7 });
        out.push({ x1: c, y1: r, x2: c + 1, y2: r });
        if (c + 1 < cols.length) out.push({ x1: c + 1, y1: 0, x2: c + 1, y2: r });
      }
    });
  });
  return out;
}

const fmt = (v: number, m: MetricDef) => `${v.toLocaleString("en-US")}${m.unit ? ` ${m.unit}` : ""}`;

/**
 * The grid is always a full year ending today, like GitHub's. Data that
 * covers less fills its place; data older than a year falls off the left.
 * Stats are untouched — they describe everything, the grid shows the year.
 */
function yearWindow(m: Metrics): Metrics {
  const today = new Date().toLocaleDateString("en-CA");
  const end = m.to > today ? m.to : today;
  const start = new Date(`${end}T12:00:00`);
  start.setDate(start.getDate() - 364);
  const days = daysBetween(start.toLocaleDateString("en-CA"), end);
  if (days.length === m.days.length && days[0] === m.days[0]) return m;
  const at = new Map(m.days.map((d, i) => [d, i]));
  const pick = (arr: number[]) => days.map((d) => { const i = at.get(d); return i === undefined ? 0 : (arr[i] ?? 0); });
  return {
    ...m, days,
    series: Object.fromEntries(METRICS.map((x) => [x.key, pick(m.series[x.key])])) as Metrics["series"],
    aux: { leashN: pick(m.aux.leashN), typed: pick(m.aux.typed) },
  };
}

/** Cells are squares at every width: derive the size from the room available. */
function cellSize(cols: number): number {
  const room = ($("card").clientWidth || 1000) - 48 - 18;
  return Math.max(8, Math.min(17, Math.floor((room - (cols - 1) * GAP) / cols)));
}

type Tone = "night" | "heat" | "warm" | null;
const toneOf = (k: MetricKey | null): Tone => (k ? byKey(k).tone ?? null : null);
const isNight = (k: MetricKey | null) => toneOf(k) === "night";
const toneClass = (t: Tone) => (t === "night" ? "n" : t === "heat" ? "h" : t === "warm" ? "w" : "");

/* ---------- calendar ---------- */

function renderCalendar(src: Metrics, animate: boolean): (HTMLElement | null)[][] {
  const m = yearWindow(src);
  const values = m.series[main];
  const level = levels(values);
  const over = overlay ? m.series[overlay] : null;
  const ovAlpha = overlayAlpha(over);
  const cols = columns(m.days);
  const at = new Map(m.days.map((d, i) => [d, i]));
  const cs = cellSize(cols.length);
  const step = cs + GAP;

  document.documentElement.style.setProperty("--cs", `${cs}px`);
  document.documentElement.style.setProperty("--cg", `${GAP}px`);
  const cal = $("cal");
  const tone = toneOf(main), ovTone = toneOf(overlay);
  if (tone) cal.dataset.tone = tone; else delete cal.dataset.tone;
  if (ovTone) cal.dataset.ovtone = ovTone; else delete cal.dataset.ovtone;
  $("wd").replaceChildren(...WEEKDAYS.map((d) => el("span", undefined, d)));

  const monthFrag = document.createDocumentFragment();
  const colFrag = document.createDocumentFragment();
  const board: (HTMLElement | null)[][] = [];
  let lastMonth = -1;
  cols.forEach((col, ci) => {
    const first = col.find((d): d is string => d !== null);
    const date = first ? new Date(`${first}T12:00:00`) : null;
    const label = el("span");
    if (date && date.getMonth() !== lastMonth) {
      label.textContent = MONTHS[date.getMonth()];
      lastMonth = date.getMonth();
    }
    monthFrag.append(label);

    const colEl = el("div", "col");
    const column: (HTMLElement | null)[] = [];
    col.forEach((day, ri) => {
      const cell = el("i", "cell");
      if (!day) {
        cell.dataset.void = "1";
        column.push(null);
      } else {
        const i = at.get(day)!;
        const ov = over?.[i] ?? 0;
        cell.dataset.l = String(level(values[i] ?? 0));
        if (main === "autonomy" && !known(day)) cell.dataset.nodata = "1";
        if (ov > 0) {
          const a = ovAlpha(ov);
          cell.dataset.ov = a >= 1 ? "max" : "1";
          cell.style.setProperty("--oa", a.toFixed(2));
        }
        if (new Date(`${day}T12:00:00`).getMonth() % 2 === 1) cell.dataset.odd = "1";
        cell.dataset.day = day;
        column.push(cell);
      }
      if (animate) cell.style.animationDelay = `${Math.min(600, ci * 6 + ri * 3)}ms`;
      else cell.style.animation = "none";
      colEl.append(cell);
    });
    board.push(column);
    colFrag.append(colEl);
  });
  for (const s of monthSegments(cols)) {
    const line = el("i", "ml");
    const x = s.x1 * step - GAP / 2 - 0.5;
    const y = s.y1 * step - GAP / 2 - 0.5;
    line.style.left = `${x}px`;
    line.style.top = `${y}px`;
    line.style.width = s.x1 === s.x2 ? "1px" : `${(s.x2 - s.x1) * step + 1}px`;
    line.style.height = s.y1 === s.y2 ? "1px" : `${(s.y2 - s.y1) * step + 1}px`;
    colFrag.append(line);
  }
  $("months").replaceChildren(monthFrag);
  $("cols").replaceChildren(colFrag);
  // On a phone the year overflows; the recent months are the ones worth seeing first.
  const wrap = $("cols").closest<HTMLElement>(".calwrap");
  if (wrap) wrap.scrollLeft = wrap.scrollWidth;
  return board;
}

/* ---------- tooltips ---------- */

const tip = () => $("tip");
const hideTip = () => delete tip().dataset.show;

function showTip(anchor: Element, html: string): void {
  const t = tip();
  t.innerHTML = html;
  t.dataset.show = "1";
  const r = anchor.getBoundingClientRect();
  const b = t.getBoundingClientRect();
  t.style.left = `${Math.max(8, Math.min(innerWidth - b.width - 8, r.left + r.width / 2 - b.width / 2))}px`;
  t.style.top = `${r.top - b.height - 10 < 8 ? r.bottom + 10 : r.top - b.height - 10}px`;
}

function tooltipFor(day: string): string {
  const m = yearWindow(metrics!);
  const i = m.days.indexOf(day);
  const date = new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const prompts = m.series.prompts[i] ?? 0;
  const out = [`<b>${date}</b>`, prompts ? `${n(prompts)} prompt${prompts === 1 ? "" : "s"}` : `<i>No prompts</i>`];
  if (main === "autonomy" && !known(day)) out.push(`<br><i>No transcript kept for this day</i>`);
  else if (main !== "prompts" && main !== "godPrompts") {
    const v = m.series[main][i] ?? 0;
    if (v > 0) out.push(`<br><i>${byKey(main).label}:</i> ${fmt(v, byKey(main))}`);
  }
  const g = m.series.godPrompts[i] ?? 0;
  if (g > 0) out.push(`<em>${g} God prompt${g > 1 ? "s" : ""}</em>`);
  if (overlay && overlay !== "godPrompts") {
    const ov = m.series[overlay][i] ?? 0;
    const d = byKey(overlay);
    if (ov > 0) out.push(`<em class="${toneClass(toneOf(overlay))}">${fmt(ov, d)} ${d.label.toLowerCase()}</em>`);
  }
  return out.join(" ");
}

function wireTooltips(): void {
  $("cols").addEventListener("mouseover", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>(".cell[data-day]");
    if (!cell || !metrics || document.querySelector("[data-open]")) return;
    showTip(cell, tooltipFor(cell.dataset.day!));
  });
  $("cols").addEventListener("mouseleave", hideTip);
  // Any element with data-tip explains itself on hover or focus.
  for (const evt of ["mouseover", "focusin"] as const)
    document.addEventListener(evt, (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
      if (t) showTip(t, t.dataset.tip!);
    });
  for (const evt of ["mouseout", "focusout"] as const)
    document.addEventListener(evt, (e) => {
      if ((e.target as HTMLElement).closest("[data-tip]")) hideTip();
    });
  addEventListener("scroll", hideTip, { passive: true });
}

/* ---------- dropdowns ---------- */

const closeMenus = () => document.querySelectorAll("[data-open]").forEach((x) => x.removeAttribute("data-open"));

function buildMenu(dd: HTMLElement, o: {
  current: MetricKey | null; title: string; hint: string; items: MetricDef[];
  none?: string; onPick: (k: MetricKey | null) => void; locked?: boolean;
}): void {
  dd.replaceChildren();
  const btn = el("button") as HTMLButtonElement;
  const t = el("span", "t");
  t.append(document.createTextNode(o.title));
  if (!o.locked) t.insertAdjacentHTML("beforeend", CHEV);
  btn.append(t, el("span", "d", o.hint));
  dd.append(btn);
  if (o.locked) {
    btn.disabled = true;
    return;
  }
  btn.setAttribute("aria-haspopup", "menu");

  const menu = el("div", "menu");
  const add = (label: string, hint: string, key: MetricKey | null) => {
    const b = el("button");
    b.setAttribute("aria-pressed", String(key === o.current));
    b.append(el("span", "mt", label), el("span", "md", hint));
    b.onclick = () => { o.onPick(key); closeMenus(); };
    menu.append(b);
  };
  if (o.none) add(o.none, "No second layer", null);
  const mains = o.items.filter((m) => m.main);
  const rest = o.items.filter((m) => !m.main);
  if (mains.length && rest.length) menu.append(el("div", "grp", "Main"));
  for (const m of mains) add(m.label, m.explain, m.key);
  if (rest.length && mains.length) menu.append(el("div", "grp", "More"));
  for (const m of rest) add(m.label, m.explain, m.key);
  dd.append(menu);

  btn.onclick = (e) => {
    e.stopPropagation();
    const open = dd.hasAttribute("data-open");
    closeMenus();
    hideTip();
    if (!open) dd.dataset.open = "1";
  };
}

function renderPickers(): void {
  const def = byKey(main);
  const ddM = $("ddMain");
  ddM.classList.remove("wait");
  buildMenu(ddM, {
    current: main, title: def.label, hint: def.explain, items: METRICS,
    onPick: (k) => { if (!k) return; main = k; if (overlay === k) overlay = null; render(true); },
  });
  const mt = toneOf(main);
  if (mt) ddM.dataset.tone = mt; else delete ddM.dataset.tone;
  const ov = overlay ? byKey(overlay) : null;
  const dd = $("ddOver");
  buildMenu(dd, {
    current: overlay,
    title: ov ? `+ ${ov.label}` : "+ Overlay",
    hint: ov ? ov.explain : "Highlight a second thing on top",
    items: METRICS.filter((m) => m.overlay && m.key !== main),
    none: "None",
    onPick: (k) => { overlay = k; render(true); },
  });
  dd.toggleAttribute("data-on", !!overlay);
  const ot = toneOf(overlay);
  if (ot) dd.dataset.tone = ot; else delete dd.dataset.tone;
}

/* ---------- stats ---------- */

/** The fifth slot follows the primary metric; the other four never move. */
/** "unattended since 1 Aug" — agent-side totals only reach as far as transcripts do. */
const sinceLabel = (what: string): string => {
  const c = metrics?.coverage;
  return c ? `${what} since ${new Date(`${c.from}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : `${what} (needs transcripts)`;
};

function spotlight(s: Stats): [string, string] {
  switch (main) {
    case "godPrompts": return [`${short(s.maxWords)} words`, "your longest prompt"];
    case "leash": return [`${s.medianLeashMin.toFixed(1)} min`, "median between prompts"];
    case "autonomy": return [`${short(s.autonomyHours)} h`, sinceLabel("unattended")];
    case "promptWords": return [`${s.medianWords} words`, "median prompt"];
    case "nudges": return [`${(s.nudgeRatio * 100).toFixed(1)}%`, "were nudges"];
    case "specShaped": return [short(s.specShaped), "spec-shaped prompts"];
    case "overnight": return [short(s.overnightHandoffs), "overnight handoffs"];
    case "nightOwl": return [short(metrics?.series.nightOwl.reduce((a, b) => a + b, 0) ?? 0), "sent between 22:00 and 05:00"];
    case "politeness": return [short(s.please), "times you said please"];
    case "swearing": return [short(s.swearing ?? 0), "swears"];
    case "annoyed": return [short(s.annoyed ?? 0), "times annoyed"];
    case "caps": return [short(s.capsRage ?? 0), "caps-lock moments"];
    case "thanks": return [short(metrics?.series.thanks.reduce((a, b) => a + b, 0) ?? 0), "thank-yous"];
    case "emoji": return [short(s.emoji ?? 0), "prompts with emoji"];
    default: return [short(s.words), "words written"];
  }
}

/** "m" is the main metric's own colour: green, or the tone it is plotted in. */
type Fact = [string, string, ("m" | "g" | "n" | "h" | "w" | "dim")?];
const mainClass = (): Fact[2] => (toneClass(toneOf(main)) || "m") as Fact[2];

/** The overlay's total, in the overlay's colour — God prompts when nothing is overlaid. */
function overlayFact(s: Stats): Fact {
  if (!overlay || overlay === "godPrompts") return [short(s.godPrompts), "God prompts", "g"];
  const total = metrics?.series[overlay].reduce((a, b) => a + b, 0) ?? 0;
  const d = byKey(overlay);
  return [short(total), d.fact ?? d.label.toLowerCase(), (toneClass(toneOf(overlay)) || "g") as Fact[2]];
}

function factRows(s: Stats | null): Fact[] {
  if (!s) return [["—", "prompts", "dim"], ["—", "God prompts", "dim"], ["—", "longest streak", "dim"], ["—", "longest unattended run", "dim"], ["—", "words written", "dim"]];
  const [sv, sl] = spotlight(s);
  // The prompt count and the plotted metric's spotlight both wear the graph's
  // colour; when prompts are plotted the spotlight is just words written.
  const rows: Fact[] = [
    [`${short(s.totalPrompts)} prompts`, `${s.activeDays} of ${s.spanDays} days`, mainClass()],
    overlayFact(s),
    [`${s.longestStreak} days`, "longest streak"],
    [s.longestUnattendedH ? `${s.longestUnattendedH} h` : "—", "longest unattended run"],
    [sv, sl, main === "prompts" ? undefined : mainClass()],
  ];
  if (s.machines.length > 1) rows.push([String(s.machines.length), "machines"]);
  return rows;
}

function renderFacts(s: Stats | null): void {
  $("facts").replaceChildren(...factRows(s).map(([v, l, tone]) => {
    const d = el("div", `fact${tone ? ` ${tone}` : ""}`);
    d.append(el("b", undefined, v), el("span", undefined, l));
    return d;
  }));
}

function renderByMonth(src: Metrics | null): void {
  const m = src && yearWindow(src);
  const def = byKey(main);
  const bars = $("bars");
  const bt = toneOf(main);
  if (bt) bars.dataset.tone = bt; else delete bars.dataset.tone;
  $("trendH").textContent = `${def.label} by month`;
  if (!m) {
    const now = new Date();
    const months = Array.from({ length: 12 }, (_, i) => new Date(now.getFullYear(), now.getMonth() - 11 + i, 1));
    $("trendQ").dataset.tip = "Totals per month, once there is something to total.";
    bars.replaceChildren(...months.map((d) => {
      const b = el("div", "bar");
      const bar = el("i");
      bar.style.height = "3px";
      b.append(bar, el("span", undefined, MONTHS[d.getMonth()]));
      return b;
    }));
    return;
  }
  const by = new Map<string, number[]>();
  m.days.forEach((d, i) => (by.get(d.slice(0, 7)) ?? by.set(d.slice(0, 7), []).get(d.slice(0, 7))!).push(m.series[main][i]));
  const points = [...by].map(([month, vals]) => {
    const nz = vals.filter((v) => v > 0).sort((a, b) => a - b);
    return [month, def.median ? (nz.length ? nz[nz.length >> 1] : 0) : vals.reduce((a, b) => a + b, 0)] as const;
  });
  const max = Math.max(1, ...points.map(([, v]) => v));
  $("trendQ").dataset.tip = `${def.median ? "Median" : "Total"} ${def.label.toLowerCase()} per month. ${trend(points.map(([, v]) => v))}`;
  bars.replaceChildren(...points.map(([month, v], i) => {
    const b = el("div", `bar${i === points.length - 1 ? " last" : ""}`);
    const bar = el("i");
    bar.style.height = `${Math.max(3, Math.round((v / max) * 64))}px`;
    b.dataset.tip = `${MONTHS[+month.slice(5, 7) - 1]} ${month.slice(0, 4)} — ${fmt(v, def)}`;
    b.append(bar, el("span", undefined, MONTHS[+month.slice(5, 7) - 1]));
    return b;
  }));
}

const trend = (vals: number[]) => {
  const half = Math.max(1, Math.floor(vals.length / 2));
  const a = vals.slice(0, half).reduce((x, y) => x + y, 0) / half;
  const b = vals.slice(-half).reduce((x, y) => x + y, 0) / half;
  if (!a || Math.abs(b - a) / a < 0.1) return "Holding steady.";
  return b > a ? "Trending up." : "Trending down.";
};

function renderMore(s: Stats): void {
  const group = (title: string, rows: Array<[string, string, string?]>, tip?: string) => {
    const g = el("div", "group");
    const h = el("h3", undefined, title);
    if (tip) {
      const q = el("button", "q", "?");
      q.dataset.tip = tip;
      q.setAttribute("aria-label", `About ${title}`);
      h.append(q);
    }
    g.append(h);
    for (const [v, l, rowTip] of rows) {
      const r = el("div", "r");
      r.append(el("b", undefined, v), el("span", undefined, l));
      if (rowTip) {
        const q = el("button", "q", "?");
        q.dataset.tip = rowTip;
        q.setAttribute("aria-label", `About ${l}`);
        r.append(q);
      }
      g.append(r);
    }
    return g;
  };
  const groups = [
    group("Writing", [
      [n(s.words), "words written"], [`${s.medianWords}`, "median words per prompt"], [n(s.maxWords), "words in your longest"],
      [`${(s.nudgeRatio * 100).toFixed(1)}%`, "were nudges"], [n(s.specShaped), "spec-shaped prompts"], [n(s.slashCommands), "slash commands"],
    ]),
    group("Delegating", [
      [`${n(s.autonomyHours)} h`, sinceLabel("unattended")], [`${s.medianLeashMin.toFixed(1)} min`, "median between prompts"], [n(s.overnightHandoffs), "overnight handoffs"],
      [n(s.afterMidnight), "prompts after midnight"], [`${s.medianDaySpanHours} h`, "median day, first to last"], [n(s.please), "times you said please"],
    ]),
  ];
  groups.push(group("Mood", [
    [n(s.swearing ?? 0), "swears"], [n(s.annoyed ?? 0), "times annoyed"], [n(s.capsRage ?? 0), "caps-lock moments"],
    [n(s.sorry), "apologies to a machine"], [n(s.emoji ?? 0), "with emoji"], [n(s.ultrathink ?? 0), "ultrathinks"], [n(s.goAhead ?? 0), "go-aheads"],
  ]));
  if (s.tokens) {
    const t = s.tokens;
    const M = (x: number) => (x >= 1e9 ? `${(x / 1e9).toFixed(1)}B` : `${(x / 1e6).toFixed(1)}M`);
    const rows: Array<[string, string, string?]> = [
      [M(t.total), "tokens, all in"], [M(t.output), "tokens written back"], [n(t.toolCalls), "tool calls"], [n(t.subagents), "subagents spawned"],
    ];
    if (t.usd) rows.push([`$${n(t.usd)}`, "at API list prices",
      `What the same tokens would cost on the Anthropic API at list prices as of ${t.usdAsOf}, cache reads and writes included. A Claude Code subscription bills differently — this is the equivalent, not a bill.${t.unpriced?.length ? ` Not priced: ${t.unpriced.join(", ")}.` : ""}`]);
    groups.push(group("Last 30 days", rows,
      "From session transcripts. Claude Code prunes those after a while, so only a recent window survives — this is a fixed 30 days, not the year."));
  }
  $("groups").replaceChildren(...groups);
  $("moreHint").textContent = s.tokens ? "writing, delegating, mood, tokens" : "writing, delegating, mood";
}

/* ---------- things you said ---------- */

const QUOTE_TONE: Record<string, Tone> = { swearing: "heat", annoyed: "heat", caps: "heat", thanks: "warm", emoji: "warm" };
const QUOTE_LABEL: Record<string, string> = { swearing: "Swearing", annoyed: "Annoyed", caps: "Caps lock", thanks: "Thanks", sorry: "Sorry", banter: "Banter", ultrathink: "Ultrathink", goAhead: "Go ahead", emoji: "Emoji" };
const fmtDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const attribution = (q: Quote) => `${QUOTE_LABEL[q.c] ?? q.c}, ${fmtDay(q.d)}`;
const accentOf = (q: Quote) => { const t = QUOTE_TONE[q.c]; return t === "heat" ? "--h4" : t === "warm" ? "--w4" : "--faint"; };
const SERIF = `Georgia,"Times New Roman",serif`;
const DL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>`;

let shownQuotes: Shown[] = [];
/** Folded by default: the first four, three lines each. Unfolds for this visit only. */
let quotesUnfolded = false;
const QUOTES_FOLDED = 4;
/** Star out swearing on screen and in the cards. Display only; the link is unchanged. */
let censored = localStorage.getItem("promptstreak:censor") !== "0";
const display = (t: string) => (censored ? censor(t) : t);

/** Metrics with the local quote edits applied — what renders and what ships in the link. */
function withEdits(m: Metrics): Metrics {
  const qs = applyEdits(m.quotes ?? []).map((x) => x.q);
  return { ...m, quotes: qs.length ? qs : undefined };
}

/** Plain text with spoiler runs as blocks. */
function richText(p: HTMLElement, text: string): void {
  p.replaceChildren(...parts(text).map(({ s, hidden }) => {
    if (!hidden) return document.createTextNode(s);
    const b = el("span", "sp", s);
    b.setAttribute("aria-label", "hidden");
    return b;
  }));
}

function iconBtn(svg: string, tip: string): HTMLButtonElement {
  const b = el("button", "ico") as HTMLButtonElement;
  b.innerHTML = svg;
  b.dataset.tip = tip;
  b.setAttribute("aria-label", tip);
  return b;
}

function renderQuotes(m: Metrics): void {
  const box = $("quotes");
  const all = m.quotes ?? [];
  shownQuotes = applyEdits(all);
  box.classList.toggle("hidden", !all.length);
  $("qreset").classList.toggle("hidden", !hasEdits());
  $("qpng").classList.toggle("hidden", !shownQuotes.length);
  const cb = $("qcensor");
  cb.classList.toggle("hidden", !shownQuotes.length);
  cb.toggleAttribute("data-on", censored);
  cb.setAttribute("aria-pressed", String(censored));
  cb.dataset.tip = censored ? "Swearing is starred out — click to show it in full" : "Swearing shown in full — click to star it out";
  if (!all.length) return;
  box.toggleAttribute("data-folded", !quotesUnfolded);
  const more = $("qmore");
  if (!shownQuotes.length) {
    $("qgrid").replaceChildren(el("p", "qempty", "Every quote removed — they are still here, restore them any time."));
    more.classList.add("hidden");
    return;
  }
  $("qgrid").replaceChildren(...shownQuotes.map(({ q, key }) => {
    const d = el("div", "quote");
    d.dataset.key = key;
    const mark = el("span", "qmark", "“");
    const tone = QUOTE_TONE[q.c];
    if (tone) mark.dataset.tone = tone;
    const p = el("p");
    richText(p, display(q.t));
    const meta = el("div", "qm");
    const acts = el("div", "qa");
    const dl = iconBtn(DL_SVG, "Save this quote as PNG");
    dl.onclick = () => savePng(drawOneQuote(q), `promptstreak-quote-${q.d}.png`);
    const rm = iconBtn(TRASH_SVG, "Remove this quote");
    rm.onclick = () => {
      removeQuote(key);
      refreshQuotes();
      toast("Quote removed — it stays out of the link", { label: "Undo", run: undoLast });
    };
    acts.append(dl, rm);
    meta.append(el("span", undefined, attribution(q)), acts);
    d.append(mark, p, meta);
    return d;
  }));
  // Anything out of sight — quotes past the fourth, or a line past the third — earns the button.
  const clipped = !quotesUnfolded && Array.from($("qgrid").querySelectorAll<HTMLElement>(".quote p")).some((p) => p.scrollHeight > p.clientHeight + 1);
  const extra = shownQuotes.length - QUOTES_FOLDED;
  more.classList.toggle("hidden", !quotesUnfolded && extra <= 0 && !clipped);
  more.textContent = quotesUnfolded ? "Show less" : extra > 0 ? `Show all ${shownQuotes.length}` : "Show in full";
  more.onclick = () => {
    quotesUnfolded = !quotesUnfolded;
    if (metrics) renderQuotes(metrics);
  };
}

/** After an edit: redraw the card and rewrite the link so it ships the edited list. */
function refreshQuotes(): void {
  if (!metrics) return;
  renderQuotes(metrics);
  updateHash();
}

function undoLast(): void {
  if (undo()) refreshQuotes();
}

/** Select text inside a quote and a "Hide" button floats above the selection. */
function wireHide(): void {
  const btn = $("hidebtn");
  let pending: { key: string; start: number; end: number; text: string } | null = null;
  let timer = 0;
  const hide = () => { pending = null; btn.classList.add("hidden"); };
  const update = () => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hide();
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const p = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".quote p");
    if (!p) return hide();
    const pre = document.createRange();
    pre.selectNodeContents(p);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const end = start + range.toString().length;
    if (end <= start) return hide();
    // Offsets come from the censored text on screen, but the edit must land on
    // the real one — censoring swaps single characters, so the offsets match.
    const key = p.closest<HTMLElement>(".quote")!.dataset.key!;
    const raw = shownQuotes.find((x) => x.key === key)?.q.t ?? p.textContent ?? "";
    pending = { key, start, end, text: raw };
    const r = range.getBoundingClientRect();
    btn.style.left = `${Math.min(innerWidth - 60, Math.max(60, r.left + r.width / 2))}px`;
    btn.style.top = `${Math.max(44, r.top - 8)}px`;
    btn.classList.remove("hidden");
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(update, 60) as unknown as number; };
  document.addEventListener("selectionchange", schedule);
  addEventListener("scroll", schedule, { passive: true });
  btn.onmousedown = (e) => e.preventDefault(); // keep the selection alive through the click
  btn.onclick = () => {
    if (!pending) return;
    hideRange(pending.key, pending.text, pending.start, pending.end);
    document.getSelection()?.removeAllRanges();
    hide();
    refreshQuotes();
    toast("Hidden — the link carries the blank too", { label: "Undo", run: undoLast });
  };
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > max && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** fillText that draws spoiler runs as rounded blocks. */
function fillRich(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number): void {
  let cx = x;
  for (const { s, hidden } of parts(text)) {
    const w = ctx.measureText(s).width;
    if (hidden) {
      const keep = ctx.fillStyle;
      ctx.fillStyle = CSS("--line2");
      ctx.beginPath();
      ctx.roundRect(cx + 1, y - size * 0.7, w - 2, size * 0.88, size * 0.18);
      ctx.fill();
      ctx.fillStyle = keep;
    } else ctx.fillText(s, cx, y);
    cx += w;
  }
}

function savePng(canvas: HTMLCanvasElement, name: string): void {
  canvas.toBlob((b) => {
    if (!b) return;
    const url = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    toast("PNG saved");
  }, "image/png");
}

const cardCtx = (): [HTMLCanvasElement, CanvasRenderingContext2D] => {
  const canvas = $<HTMLCanvasElement>("qcanvas");
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(2, 2);
  ctx.textAlign = "left";
  ctx.fillStyle = CSS("--bg");
  ctx.fillRect(0, 0, 1200, 630);
  return [canvas, ctx];
};
const SANS = `system-ui,-apple-system,"Segoe UI",sans-serif`;

/** One quote, big: the thing people crop and post. */
function drawOneQuote(q: Quote): HTMLCanvasElement {
  const [canvas, ctx] = cardCtx();
  const W = 1200, H = 630;
  const X = 132, MAXW = W - X - 72;
  let size = 50, lines: string[] = [];
  for (; size >= 26; size -= 2) {
    ctx.font = `italic 500 ${size}px ${SANS}`;
    lines = wrapText(ctx, display(q.t), MAXW);
    if (lines.length * size * 1.32 <= 330) break;
  }
  const lh = size * 1.32;
  const blockH = lines.length * lh + 52;
  const top = Math.round((H - 60 - blockH) / 2) + size;
  ctx.fillStyle = CSS(accentOf(q));
  ctx.font = `italic 700 ${Math.round(size * 2.6)}px ${SERIF}`;
  ctx.fillText("“", 56, top + size * 0.42);
  ctx.fillStyle = CSS("--ink");
  ctx.font = `italic 500 ${size}px ${SANS}`;
  lines.forEach((l, i) => fillRich(ctx, l, X, top + i * lh, size));
  ctx.fillStyle = CSS("--mute");
  ctx.font = `400 21px ${SANS}`;
  ctx.fillText(attribution(q), X, top + (lines.length - 1) * lh + 52);
  ctx.fillStyle = CSS("--faint");
  ctx.font = `400 16px ${SANS}`;
  ctx.fillText("Things I said to Claude", 60, H - 44);
  ctx.textAlign = "right";
  ctx.fillStyle = CSS("--ink");
  ctx.font = `500 17px ${CSS("--mono")}`;
  ctx.fillText("npx promptstreak", W - 60, H - 44);
  ctx.textAlign = "left";
  return canvas;
}

/** The whole list on one card. */
function drawQuoteCard(): HTMLCanvasElement {
  const [canvas, ctx] = cardCtx();
  const W = 1200, H = 630;
  const mono = CSS("--mono");

  ctx.fillStyle = CSS("--ink");
  ctx.font = `700 36px ${SANS}`;
  ctx.fillText("Things I said to Claude", 60, 74);
  ctx.fillStyle = CSS("--mute");
  ctx.font = `400 17px ${SANS}`;
  ctx.fillText("A year of prompting, unfiltered", 60, 102);
  ctx.textAlign = "right";
  ctx.fillStyle = CSS("--ink");
  ctx.font = `500 19px ${mono}`;
  ctx.fillText("npx promptstreak", W - 60, 74);
  ctx.fillStyle = CSS("--mute");
  ctx.font = `400 17px ${SANS}`;
  ctx.fillText("to get yours", W - 60, 102);
  ctx.textAlign = "left";

  // Fill the card top-down in ranking order, skipping quotes that don't fit;
  // shrink type only when fewer than five make it in.
  const all = shownQuotes.map((x) => x.q);
  const X = 96, LH = 1.3, META_GAP = 26, NEXT_GAP = 44, TOP = 158, BOTTOM = H - 44;
  let size = 24, qs: Quote[] = [], blocks: string[][] = [];
  for (; size >= 16; size -= 2) {
    ctx.font = `italic 500 ${size}px ${SANS}`;
    qs = []; blocks = [];
    let y = TOP;
    for (const q of all) {
      const lines = wrapText(ctx, display(q.t), W - X - 60);
      const h = (lines.length - 1) * size * LH + META_GAP;
      if (y + h > BOTTOM) continue;
      qs.push(q); blocks.push(lines);
      y += h + NEXT_GAP;
    }
    if (qs.length >= Math.min(5, all.length)) break;
  }
  let y = TOP;
  qs.forEach((q, i) => {
    ctx.fillStyle = CSS(accentOf(q));
    ctx.font = `italic 700 ${Math.round(size * 2)}px ${SERIF}`;
    ctx.fillText("“", 58, y + size * 0.36);
    ctx.fillStyle = CSS("--ink");
    ctx.font = `italic 500 ${size}px ${SANS}`;
    blocks[i].forEach((line, j) => fillRich(ctx, line, X, y + j * size * LH, size));
    const ty = y + (blocks[i].length - 1) * size * LH + META_GAP;
    ctx.fillStyle = CSS("--faint");
    ctx.font = `400 13px ${SANS}`;
    ctx.fillText(attribution(q), X, ty);
    y = ty + NEXT_GAP;
  });
  return canvas;
}

/* ---------- machines ---------- */

function renderMachines(): void {
  if (viewingShared()) {
    const chips = shared!.stats.machines.map((m) => {
      const chip = el("span", "chip");
      chip.toggleAttribute("data-on", true);
      chip.dataset.tip = "Part of the shared view you opened";
      chip.append(el("i"), el("span", undefined, m));
      return chip;
    });
    const add = el("button", "chip add", "+ Add your own machine");
    add.onclick = () => $("addpanel").classList.toggle("hidden");
    $("chips").replaceChildren(...chips, add);
    return;
  }
  const items: HTMLElement[] = snaps.map((s) => {
    const chip = el("button", "chip") as HTMLButtonElement;
    chip.toggleAttribute("data-on", s.on);
    chip.dataset.tip = s.on ? "Click to leave this machine out" : "Click to include this machine";
    chip.append(el("i"), el("span", undefined, s.machine),
      el("span", "meta", `${new Date(s.savedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${n(s.stats.totalPrompts)}`));
    const rm = el("span", "rm", "×");
    rm.dataset.tip = "Forget this machine";
    rm.setAttribute("role", "button");
    rm.onclick = (e) => {
      e.stopPropagation();
      hideTip();
      snaps = snaps.filter((x) => x.id !== s.id);
      save(snaps);
      renderMachines();
      rebuild();
    };
    chip.append(rm);
    chip.onclick = () => { s.on = !s.on; save(snaps); renderMachines(); rebuild(); };
    return chip;
  });
  const add = el("button", "chip add", snaps.length ? "+ Add a machine" : "+ Add your first machine");
  add.onclick = () => $("addpanel").classList.toggle("hidden");
  items.push(add);
  $("chips").replaceChildren(...items);
}

const viewingShared = () => !!shared && !shared.stats.machines.some((m) => snaps.some((s) => s.machine === m));

function rebuild(): void {
  if (viewingShared()) {
    metrics = shared;
    render(true);
    return;
  }
  const on = snaps.filter((s) => s.on);
  if (!on.length) {
    metrics = null;
    history.replaceState(null, "", location.pathname);
    renderEmpty();
    return;
  }
  metrics = combine(on);
  render(true);
}

/* ---------- share card ---------- */

const CSS = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function drawCard(): HTMLCanvasElement {
  const canvas = $<HTMLCanvasElement>("canvas");
  const ctx = canvas.getContext("2d")!;
  const m = yearWindow(metrics!);
  const s = m.stats;
  const W = 1200, H = 630;
  ctx.save();
  ctx.scale(2, 2);
  ctx.fillStyle = CSS("--bg");
  ctx.fillRect(0, 0, W, H);
  const sans = `system-ui,-apple-system,"Segoe UI",sans-serif`;
  const mono = CSS("--mono");
  const def = byKey(main);
  const tone = toneOf(main);
  const ovTone = toneOf(overlay);
  {
    // Everything below is laid out from the top; shift it so the block sits centred.
    const colsN = columns(m.days).length;
    const gap = 4;
    const cell = Math.floor((W - 120 - (colsN - 1) * gap) / colsN);
    const bottom = 166 + 7 * (cell + gap) + 70 + 30;
    ctx.translate(0, Math.max(0, Math.floor((H - bottom - 50) / 2)));
  }
  const rampFor = (t: Tone) => t === "night" ? ["--empty", "--n1", "--n2", "--n3", "--n4"] : t === "heat" ? ["--empty", "--h1", "--h2", "--h3", "--h4"] : t === "warm" ? ["--empty", "--w1", "--w2", "--w3", "--w4"] : ["--empty", "--g1", "--g2", "--g3", "--g4"];
  const ramp = rampFor(tone);
  const ovRamp = rampFor(ovTone);

  ctx.fillStyle = CSS(ramp[4]);
  ctx.font = `700 36px ${sans}`;
  ctx.fillText(def.label, 60, 74);
  if (overlay) {
    const x = 60 + ctx.measureText(def.label).width + 14;
    ctx.fillStyle = CSS(ovTone ? ovRamp[4] : "--gold");
    ctx.font = `600 22px ${sans}`;
    ctx.fillText(`+ ${byKey(overlay).label}`, x, 74);
  }
  ctx.fillStyle = CSS("--mute");
  ctx.font = `400 17px ${sans}`;
  ctx.fillText(def.explain, 60, 102);

  ctx.textAlign = "right";
  ctx.fillStyle = CSS("--ink");
  ctx.font = `500 19px ${mono}`;
  ctx.fillText("npx promptstreak", W - 60, 74);
  // Mirrors the left subtitle exactly: face, size, colour and baseline.
  ctx.fillStyle = CSS("--mute");
  ctx.font = `400 17px ${sans}`;
  ctx.fillText("to get yours", W - 60, 102);
  ctx.textAlign = "left";

  const values = m.series[main];
  const level = levels(values);
  const over = overlay ? m.series[overlay] : null;
  const ovAlpha = overlayAlpha(over);
  const ovColor = CSS(ovTone ? ovRamp[4] : "--gold");
  const cols = columns(m.days);
  const at = new Map(m.days.map((d, i) => [d, i]));
  const gap = 4;
  const cell = Math.floor((W - 120 - (cols.length - 1) * gap) / cols.length);
  const step = cell + gap;
  const x0 = 60, y0 = 166;
  let lastMonth = -1;
  cols.forEach((col, ci) => {
    const cx = x0 + ci * step;
    const first = col.find((d): d is string => d !== null);
    const date = first ? new Date(`${first}T12:00:00`) : null;
    if (date && date.getMonth() !== lastMonth) {
      lastMonth = date.getMonth();
      ctx.fillStyle = CSS("--mute");
      ctx.font = `400 13px ${sans}`;
      ctx.fillText(MONTHS[date.getMonth()], cx, y0 - 14);
    }
    col.forEach((day, ri) => {
      if (!day) return;
      const i = at.get(day)!;
      const ov = over?.[i] ?? 0;
      const odd = new Date(`${day}T12:00:00`).getMonth() % 2 === 1;
      const lv = level(values[i] ?? 0);
      const base = lv === 0 && odd ? CSS("--empty2") : CSS(ramp[lv]);
      ctx.fillStyle = ov > 0 ? hexMix(ovColor, base, ovAlpha(ov)) : base;
      ctx.beginPath();
      ctx.roundRect(cx, y0 + ri * step, cell, cell, 2);
      ctx.fill();
    });
  });
  ctx.fillStyle = CSS("--line2");
  for (const sg of monthSegments(cols)) {
    const x = x0 + sg.x1 * step - gap / 2 - 0.5;
    const y = y0 + sg.y1 * step - gap / 2 - 0.5;
    ctx.fillRect(x, y, sg.x1 === sg.x2 ? 1 : (sg.x2 - sg.x1) * step + 1, sg.y1 === sg.y2 ? 1 : (sg.y2 - sg.y1) * step + 1);
  }

  const fy = y0 + 7 * step + 70;
  ctx.strokeStyle = CSS("--line");
  ctx.beginPath(); ctx.moveTo(60, fy - 46); ctx.lineTo(W - 60, fy - 46); ctx.stroke();
  const facts = factRows(s);
  const slot = (W - 120) / facts.length;
  ctx.textAlign = "center";
  facts.forEach(([v, l, ft], i) => {
    const fx = 60 + slot * (i + 0.5);
    ctx.fillStyle = CSS(ft === "m" ? "--g4" : ft === "g" ? "--gold" : ft === "n" ? "--n4" : ft === "h" ? "--h4" : ft === "w" ? "--w4" : "--ink");
    ctx.font = `600 25px ${mono}`;
    ctx.fillText(v, fx, fy);
    ctx.fillStyle = CSS("--mute");
    ctx.font = `400 14px ${sans}`;
    ctx.fillText(l, fx, fy + 24);
  });
  ctx.textAlign = "left";
  ctx.restore();
  return canvas;
}

/* ---------- render ---------- */

function render(animate = false): void {
  if (!metrics) return;
  stopSnake();
  $("icons").classList.remove("hidden");
  $("ddOver").classList.remove("hidden");
  $("more").classList.remove("hidden");
  renderPickers();
  renderCalendar(metrics, animate);
  renderFacts(metrics.stats);
  renderQuotes(metrics);
  renderByMonth(metrics);
  renderMore(metrics.stats);
  updateHash();
}

/** The address bar is the share link: always the current view, quote edits included. */
function updateHash(): void {
  if (!metrics) return;
  void encode(withEdits(metrics), metrics.stats.machines[0], true).then((p) => history.replaceState(null, "", `${location.pathname}#${p}`));
}

/** Same layout as the real thing: the last twelve months, empty, with the snake on them. */
function renderEmpty(): void {
  stopSnake();
  main = "prompts";
  overlay = null;
  $("icons").classList.add("hidden");
  $("ddOver").classList.add("hidden");
  $("more").classList.add("hidden");
  $("quotes").classList.add("hidden");
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 364);
  const days = daysBetween(from.toLocaleDateString("en-CA"), to.toLocaleDateString("en-CA"));
  const zeros = () => new Array(days.length).fill(0);
  const blank: Metrics = {
    from: days[0], to: days[days.length - 1], days,
    series: Object.fromEntries(METRICS.map((m) => [m.key, zeros()])) as Metrics["series"],
    aux: { leashN: zeros(), typed: zeros() },
    stats: null as unknown as Stats,
  };
  const ddM = $("ddMain");
  ddM.classList.add("wait");
  delete ddM.dataset.tone;
  buildMenu(ddM, { current: null, title: "Waiting for data…", hint: "Run npx promptstreak and open the link it prints", items: [], onPick: () => {}, locked: true });
  const board = renderCalendar(blank, false);
  renderFacts(null);
  renderByMonth(null);
  const score = el("div", "fact dim");
  const b = el("b", undefined, "0");
  score.append(b, el("span", undefined, "Snake, while you wait — arrows or WASD"));
  $("facts").append(score);
  startSnake(board, b);
}

/* ---------- input ---------- */

async function addFiles(list: FileList | File[]): Promise<void> {
  let added = 0;
  for (const file of Array.from(list)) {
    const events = parseUnknownText(await file.text());
    if (!events.length) continue;
    const name = file.name.replace(/\.jsonl$/, "") || "dropped file";
    const m = computeMetrics(merge(events), { machines: [name] });
    snaps = upsert({ v: 1, from: m.from, to: m.to, series: m.series, aux: m.aux, stats: m.stats, label: name });
    added++;
  }
  if (!added) return toast("Nothing readable in that file");
  $("addpanel").classList.add("hidden");
  renderMachines();
  rebuild();
}

async function importHash(): Promise<void> {
  const hash = location.hash.slice(1);
  if (!hash) return;
  try {
    const payload = await decode(hash);
    // The page rewrites the URL with the merged view after a merge. Re-reading
    // that as a machine would overwrite a real machine with the merged data.
    if (payload.stats.machines.length > 1) shared = expand(payload);
    else {
      shared = null;
      // A link this page wrote carries edited quotes. If the machine is already
      // here, its snapshot has the originals — keep those so undo still works.
      if (!(payload.e && holds(payload))) snaps = upsert(payload);
    }
  } catch (err) {
    console.error("Could not read that link:", err);
    toast("That link could not be read");
  }
}

let toastTimer = 0;
function toast(msg: string, action?: { label: string; run: () => void }): void {
  const t = $("toast");
  t.replaceChildren(msg);
  if (action) {
    const b = el("button", "tb", action.label);
    b.onclick = () => { delete t.dataset.show; action.run(); };
    t.append(b);
  }
  t.dataset.show = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => delete t.dataset.show, action ? 7000 : 1600) as unknown as number;
}

const copy = (text: string, msg: string) => void navigator.clipboard.writeText(text).then(() => toast(msg));

async function boot(): Promise<void> {
  wireTooltips();
  document.addEventListener("click", closeMenus);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenus());
  $("domain").textContent = location.host || "promptstreak";
  $("cta").onclick = () => copy("npx promptstreak", "Copied — paste it in a terminal");
  $("copyCmd").onclick = () => copy("npx promptstreak", "Copied");
  $("link").onclick = () => copy(location.href, "Share link copied");
  $("png").onclick = () => savePng(drawCard(), `promptstreak-${main}${overlay ? `+${overlay}` : ""}.png`);
  $("qpng").onclick = () => savePng(drawQuoteCard(), "promptstreak-quotes.png");
  $("qcensor").onclick = () => {
    censored = !censored;
    try { localStorage.setItem("promptstreak:censor", censored ? "1" : "0"); } catch { /* still applies for this visit */ }
    if (metrics) renderQuotes(metrics);
  };
  $("qreset").onclick = () => {
    resetEdits();
    refreshQuotes();
    toast("Quotes restored", { label: "Undo", run: undoLast });
  };
  wireHide();

  const drop = $("drop");
  const picker = $<HTMLInputElement>("picker");
  drop.onclick = () => picker.click();
  picker.onchange = () => picker.files && void addFiles(picker.files);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer?.files) void addFiles(e.dataTransfer.files); };

  snaps = load();
  await importHash();
  renderMachines();
  rebuild();
  // A second machine's link pasted into an open tab only changes the fragment,
  // which never reloads the page — so listen for it.
  addEventListener("hashchange", () => void importHash().then(() => { renderMachines(); rebuild(); }));

  let resizeTimer = 0;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => (metrics ? renderCalendar(metrics, false) : renderEmpty()), 120) as unknown as number;
  });
}

void boot();
