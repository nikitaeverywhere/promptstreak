import { decode, encode } from "./codec.js";
import { merge, parseUnknownText } from "./parse-core.js";
import { computeMetrics } from "./metrics.js";
import { METRICS, byKey, type MetricDef } from "./web-metrics.js";
import { combine, expand, load, save, upsert, type Snapshot } from "./web-store.js";
import type { MetricKey, Metrics, Stats } from "./types.js";
import { startSnake, stopSnake } from "./web-snake.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const n = (v: number) => Math.round(v).toLocaleString("en-US");
const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

let metrics: Metrics | null = null;
let main: MetricKey = "prompts";
let overlay: MetricKey | null = null;
let snaps: Snapshot[] = [];

/* ---------- shared helpers ---------- */

export function levels(values: number[]): (v: number) => 0 | 1 | 2 | 3 | 4 {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(nz.length * p))];
  const [a, b, c] = [q(0.25), q(0.5), q(0.75)];
  return (v) => (v <= 0 ? 0 : v <= a ? 1 : v <= b ? 2 : v <= c ? 3 : 4);
}

/** Sunday-first columns with a leading pad, exactly like GitHub. */
export function columns(days: string[]): (string | null)[][] {
  const pad = new Date(`${days[0]}T12:00:00`).getDay();
  const cells: (string | null)[] = [...new Array(pad).fill(null), ...days];
  const out: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
  while (out[out.length - 1].length < 7) out[out.length - 1].push(null);
  return out;
}

const fmtVal = (v: number, m: MetricDef) =>
  v === 0 ? "none" : `${v.toLocaleString("en-US")}${m.unit ? ` ${m.unit}` : ""}`;

/* ---------- calendar ---------- */

function renderCalendar(m: Metrics, animate: boolean): void {
  const def = byKey(main);
  const values = m.series[main];
  const level = levels(values);
  const over = overlay ? m.series[overlay] : null;
  const cols = columns(m.days);
  const at = new Map(m.days.map((d, i) => [d, i]));

  $("wd").replaceChildren(...WEEKDAYS.map((d) => el("span", undefined, d)));

  const monthsEl = $("months");
  const colsEl = $("cols");
  monthsEl.replaceChildren();
  colsEl.replaceChildren();

  let lastMonth = -1;
  cols.forEach((col, ci) => {
    const first = col.find((d): d is string => d !== null);
    const date = first ? new Date(`${first}T12:00:00`) : null;
    const starts = !!date && date.getMonth() !== lastMonth;

    const label = el("span");
    label.style.flex = "1";
    if (starts && date) {
      label.textContent = MONTHS[date.getMonth()];
      lastMonth = date.getMonth();
    }
    monthsEl.append(label);

    const colEl = el("div", "col");
    if (starts) colEl.classList.add("mstart");
    if (date && date.getMonth() % 2 === 1) colEl.classList.add("zeb");

    col.forEach((day, ri) => {
      const cell = el("i", "cell");
      if (!day) {
        cell.dataset.void = "1";
      } else {
        const i = at.get(day)!;
        const v = values[i] ?? 0;
        const ov = over?.[i] ?? 0;
        if (ov > 0) cell.dataset.gold = ov > 2 ? "2" : "1";
        else cell.dataset.l = String(level(v));
        cell.dataset.day = day;
      }
      if (animate) cell.style.animationDelay = `${Math.min(700, ci * 6 + ri * 3)}ms`;
      else cell.style.animation = "none";
      colEl.append(cell);
    });
    colsEl.append(colEl);
  });

  const size = Math.max(7, Math.min(14, Math.floor((colsEl.clientWidth || 900) / cols.length) - 3));
  document.documentElement.style.setProperty("--cs", `${size}px`);
  document.documentElement.style.setProperty("--cg", `3px`);
  void def;
}

/* ---------- tooltip ---------- */

