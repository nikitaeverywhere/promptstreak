import { decode, encode } from "./codec.js";
import { computeMetrics } from "./metrics.js";
import { merge, parseUnknownText } from "./parse-core.js";
import type { MetricKey, Metrics, PromptEvent, Stats } from "./types.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const n = (v: number) => v.toLocaleString("en-US");

/** Each toggle needs its own sentence — ten metrics is a lot to hold in your head. */
const METRICS: Array<{ key: MetricKey; label: string; explain: string; unit?: string }> = [
  { key: "prompts", label: "Prompts", explain: "Every prompt you submitted, by day. The baseline everyone recognises." },
  { key: "godPrompts", label: "God prompts", explain: "Prompts of 5,000+ characters — a spec, not a message. Gold days are the ones you handed over something big.", unit: "" },
  { key: "leash", label: "Leash", explain: "Median minutes between your prompts that day. Short means you were steering; long means the agent was running.", unit: "min" },
  { key: "medianLength", label: "Prompt length", explain: "Median characters per prompt that day. Dark days are one-liners, bright days are essays.", unit: "chars" },
  { key: "nudges", label: "Nudges", explain: '"yes", "continue", "try again" — 25 characters or fewer. The other half of how anyone actually works.' },
  { key: "specShaped", label: "Spec-shaped", explain: "Prompts containing bullet or numbered lists — you wrote a spec instead of a sentence." },
  { key: "autonomy", label: "Autonomy", explain: "Hours the agent worked while you were away — gaps of 15 minutes or more inside a session.", unit: "h" },
  { key: "overnight", label: "Overnight", explain: "You handed work over late and came back the next day to review it." },
  { key: "nightOwl", label: "Night owl", explain: "Prompts sent between 22:00 and 05:00." },
  { key: "politeness", label: "Politeness", explain: 'Prompts where you said "please" to a language model.' },
];

interface Source {
  name: string;
  count: number;
  events: PromptEvent[];
}

const sources: Source[] = [];
let metrics: Metrics | null = null;
let active: MetricKey = "prompts";

/* ---------- scales ---------- */

function levels(values: number[]): (v: number) => 0 | 1 | 2 | 3 | 4 {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(nz.length * p))];
  const [a, b, c] = [q(0.25), q(0.5), q(0.75)];
  return (v) => (v <= 0 ? 0 : v <= a ? 1 : v <= b ? 2 : v <= c ? 3 : 4);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Sunday-first columns with a leading pad, exactly like GitHub. */
function columns(days: string[]): (string | null)[][] {
  const pad = new Date(`${days[0]}T12:00:00`).getDay();
  const cells: (string | null)[] = [...new Array(pad).fill(null), ...days];
  const out: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
  while (out[out.length - 1].length < 7) out[out.length - 1].push(null);
  return out;
}

/* ---------- rendering ---------- */

function renderGrid(m: Metrics): void {
  const values = m.series[active];
  const at = new Map(m.days.map((d, i) => [d, values[i]]));
  const level = levels(values);
  const gold = active === "godPrompts";
  const cols = columns(m.days);
  const meta = METRICS.find((x) => x.key === active)!;

  const grid = $("grid");
  const months = $("months");
  grid.replaceChildren();
  months.replaceChildren();

  let lastMonth = -1;
  for (const col of cols) {
    const first = col.find((d): d is string => d !== null);
    const label = document.createElement("span");
    if (first) {
      const d = new Date(`${first}T12:00:00`);
      if (d.getMonth() !== lastMonth && d.getDate() <= 7) {
        label.textContent = MONTHS[d.getMonth()];
        lastMonth = d.getMonth();
      }
    }
    months.append(label);

    for (const day of col) {
      const cell = document.createElement("div");
      cell.className = "cell";
      if (!day) {
        cell.dataset.none = "1";
      } else {
        const v = at.get(day) ?? 0;
        if (gold) {
          if (v > 0) cell.dataset.gold = v > 2 ? "2" : "1";
        } else {
          cell.dataset.l = String(level(v));
        }
        const unit = meta.unit ? ` ${meta.unit}` : "";
        cell.title = `${day} — ${v === 0 ? "nothing" : `${n(v)}${unit}`}`;
      }
      grid.append(cell);
    }
  }
}

