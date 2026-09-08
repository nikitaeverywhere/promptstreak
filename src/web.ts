import { decode, encode } from "./codec.js";
import { merge, parseUnknownText } from "./parse-core.js";
import { computeMetrics } from "./metrics.js";
import { METRICS, byKey, type MetricDef } from "./web-metrics.js";
import { combine, load, save, upsert, type Snapshot } from "./web-store.js";
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
const CHEV = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const GAP = 3;

let metrics: Metrics | null = null;
let main: MetricKey = "prompts";
let overlay: MetricKey | null = "godPrompts";
let snaps: Snapshot[] = [];

/* ---------- helpers ---------- */

function levels(values: number[]): (v: number) => 0 | 1 | 2 | 3 | 4 {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(nz.length * p))];
  const [a, b, c] = [q(0.25), q(0.5), q(0.75)];
  return (v) => (v <= 0 ? 0 : v <= a ? 1 : v <= b ? 2 : v <= c ? 3 : 4);
}

/** Sunday-first columns with a leading pad, exactly like GitHub. */
function columns(days: string[]): (string | null)[][] {
  const pad = new Date(`${days[0]}T12:00:00`).getDay();
  const cells: (string | null)[] = [...new Array(pad).fill(null), ...days];
  const out: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
  while (out[out.length - 1].length < 7) out[out.length - 1].push(null);
  return out;
}

const fmt = (v: number, m: MetricDef) => `${v.toLocaleString("en-US")}${m.unit ? ` ${m.unit}` : ""}`;

/** Cells are squares at every width: derive the size from the room available. */
function cellSize(cols: number): number {
  const room = ($("card").clientWidth || 1000) - 48 - 18;
  return Math.max(8, Math.min(17, Math.floor((room - (cols - 1) * GAP) / cols)));
}

/* ---------- calendar ---------- */

function renderCalendar(m: Metrics, animate: boolean): void {
  const values = m.series[main];
  const level = levels(values);
  const over = overlay ? m.series[overlay] : null;
  const cols = columns(m.days);
  const at = new Map(m.days.map((d, i) => [d, i]));

  document.documentElement.style.setProperty("--cs", `${cellSize(cols.length)}px`);
  document.documentElement.style.setProperty("--cg", `${GAP}px`);
  $("wd").replaceChildren(...WEEKDAYS.map((d) => el("span", undefined, d)));

  const monthsEl = $("months");
  const colsEl = $("cols");
  const monthFrag = document.createDocumentFragment();
  const colFrag = document.createDocumentFragment();

  let lastMonth = -1;
  cols.forEach((col, ci) => {
    const first = col.find((d): d is string => d !== null);
    const date = first ? new Date(`${first}T12:00:00`) : null;
    const starts = !!date && date.getMonth() !== lastMonth;
    const label = el("span");
    if (starts && date) {
      label.textContent = MONTHS[date.getMonth()];
      lastMonth = date.getMonth();
    }
    monthFrag.append(label);

    const colEl = el("div", "col");
    if (starts && ci > 0) colEl.classList.add("mstart");
    if (date && date.getMonth() % 2 === 1) colEl.classList.add("zeb");
    col.forEach((day, ri) => {
      const cell = el("i", "cell");
      if (!day) cell.dataset.void = "1";
      else {
        const i = at.get(day)!;
        const ov = over?.[i] ?? 0;
        if (ov > 0) cell.dataset.gold = ov > 2 ? "2" : "1";
        else cell.dataset.l = String(level(values[i] ?? 0));
        cell.dataset.day = day;
      }
      if (animate) cell.style.animationDelay = `${Math.min(600, ci * 6 + ri * 3)}ms`;
      else cell.style.animation = "none";
      colEl.append(cell);
    });
    colFrag.append(colEl);
  });
  monthsEl.replaceChildren(monthFrag);
  colsEl.replaceChildren(colFrag);
  // On a phone the year overflows; the recent months are the ones worth seeing first.
  const wrap = colsEl.closest<HTMLElement>(".calwrap");
  if (wrap) wrap.scrollLeft = wrap.scrollWidth;
}