function tooltipFor(day: string): string {
  const m = metrics!;
  const i = m.days.indexOf(day);
  const date = new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
  const def = byKey(main);
  const lines = [`<b>${date}</b>`];
  lines.push(`<i>${def.label}:</i> ${fmtVal(m.series[main][i] ?? 0, def)}`);
  if (main !== "prompts") lines.push(`<br><i>Prompts:</i> ${n(m.series.prompts[i] ?? 0)}`);
  const g = m.series.godPrompts[i] ?? 0;
  if (g > 0) lines.push(`<em>${g} god prompt${g > 1 ? "s" : ""}</em>`);
  if (overlay && overlay !== "godPrompts") {
    const ov = m.series[overlay][i] ?? 0;
    if (ov > 0) lines.push(`<em>${fmtVal(ov, byKey(overlay))} · ${byKey(overlay).label}</em>`);
  }
  return lines.join(" ");
}

function wireTooltip(): void {
  const tip = $("tip");
  $("cols").addEventListener("mouseover", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>(".cell[data-day]");
    if (!cell || !metrics) return;
    tip.innerHTML = tooltipFor(cell.dataset.day!);
    tip.dataset.show = "1";
    const r = cell.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2))}px`;
    tip.style.top = `${r.top - t.height - 10 < 8 ? r.bottom + 10 : r.top - t.height - 10}px`;
  });
  $("cols").addEventListener("mouseleave", () => delete tip.dataset.show);
}

/* ---------- dropdowns ---------- */

function buildMenu(dd: HTMLElement, opts: {
  current: MetricKey | null;
  title: string;
  hint: string;
  items: MetricDef[];
  allowNone?: string;
  onPick: (k: MetricKey | null) => void;
}): void {
  dd.replaceChildren();
  const btn = el("button");
  const t = el("span", "t");
  t.append(document.createTextNode(opts.title));
  t.insertAdjacentHTML("beforeend",
    `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`);
  btn.append(t, el("span", "d", opts.hint));
  dd.append(btn);

  const menu = el("div", "menu");
  const add = (label: string, hint: string, key: MetricKey | null) => {
    const b = el("button");
    b.setAttribute("aria-pressed", String(key === opts.current));
    b.append(el("span", "mt", label), el("span", "md", hint));
    b.onclick = () => {
      opts.onPick(key);
      delete dd.dataset.open;
    };
    menu.append(b);
  };
  if (opts.allowNone) add(opts.allowNone, "no second layer", null);

  const mains = opts.items.filter((m) => m.main);
  const rest = opts.items.filter((m) => !m.main);
  if (mains.length && rest.length) menu.append(el("div", "grp", "Main"));
  for (const m of mains) add(m.label, m.explain, m.key);
  if (rest.length && mains.length) menu.append(el("div", "grp", "More"));
  for (const m of rest) add(m.label, m.explain, m.key);
  dd.append(menu);

  btn.onclick = (e) => {
    e.stopPropagation();
    const open = dd.hasAttribute("data-open");
    document.querySelectorAll("[data-open]").forEach((x) => x.removeAttribute("data-open"));
    if (!open) dd.dataset.open = "1";
  };
}

function renderPickers(): void {
  const def = byKey(main);
  buildMenu($("ddMain"), {
    current: main, title: def.label, hint: def.explain, items: METRICS,
    onPick: (k) => { if (k) { main = k; render(true); } },
  });
  const ov = overlay ? byKey(overlay) : null;
  const dd = $("ddOver");
  buildMenu(dd, {
    current: overlay,
    title: ov ? `+ ${ov.label}` : "+ overlay",
    hint: ov ? "shown in gold on top" : "highlight a second thing",
    items: METRICS.filter((m) => m.overlay && m.key !== main),
    allowNone: "None",
    onPick: (k) => { overlay = k; render(true); },
  });
  if (overlay) dd.dataset.on = "1";
  else delete dd.dataset.on;
}

/* ---------- stats ---------- */

function renderFacts(s: Stats): void {
  const facts: Array<{ v: string; l: string; gold?: boolean }> = [
    { v: `${n(s.totalPrompts)} prompts`, l: `${s.activeDays} of ${s.spanDays} days` },
    { v: s.archetype, l: `median ${s.medianLeashMin} min between prompts` },
    { v: `${s.longestStreak} days`, l: "longest streak" },
    { v: n(s.godPrompts), l: "god prompts", gold: true },
    { v: `${s.longestUnattendedH} h`, l: "longest unattended run" },
  ];
  $("facts").replaceChildren(...facts.map((f) => {
    const d = el("div", `fact${f.gold ? " g" : ""}`);
    d.append(el("b", undefined, f.v), el("span", undefined, f.l));
    return d;
  }));
  const from = $("from");
  if (s.machines.length >= 2) {
    from.textContent = `From ${s.machines.length} machines · ${s.machines.join(", ")}`;
    from.classList.remove("hidden");
  } else from.classList.add("hidden");
}

function renderSecondary(m: Metrics): void {
  const s = m.stats;
  $("secondary").classList.remove("hidden");

  const def = byKey(main);
  const byMonth = new Map<string, number[]>();
  m.days.forEach((d, i) => {
    const k = d.slice(0, 7);
    (byMonth.get(k) ?? byMonth.set(k, []).get(k)!).push(m.series[main][i]);
  });
  const points = [...byMonth].map(([month, vals]) => {
    const nz = vals.filter((v) => v > 0);
    const v = def.median
      ? nz.length ? nz.sort((a, b) => a - b)[nz.length >> 1] : 0
      : vals.reduce((a, b) => a + b, 0);
    return [month, v] as const;
  });
  const max = Math.max(1, ...points.map(([, v]) => v));
  $("trendH").textContent = `${def.label} by month`;
  $("trendSub").textContent = def.median
    ? `Median of ${def.label.toLowerCase()} per month. ${trendWord(points.map(([, v]) => v))}`
    : `Total ${def.label.toLowerCase()} per month. ${trendWord(points.map(([, v]) => v))}`;
  $("trend").replaceChildren(...points.map(([month, v], i) => {
    const bar = el("i");
    bar.style.height = `${Math.max(2, (v / max) * 44)}px`;
    if (i === points.length - 1) bar.className = "last";
    bar.title = `${month} — ${fmtVal(v, def)}`;
    return bar;
  }));
  $("tlabels").replaceChildren(...points.map(([month]) =>
    el("span", undefined, MONTHS[Number(month.slice(5, 7)) - 1])));

  const rest: Array<[string, string]> = [
    [n(s.words), "words written"],
    [`${s.medianWords}`, "median words per prompt"],
    [n(s.maxWords), "words in your longest"],
    [`${(s.nudgeRatio * 100).toFixed(1)}%`, "were nudges"],
    [n(s.specShaped), "spec-shaped prompts"],
    [`${n(s.autonomyHours)} h`, "unattended in total"],
    [n(s.overnightHandoffs), "overnight handoffs"],
    [n(s.afterMidnight), "prompts after midnight"],
    [`${s.medianDaySpanHours} h`, "median day, first to last"],
    [n(s.please), '"please"'],
    [n(s.thanks), '"thanks"'],
    [n(s.slashCommands), "slash commands"],
  ];
  if (s.tokens) {
    const M = (x: number) => (x >= 1e9 ? `${(x / 1e9).toFixed(1)}B` : `${(x / 1e6).toFixed(1)}M`);
    rest.push([M(s.tokens.total), "tokens, all in"], [M(s.tokens.output), "tokens written back"],
      [n(s.tokens.toolCalls), "tool calls"], [n(s.tokens.subagents), "subagents spawned"]);
    $("restSub").textContent =
      `Everything the graph does not show. Token and tool counts cover ${s.tokens.fromDay} to ${s.tokens.toDay} only — Claude Code prunes transcripts, so the rest is already gone.`;
  }
  $("rest").replaceChildren(...rest.map(([v, l]) => {
    const d = el("div", "s");
    d.append(el("b", undefined, v), el("span", undefined, l));
    return d;
  }));
}

const trendWord = (vals: number[]) => {
  const half = Math.max(1, Math.floor(vals.length / 2));
  const a = vals.slice(0, half).reduce((x, y) => x + y, 0) / half;
  const b = vals.slice(-half).reduce((x, y) => x + y, 0) / half;
  if (!a || Math.abs(b - a) / a < 0.1) return "Holding steady.";
  return b > a ? "Trending up." : "Trending down.";
};

/* ---------- machines ---------- */

function renderMachines(): void {
  const box = $("machines");
  box.replaceChildren(...snaps.map((s) => {
    const row = el("label", "m");
    const cb = el("input") as HTMLInputElement;
    cb.type = "checkbox";
    cb.checked = s.on;
    cb.onchange = () => {
      s.on = cb.checked;
      if (!snaps.some((x) => x.on)) { s.on = cb.checked = true; return; }
      save(snaps);
      rebuild();
    };
    const name = el("span", "nm", s.machine);
    const meta = el("span", "meta",
      `${new Date(s.savedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${n(s.stats.totalPrompts)} prompts`);
    const rm = el("button", "rm", "×");
    rm.title = "Forget this machine";
    rm.onclick = (e) => {
      e.preventDefault();
      snaps = snaps.filter((x) => x.id !== s.id);
      if (snaps.length && !snaps.some((x) => x.on)) snaps[0].on = true;
      save(snaps);
      renderMachines();
      rebuild();
    };
    row.append(cb, name, meta, rm);
    return row;
  }));
  $("mSub").classList.toggle("hidden", false);
}

function rebuild(): void {
  const on = snaps.filter((s) => s.on);
  if (!on.length) return;
  metrics = combine(on);
  render(true);
}

/* ---------- share card ---------- */

const CSS = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function drawCard(): HTMLCanvasElement {
  const canvas = $<HTMLCanvasElement>("canvas");
  const ctx = canvas.getContext("2d")!;
  const m = metrics!;
  const s = m.stats;
  const W = 1200, H = 630;
  ctx.save();
  ctx.scale(2, 2);
  ctx.fillStyle = CSS("--bg");
  ctx.fillRect(0, 0, W, H);
  const sans = `-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif`;
  const mono = CSS("--mono");
  const def = byKey(main);

  ctx.fillStyle = CSS("--ink");
  ctx.font = `700 40px ${sans}`;
  ctx.fillText(def.label, 60, 78);
  if (overlay) {
    const w = ctx.measureText(def.label).width;
    ctx.fillStyle = CSS("--gold");
    ctx.font = `500 24px ${sans}`;
    ctx.fillText(`+ ${byKey(overlay).label}`, 60 + w + 16, 78);
  }
  ctx.fillStyle = CSS("--mute");
  ctx.font = `400 19px ${sans}`;
  ctx.fillText(def.explain, 60, 108);

  ctx.textAlign = "right";
  ctx.fillStyle = CSS("--ink");
  ctx.font = `500 20px ${mono}`;
  ctx.fillText("npx promptstreak", W - 60, 74);
  ctx.fillStyle = CSS("--faint");
  ctx.font = `400 15px ${mono}`;
  ctx.fillText("to get yours", W - 60, 98);
  ctx.textAlign = "left";

  const values = m.series[main];
  const level = levels(values);
  const over = overlay ? m.series[overlay] : null;
  const cols = columns(m.days);
  const at = new Map(m.days.map((d, i) => [d, i]));
  const gap = 4;
  const cell = Math.floor((W - 120 - (cols.length - 1) * gap) / cols.length);
  const x0 = 60, y0 = 172;

  let lastMonth = -1;
  cols.forEach((col, ci) => {
    const x = x0 + ci * (cell + gap);
    const first = col.find((d): d is string => d !== null);
    const date = first ? new Date(`${first}T12:00:00`) : null;
    if (date && date.getMonth() !== lastMonth) {
      lastMonth = date.getMonth();
      ctx.fillStyle = CSS("--line2");
      ctx.fillRect(x - gap / 2 - 0.5, y0 - 8, 1, 7 * (cell + gap) + 12);
      ctx.fillStyle = CSS("--mute");
      ctx.font = `400 14px ${sans}`;
      ctx.fillText(MONTHS[date.getMonth()], x, y0 - 16);
    }
    if (date && date.getMonth() % 2 === 1) {
      ctx.fillStyle = "rgba(255,255,255,.02)";
      ctx.fillRect(x - 2, y0 - 4, cell + 4, 7 * (cell + gap));
    }
    col.forEach((day, ri) => {
      if (!day) return;
      const i = at.get(day)!;
      const ov = over?.[i] ?? 0;
      ctx.fillStyle = ov > 0
        ? (ov > 2 ? CSS("--gold") : CSS("--gold2"))
        : [CSS("--empty"), CSS("--g1"), CSS("--g2"), CSS("--g3"), CSS("--g4")][level(values[i] ?? 0)];
      ctx.beginPath();
      ctx.roundRect(x, y0 + ri * (cell + gap), cell, cell, 2);
      ctx.fill();
    });
  });

  const fy = y0 + 7 * (cell + gap) + 74;
  ctx.strokeStyle = CSS("--line");
  ctx.beginPath();
  ctx.moveTo(60, fy - 48);
  ctx.lineTo(W - 60, fy - 48);
  ctx.stroke();

  const facts: Array<[string, string, boolean]> = [
    [`${n(s.totalPrompts)} prompts`, `${s.activeDays} of ${s.spanDays} days`, false],
    [s.archetype, `median ${s.medianLeashMin} min apart`, false],
    [`${s.longestStreak} days`, "longest streak", false],
    [n(s.godPrompts), "god prompts", true],
    [`${s.longestUnattendedH} h`, "longest unattended", false],
  ];
  facts.forEach(([v, l, gold], i) => {
    const x = 60 + i * ((W - 120) / facts.length);
    ctx.fillStyle = gold ? CSS("--gold") : CSS("--ink");
    ctx.font = `600 27px ${mono}`;
    ctx.fillText(v, x, fy);
    ctx.fillStyle = CSS("--mute");
    ctx.font = `400 15px ${sans}`;
    ctx.fillText(l, x, fy + 25);
  });

  ctx.fillStyle = CSS("--faint");
  ctx.font = `400 15px ${sans}`;
  const machines = s.machines.length >= 2 ? `  ·  From ${s.machines.length} machines` : "";
  ctx.fillText(`${m.from} → ${m.to}${machines}`, 60, H - 38);
  ctx.restore();
  return canvas;
}

/* ---------- render ---------- */

function render(animate = false): void {
  if (!metrics) return;
  stopSnake();
  $("secondary").classList.remove("hidden");
  $("tools").classList.remove("hidden");
  renderPickers();
  renderCalendar(metrics, animate);
  renderFacts(metrics.stats);
  renderSecondary(metrics);
  void encode(metrics, metrics.stats.machines[0]).then((p) => {
    history.replaceState(null, "", `${location.pathname}#${p}`);
  });
}