function renderFacts(s: Stats): void {
  const facts: Array<{ v: string; l: string; gold?: boolean }> = [
    { v: `${s.longestStreak}`, l: "day longest streak" },
    { v: n(s.godPrompts), l: "god prompts", gold: true },
    { v: n(s.autonomyHours), l: "hours agent ran alone" },
    { v: n(s.words), l: "words written" },
    { v: `${s.medianLength}`, l: "median prompt (chars)" },
    { v: n(s.overnightHandoffs), l: "overnight handoffs" },
  ];
  $("facts").replaceChildren(
    ...facts.map((f) => {
      const el = document.createElement("div");
      el.className = `fact${f.gold ? " g" : ""}`;
      el.innerHTML = `<b></b><span></span>`;
      el.querySelector("b")!.textContent = f.v;
      el.querySelector("span")!.textContent = f.l;
      return el;
    }),
  );
}

function renderTrend(s: Stats): void {
  const entries = Object.entries(s.leashByMonth);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  $("trend").replaceChildren(
    ...entries.map(([month, v], i) => {
      const bar = document.createElement("i");
      bar.style.height = `${Math.max(2, (v / max) * 34)}px`;
      if (i === entries.length - 1) bar.className = "last";
      bar.title = `${month} — ${v} min`;
      return bar;
    }),
  );
  if (entries.length > 1) {
    const dir = entries[entries.length - 1][1] - entries[0][1];
    $("trendSub").textContent =
      dir > 0
        ? `Median minutes between prompts, by month — rising, so you are handing over more and steering less.`
        : `Median minutes between prompts, by month — falling, so you are steering more closely than you were.`;
  }
}

function render(): void {
  if (!metrics) return;
  const s = metrics.stats;
  $("empty").classList.add("hidden");
  $("app").classList.remove("hidden");

  $("arch").firstChild!.textContent = s.archetype;
  $("archSub").textContent = `median ${s.medianLeashMin} min between prompts`;
  $("total").textContent = n(s.totalPrompts);
  $("totalSub").textContent = `prompts · ${s.activeDays} of ${s.spanDays} days`;
  $("explain").textContent = METRICS.find((x) => x.key === active)!.explain;

  renderGrid(metrics);
  renderFacts(s);
  renderTrend(s);
}

function renderToggles(): void {
  $("toggles").replaceChildren(
    ...METRICS.map((m) => {
      const b = document.createElement("button");
      b.textContent = m.label;
      b.setAttribute("aria-pressed", String(m.key === active));
      b.onclick = () => {
        active = m.key;
        renderToggles();
        render();
      };
      return b;
    }),
  );
}

/* ---------- share card ---------- */

const CSS = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function drawCard(): HTMLCanvasElement {
  const canvas = $<HTMLCanvasElement>("canvas");
  const ctx = canvas.getContext("2d")!;
  const m = metrics!;
  const s = m.stats;
  const S = 2; // draw at 2x, export at 2400x1260
  ctx.save();
  ctx.scale(S, S);
  const W = 1200;
  const H = 630;

  ctx.fillStyle = CSS("--bg");
  ctx.fillRect(0, 0, W, H);

  const mono = `600 ${1}px ${CSS("--mono")}`;
  const sans = `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif`;

  ctx.fillStyle = CSS("--ink");
  ctx.font = `700 42px ${sans}`;
  ctx.fillText(s.archetype, 64, 92);

  ctx.fillStyle = CSS("--mute");
  ctx.font = `400 20px ${sans}`;
  ctx.fillText(`median ${s.medianLeashMin} min between prompts`, 64, 124);

  ctx.textAlign = "right";
  ctx.fillStyle = CSS("--ink");
  ctx.font = mono.replace("1px", "42px");
  ctx.fillText(n(s.totalPrompts), W - 64, 92);
  ctx.fillStyle = CSS("--mute");
  ctx.font = `400 20px ${sans}`;
  ctx.fillText(`prompts · ${s.activeDays} of ${s.spanDays} days`, W - 64, 124);
  ctx.textAlign = "left";

  // grid
  const values = m.series[active];
  const at = new Map(m.days.map((d, i) => [d, values[i]]));
  const level = levels(values);
  const gold = active === "godPrompts";
  const cols = columns(m.days);
  const cell = 16;
  const gap = 4;
  const gw = cols.length * (cell + gap);
  const x0 = Math.round((W - gw) / 2);
  const y0 = 190;

  cols.forEach((col, ci) => {
    col.forEach((day, ri) => {
      if (!day) return;
      const v = at.get(day) ?? 0;
      ctx.fillStyle = gold
        ? v > 2
          ? CSS("--gold")
          : v > 0
            ? CSS("--gold-dim")
            : CSS("--empty")
        : [CSS("--empty"), CSS("--g1"), CSS("--g2"), CSS("--g3"), CSS("--g4")][level(v)];
      const x = x0 + ci * (cell + gap);
      const y = y0 + ri * (cell + gap);
      ctx.beginPath();
      ctx.roundRect(x, y, cell, cell, 3);
      ctx.fill();
    });
  });

  ctx.fillStyle = CSS("--faint");
  ctx.font = `400 17px ${sans}`;
  ctx.fillText(METRICS.find((x) => x.key === active)!.label, x0, y0 - 16);

  // facts
  const facts: Array<[string, string, boolean]> = [
    [`${s.longestStreak}`, "day streak", false],
    [n(s.godPrompts), "god prompts", true],
    [n(s.autonomyHours), "h agent alone", false],
    [n(s.words), "words written", false],
  ];
  const fy = y0 + 7 * (cell + gap) + 74;
  ctx.strokeStyle = CSS("--line");
  ctx.beginPath();
  ctx.moveTo(64, fy - 46);
  ctx.lineTo(W - 64, fy - 46);
  ctx.stroke();

  facts.forEach(([v, l, isGold], i) => {
    const x = 64 + i * ((W - 128) / facts.length);
    ctx.fillStyle = isGold ? CSS("--gold") : CSS("--ink");
    ctx.font = mono.replace("1px", "34px");
    ctx.fillText(v, x, fy);
    ctx.fillStyle = CSS("--mute");
    ctx.font = `400 16px ${sans}`;
    ctx.fillText(l, x, fy + 26);
  });

  ctx.fillStyle = CSS("--faint");
  ctx.font = `400 16px ${sans}`;
  ctx.fillText(`${m.from} → ${m.to}`, 64, H - 40);
  ctx.textAlign = "right";
  ctx.fillStyle = CSS("--mute");
  ctx.fillText("promptstreak — npx promptstreak", W - 64, H - 40);
  ctx.textAlign = "left";

  ctx.restore();
  return canvas;
}