/* ---------- tooltip ---------- */

function tooltipFor(day: string): string {
  const m = metrics!;
  const i = m.days.indexOf(day);
  const date = new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const prompts = m.series.prompts[i] ?? 0;
  const out = [`<b>${date}</b>`, prompts ? `${n(prompts)} prompt${prompts === 1 ? "" : "s"}` : `<i>no prompts</i>`];
  if (main !== "prompts" && main !== "godPrompts") {
    const v = m.series[main][i] ?? 0;
    if (v > 0) out.push(`<br><i>${byKey(main).label}:</i> ${fmt(v, byKey(main))}`);
  }
  const g = m.series.godPrompts[i] ?? 0;
  if (g > 0) out.push(`<em>${g} God prompt${g > 1 ? "s" : ""}</em>`);
  if (overlay && overlay !== "godPrompts") {
    const ov = m.series[overlay][i] ?? 0;
    if (ov > 0) out.push(`<em>${fmt(ov, byKey(overlay))} ${byKey(overlay).label.toLowerCase()}</em>`);
  }
  return out.join(" ");
}

const hideTip = () => delete $("tip").dataset.show;

function wireTooltip(): void {
  const tip = $("tip");
  $("cols").addEventListener("mouseover", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>(".cell[data-day]");
    if (!cell || !metrics || document.querySelector("[data-open]")) return;
    tip.innerHTML = tooltipFor(cell.dataset.day!);
    tip.dataset.show = "1";
    const r = cell.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2))}px`;
    tip.style.top = `${r.top - t.height - 10 < 8 ? r.bottom + 10 : r.top - t.height - 10}px`;
  });
  $("cols").addEventListener("mouseleave", hideTip);
  addEventListener("scroll", hideTip, { passive: true });
}

/* ---------- dropdowns ---------- */

const closeMenus = () => document.querySelectorAll("[data-open]").forEach((x) => x.removeAttribute("data-open"));

function buildMenu(dd: HTMLElement, o: {
  current: MetricKey | null; title: string; hint: string; items: MetricDef[];
  none?: string; onPick: (k: MetricKey | null) => void;
}): void {
  dd.replaceChildren();
  const btn = el("button");
  btn.setAttribute("aria-haspopup", "menu");
  const t = el("span", "t");
  t.append(document.createTextNode(o.title));
  t.insertAdjacentHTML("beforeend", CHEV);
  btn.append(t, el("span", "d", o.hint));
  dd.append(btn);

  const menu = el("div", "menu");
  const add = (parent: HTMLElement, label: string, hint: string, key: MetricKey | null) => {
    const b = el("button");
    b.setAttribute("aria-pressed", String(key === o.current));
    b.title = hint;
    b.append(el("span", "mt", label), el("span", "md", hint));
    b.onclick = () => { o.onPick(key); closeMenus(); };
    parent.append(b);
  };
  if (o.none) add(menu, o.none, "no second layer", null);
  const mains = o.items.filter((m) => m.main);
  const rest = o.items.filter((m) => !m.main);
  if (mains.length && rest.length) menu.append(el("div", "grp", "Main"));
  for (const m of mains) add(menu, m.label, m.explain, m.key);
  if (rest.length) {
    if (mains.length) menu.append(el("div", "grp", "More"));
    const compact = el("div", "compact");
    for (const m of rest) add(compact, m.label, m.explain, m.key);
    menu.append(compact);
  }
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
  buildMenu($("ddMain"), {
    current: main, title: def.label, hint: def.explain, items: METRICS,
    onPick: (k) => { if (!k) return; main = k; if (overlay === k) overlay = null; render(true); },
  });
  const ov = overlay ? byKey(overlay) : null;
  const dd = $("ddOver");
  buildMenu(dd, {
    current: overlay,
    title: ov ? `+ ${ov.label}` : "+ overlay",
    hint: ov ? "shown in gold on top" : "highlight a second thing in gold",
    items: METRICS.filter((m) => m.overlay && m.key !== main),
    none: "None",
    onPick: (k) => { overlay = k; render(true); },
  });
  dd.toggleAttribute("data-on", !!overlay);
}

/* ---------- stats ---------- */

function renderFacts(s: Stats): void {
  const facts: Array<[string, string, boolean?]> = [
    [`${n(s.totalPrompts)} prompts`, `${s.activeDays} of ${s.spanDays} days`],
    [s.archetype, `${s.medianLeashMin.toFixed(1)} min between prompts`],
    [`${s.longestStreak} days`, "longest streak"],
    [n(s.godPrompts), "God prompts", true],
    [`${s.longestUnattendedH} h`, "longest unattended run"],
  ];
  $("facts").replaceChildren(...facts.map(([v, l, gold]) => {
    const d = el("div", `fact${gold ? " g" : ""}`);
    d.append(el("b", undefined, v), el("span", undefined, l));
    return d;
  }));
  const from = $("from");
  from.classList.toggle("hidden", s.machines.length < 2);
  if (s.machines.length >= 2) from.textContent = `From ${s.machines.length} machines — ${s.machines.join(", ")}`;
}

function renderByMonth(m: Metrics): void {
  const def = byKey(main);
  const by = new Map<string, number[]>();
  m.days.forEach((d, i) => (by.get(d.slice(0, 7)) ?? by.set(d.slice(0, 7), []).get(d.slice(0, 7))!).push(m.series[main][i]));
  const points = [...by].map(([month, vals]) => {
    const nz = vals.filter((v) => v > 0).sort((a, b) => a - b);
    return [month, def.median ? (nz.length ? nz[nz.length >> 1] : 0) : vals.reduce((a, b) => a + b, 0)] as const;
  });
  const max = Math.max(1, ...points.map(([, v]) => v));
  $("trendH").textContent = `${def.label} by month`;
  $("trendSub").textContent = `${def.median ? "Median" : "Total"} per month. ${trend(points.map(([, v]) => v))}`;
  $("bars").replaceChildren(...points.map(([month, v], i) => {
    const b = el("div", `bar${i === points.length - 1 ? " last" : ""}`);
    const bar = el("i");
    bar.style.height = `${Math.max(3, Math.round((v / max) * 64))}px`;
    b.title = `${MONTHS[+month.slice(5, 7) - 1]} ${month.slice(0, 4)} — ${fmt(v, def)}`;
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
  const group = (title: string, rows: Array<[string, string]>, note?: string) => {
    const g = el("div", "group");
    g.append(el("h3", undefined, title));
    for (const [v, l] of rows) {
      const r = el("div", "r");
      r.append(el("b", undefined, v), el("span", undefined, l));
      g.append(r);
    }
    if (note) g.append(el("div", "note", note));
    return g;
  };
  const groups = [
    group("Writing", [
      [n(s.words), "words written"], [`${s.medianWords}`, "median words per prompt"], [n(s.maxWords), "words in your longest"],
      [`${(s.nudgeRatio * 100).toFixed(1)}%`, "were nudges"], [n(s.specShaped), "spec-shaped prompts"], [n(s.slashCommands), "slash commands"],
    ]),
    group("Delegating", [
      [`${n(s.autonomyHours)} h`, "unattended, in total"], [n(s.overnightHandoffs), "overnight handoffs"], [n(s.afterMidnight), "prompts after midnight"],
      [`${s.medianDaySpanHours} h`, "median day, first to last"], [n(s.please), 'times you said "please"'], [n(s.thanks), 'times you said "thanks"'],
    ]),
  ];
  if (s.tokens) {
    const M = (x: number) => (x >= 1e9 ? `${(x / 1e9).toFixed(1)}B` : `${(x / 1e6).toFixed(1)}M`);
    groups.push(group("Last 30 days", [
      [M(s.tokens.total), "tokens, all in"], [M(s.tokens.output), "tokens written back"], [n(s.tokens.toolCalls), "tool calls"], [n(s.tokens.subagents), "subagents spawned"],
    ], "From session transcripts, which Claude Code prunes — so only a recent window survives."));
  }
  $("groups").replaceChildren(...groups);
  $("moreHint").textContent = s.tokens ? "writing, delegating, tokens" : "writing, delegating";
}

/* ---------- machines ---------- */

function renderMachines(): void {
  const chips = $("chips");
  const items: HTMLElement[] = snaps.map((s) => {
    const chip = el("button", "chip") as HTMLButtonElement;
    chip.toggleAttribute("data-on", s.on);
    chip.title = s.on ? "Click to leave this machine out" : "Click to include this machine";
    chip.append(el("i"), el("span", undefined, s.machine),
      el("span", "meta", `${new Date(s.savedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${n(s.stats.totalPrompts)}`));
    const rm = el("span", "rm", "×");
    rm.title = "Forget this machine";
    rm.setAttribute("role", "button");
    rm.onclick = (e) => {
      e.stopPropagation();
      snaps = snaps.filter((x) => x.id !== s.id);
      save(snaps);
      renderMachines();
      rebuild();
    };
    chip.append(rm);
    chip.onclick = () => { s.on = !s.on; save(snaps); renderMachines(); rebuild(); };
    return chip;
  });
  const add = el("button", "chip add", snaps.length ? "+ add a machine" : "+ add your first machine");
  add.onclick = () => $("addpanel").classList.toggle("hidden");
  items.push(add);
  chips.replaceChildren(...items);
}

function rebuild(): void {
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
  const m = metrics!;
  const s = m.stats;
  const W = 1200, H = 630;
  ctx.save();
  ctx.scale(2, 2);
  ctx.fillStyle = CSS("--bg");
  ctx.fillRect(0, 0, W, H);
  const sans = `-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif`;
  const mono = CSS("--mono");
  const def = byKey(main);

  ctx.fillStyle = CSS("--ink");
  ctx.font = `700 36px ${sans}`;
  ctx.fillText(def.label, 60, 74);
  let x = 60 + ctx.measureText(def.label).width + 14;
  if (overlay) {
    ctx.fillStyle = CSS("--gold");
    ctx.font = `600 22px ${sans}`;
    ctx.fillText(`+ ${byKey(overlay).label}`, x, 74);
  }
  ctx.fillStyle = CSS("--mute");
  ctx.font = `400 17px ${sans}`;
  ctx.fillText(def.explain, 60, 102);

  ctx.textAlign = "right";
  ctx.fillStyle = CSS("--ink");
  ctx.font = `500 19px ${mono}`;
  ctx.fillText("npx promptstreak", W - 60, 72);
  ctx.fillStyle = CSS("--faint");
  ctx.font = `400 14px ${sans}`;
  ctx.fillText("to get yours", W - 60, 96);
  ctx.textAlign = "left";

  const values = m.series[main];
  const level = levels(values);
  const over = overlay ? m.series[overlay] : null;
  const cols = columns(m.days);
  const at = new Map(m.days.map((d, i) => [d, i]));
  const gap = 4;
  const cell = Math.floor((W - 120 - (cols.length - 1) * gap) / cols.length);
  const x0 = 60, y0 = 166;
  let lastMonth = -1;
  cols.forEach((col, ci) => {
    const cx = x0 + ci * (cell + gap);
    const first = col.find((d): d is string => d !== null);
    const date = first ? new Date(`${first}T12:00:00`) : null;
    if (date && date.getMonth() % 2 === 1) {
      ctx.fillStyle = "rgba(255,255,255,.04)";
      ctx.fillRect(cx - gap / 2, y0 - 5, cell + gap, 7 * (cell + gap) + 6);
    }
    if (date && date.getMonth() !== lastMonth) {
      lastMonth = date.getMonth();
      if (ci > 0) { ctx.fillStyle = CSS("--line2"); ctx.fillRect(cx - gap / 2 - 0.5, y0 - 6, 1, 7 * (cell + gap) + 8); }
      ctx.fillStyle = CSS("--mute");
      ctx.font = `400 13px ${sans}`;
      ctx.fillText(MONTHS[date.getMonth()], cx, y0 - 14);
    }
    col.forEach((day, ri) => {
      if (!day) return;
      const i = at.get(day)!;
      const ov = over?.[i] ?? 0;
      ctx.fillStyle = ov > 0 ? (ov > 2 ? CSS("--gold") : CSS("--gold2"))
        : [CSS("--empty"), CSS("--g1"), CSS("--g2"), CSS("--g3"), CSS("--g4")][level(values[i] ?? 0)];
      ctx.beginPath();
      ctx.roundRect(cx, y0 + ri * (cell + gap), cell, cell, 2);
      ctx.fill();
    });
  });

  const fy = y0 + 7 * (cell + gap) + 70;
  ctx.strokeStyle = CSS("--line");
  ctx.beginPath(); ctx.moveTo(60, fy - 46); ctx.lineTo(W - 60, fy - 46); ctx.stroke();
  const facts: Array<[string, string, boolean]> = [
    [`${n(s.totalPrompts)} prompts`, `${s.activeDays} of ${s.spanDays} days`, false],
    [s.archetype, `${s.medianLeashMin.toFixed(1)} min between prompts`, false],
    [`${s.longestStreak} days`, "longest streak", false],
    [n(s.godPrompts), "God prompts", true],
    [`${s.longestUnattendedH} h`, "longest unattended run", false],
  ];
  facts.forEach(([v, l, gold], i) => {
    const fx = 60 + i * ((W - 120) / facts.length);
    ctx.fillStyle = gold ? CSS("--gold") : CSS("--ink");
    ctx.font = `600 25px ${mono}`;
    ctx.fillText(v, fx, fy);
    ctx.fillStyle = CSS("--mute");
    ctx.font = `400 14px ${sans}`;
    ctx.fillText(l, fx, fy + 24);
  });
  ctx.fillStyle = CSS("--faint");
  ctx.font = `400 14px ${sans}`;
  const from = s.machines.length >= 2 ? `   ·   From ${s.machines.length} machines` : "";
  ctx.fillText(`${m.from} → ${m.to}${from}`, 60, H - 36);
  ctx.restore();
  return canvas;
}

/* ---------- render ---------- */

function render(animate = false): void {
  if (!metrics) return;
  stopSnake();
  delete $("card").dataset.empty;
  $("picks").classList.remove("hidden");
  $("icons").classList.remove("hidden");
  $("bymonth").classList.remove("hidden");
  $("more").classList.remove("hidden");
  renderPickers();
  renderCalendar(metrics, animate);
  renderFacts(metrics.stats);
  renderByMonth(metrics);
  renderMore(metrics.stats);
  void encode(metrics, metrics.stats.machines[0]).then((p) => history.replaceState(null, "", `${location.pathname}#${p}`));
}

function renderEmpty(): void {
  $("card").dataset.empty = "1";
  $("picks").classList.add("hidden");
  $("icons").classList.add("hidden");
  $("bymonth").classList.add("hidden");
  $("more").classList.add("hidden");
  $("from").classList.add("hidden");
  $("wd").replaceChildren();
  $("months").replaceChildren();
  startSnake($("cols"), $("facts"), cellSize(52));
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
    snaps = upsert(await decode(hash));
  } catch (err) {
    console.error("Could not read that link:", err);
    toast("That link could not be read");
  }
}

let toastTimer = 0;
function toast(msg: string): void {
  const t = $("toast");
  t.textContent = msg;
  t.dataset.show = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => delete t.dataset.show, 1600) as unknown as number;
}

const copy = (text: string, msg: string) => void navigator.clipboard.writeText(text).then(() => toast(msg));

async function boot(): Promise<void> {
  wireTooltip();
  document.addEventListener("click", closeMenus);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenus());
  $("domain").textContent = location.host || "promptstreak";
  $("cta").onclick = () => copy("npx promptstreak", "Copied — paste it in a terminal");
  $("copyCmd").onclick = () => copy("npx promptstreak", "Copied");
  $("link").onclick = () => copy(location.href, "Share link copied");
  $("png").onclick = () => drawCard().toBlob((b) => {
    if (!b) return;
    const url = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = url;
    a.download = `promptstreak-${main}${overlay ? `+${overlay}` : ""}.png`;
    a.click();
    URL.revokeObjectURL(url);
    toast("PNG saved");
  }, "image/png");

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
