#!/usr/bin/env node
import { spawn } from "node:child_process";
import { historyFiles, projectRoots } from "./paths.js";
import { findJsonl, merge, parseHistory, parsePath, parseTranscript } from "./parse.js";
import { computeMetrics } from "./metrics.js";
import { encode } from "./codec.js";
import { METRIC_LABELS, renderGrid, renderLegend, renderStats } from "./render.js";
import type { MetricKey, PromptEvent } from "./types.js";

const WEB_URL = process.env.PROMPTSTREAK_URL ?? "https://promptstreak.nikitaeverywhere.workers.dev";

const HELP = `
promptstreak — your Claude Code prompting habits as a contribution graph

  npx promptstreak                       find your history, print the graph, open the page
  npx promptstreak <file|dir> [...]      merge extra sources (another machine, a backup)
  npx promptstreak --metric leash        pick which metric fills the grid
  npx promptstreak --print-url           print the share URL instead of opening it
  npx promptstreak --no-open             just the terminal output
  npx promptstreak --json                raw metrics as JSON
  npx promptstreak --local               skip transcripts, use history.jsonl only

Metrics: ${Object.keys(METRIC_LABELS).join(", ")}

Everything runs on your machine. Prompt text never leaves it — the share link
carries only daily counts, and it rides in the URL fragment, so even the page
host never receives it.

Another machine?
  ssh box 'cat ~/.claude/history.jsonl' > box.jsonl && npx promptstreak box.jsonl
`;

function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref();
  } catch {
    console.log(`\nOpen this yourself:\n${url}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const flag = (name: string) => argv.includes(name);
  const value = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const extra = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--metric");

  const metric = (value("--metric") ?? "prompts") as MetricKey;
  if (!(metric in METRIC_LABELS)) {
    console.error(`Unknown metric "${metric}". Try one of: ${Object.keys(METRIC_LABELS).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const sources: PromptEvent[][] = [];
  const history = historyFiles();
  for (const f of history) sources.push(parseHistory(f));
  if (!flag("--local")) {
    for (const root of projectRoots()) for (const f of findJsonl(root)) sources.push(parseTranscript(f));
  }
  for (const p of extra) {
    const events = parsePath(p);
    if (!events.length) console.error(`Nothing readable in ${p}`);
    sources.push(events);
  }

  const events = merge(...sources);
  if (!events.length) {
    console.error(
      history.length
        ? "Found your Claude Code config, but no prompts in it yet."
        : "No Claude Code history found. Looked in $CLAUDE_CONFIG_DIR and ~/.claude.",
    );
    process.exitCode = 1;
    return;
  }

  const metrics = computeMetrics(events);

  if (flag("--json")) {
    console.log(JSON.stringify(metrics, null, 2));
    return;
  }

  console.log(`\n${renderStats(metrics)}\n`);
  console.log(renderGrid(metrics, metric));
  console.log(`\n${renderLegend(metric)}\n`);

  const url = `${WEB_URL}/#${await encode(metrics)}`;
  if (flag("--print-url")) {
    console.log(url);
    return;
  }
  if (flag("--no-open")) return;

  console.log("Opening the shareable version…\n");
  openUrl(url);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