/* ---------- data in ---------- */

function recompute(): void {
  const events = merge(...sources.map((s) => s.events));
  metrics = events.length ? computeMetrics(events) : null;
  renderFiles();
  if (metrics) {
    render();
    history.replaceState(null, "", location.pathname);
    void encode(metrics).then((p) => {
      history.replaceState(null, "", `${location.pathname}#${p}`);
    });
  }
}

function renderFiles(): void {
  $("files").replaceChildren(
    ...sources.map((s, i) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = s.name;
      const count = document.createElement("span");
      count.className = "n";
      count.textContent = `${n(s.count)} prompts`;
      const rm = document.createElement("button");
      rm.textContent = "×";
      rm.title = "Remove";
      rm.onclick = () => {
        sources.splice(i, 1);
        recompute();
      };
      li.append(name, count, rm);
      return li;
    }),
  );
}

async function addFiles(list: FileList | File[]): Promise<void> {
  for (const file of Array.from(list)) {
    const events = parseUnknownText(await file.text());
    sources.push({ name: file.name, count: events.length, events });
  }
  recompute();
}

/* ---------- wiring ---------- */

function copy(text: string, button: HTMLElement, done = "Copied"): void {
  const original = button.textContent;
  void navigator.clipboard.writeText(text).then(() => {
    button.textContent = done;
    setTimeout(() => (button.textContent = original), 1400);
  });
}

async function boot(): Promise<void> {
  renderToggles();

  $("copy").onclick = (e) => copy("npx promptstreak", e.currentTarget as HTMLElement);
  $("link").onclick = (e) => copy(location.href, e.currentTarget as HTMLElement, "Link copied");
  $("png").onclick = () => {
    drawCard().toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `promptstreak-${active}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  };

  const drop = $("drop");
  const picker = $<HTMLInputElement>("picker");
  drop.onclick = () => picker.click();
  picker.onchange = () => picker.files && void addFiles(picker.files);
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add("over");
  };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    if (e.dataTransfer?.files) void addFiles(e.dataTransfer.files);
  };

  const hash = location.hash.slice(1);
  if (!hash) return;
  try {
    const payload = await decode(hash);
    metrics = { from: payload.from, to: payload.to, days: [], series: payload.series, stats: payload.stats };
    // Days are derivable, so they never ride in the URL.
    const days: string[] = [];
    const d = new Date(`${payload.from}T12:00:00`);
    const end = new Date(`${payload.to}T12:00:00`);
    while (d <= end) {
      days.push(d.toLocaleDateString("en-CA"));
      d.setDate(d.getDate() + 1);
    }
    metrics.days = days;
    render();
  } catch (err) {
    console.error("Could not read that link:", err);
  }
}

void boot();