/* ---------- input ---------- */

async function addFiles(list: FileList | File[]): Promise<void> {
  for (const file of Array.from(list)) {
    const events = parseUnknownText(await file.text());
    if (!events.length) continue;
    const name = file.name.replace(/\.jsonl$/, "") || "dropped file";
    const m = computeMetrics(merge(events), { machines: [name] });
    snaps = upsert({ v: 1, from: m.from, to: m.to, series: m.series, stats: m.stats, label: name });
  }
  renderMachines();
  rebuild();
}

function toast(msg: string): void {
  const t = $("toast");
  t.textContent = msg;
  t.dataset.show = "1";
  setTimeout(() => delete t.dataset.show, 1600);
}

async function boot(): Promise<void> {
  wireTooltip();
  document.addEventListener("click", () =>
    document.querySelectorAll("[data-open]").forEach((x) => x.removeAttribute("data-open")));

  $("domain").textContent = location.host || "promptstreak";
  $("png").onclick = () => drawCard().toBlob((b) => {
    if (!b) return;
    const url = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = url;
    a.download = `promptstreak-${main}.png`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Saved");
  }, "image/png");
  $("link").onclick = () => void navigator.clipboard.writeText(location.href).then(() => toast("Link copied"));
  $("copyCmd").onclick = () => void navigator.clipboard.writeText("npx promptstreak").then(() => toast("Copied"));

  const drop = $("drop");
  const picker = $<HTMLInputElement>("picker");
  drop.onclick = () => picker.click();
  picker.onchange = () => picker.files && void addFiles(picker.files);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    if (e.dataTransfer?.files) void addFiles(e.dataTransfer.files);
  };

  snaps = load();
  const hash = location.hash.slice(1);
  if (hash) {
    try {
      snaps = upsert(await decode(hash));
    } catch (err) {
      console.error("Could not read that link:", err);
    }
  }

  if (snaps.length) {
    renderMachines();
    rebuild();
    addEventListener("resize", () => metrics && renderCalendar(metrics, false));
    return;
  }

  // Nothing to show yet: the grid becomes a game instead of an empty box.
  renderPickers();
  renderMachines();
  $("secondary").classList.add("hidden");
  $("tools").classList.add("hidden");
  startSnake($("cols"), $("wd"), $("months"), $("facts"));
}

void boot();
