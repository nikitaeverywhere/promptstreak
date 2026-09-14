import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { computeMetrics, archetypeOf } from "../src/metrics.js";
import { merge, parseHistoryText } from "../src/parse-core.js";
import { decode, encode } from "../src/codec.js";

const fixture = fileURLToPath(new URL("./fixtures/history.sample.jsonl", import.meta.url));
const events = merge(parseHistoryText(readFileSync(fixture, "utf8")));
const m = computeMetrics(events);
const s = m.stats;

// Every expected value below is hand-computed from the fixture. Tests run under
// TZ=UTC because every metric buckets by *local* day.

test("dedupes the repeated history line", () => {
  assert.equal(events.length, 6);
});

test("counts prompts, splitting slash commands out", () => {
  assert.equal(s.totalPrompts, 6);
  assert.equal(s.typedPrompts, 5);
  assert.equal(s.slashCommands, 1);
});

test("spans the calendar, not just active days", () => {
  assert.equal(m.from, "2026-01-01");
  assert.equal(m.to, "2026-01-04");
  assert.equal(s.spanDays, 4);
  assert.equal(s.activeDays, 3);
  assert.deepEqual(m.series.prompts, [4, 0, 1, 1]);
});

test("god prompts use the fixed 5000-char threshold", () => {
  assert.equal(s.godPrompts, 1);
  assert.equal(s.godPromptDays, 1);
  assert.equal(s.maxLength, 5000);
  assert.equal(s.maxLengthDay, "2026-01-01");
  assert.deepEqual(m.series.godPrompts, [1, 0, 0, 0]);
});

test("leash ignores slash commands and breaks at 6h", () => {
  // Typed prompts only: 10:00 -> 10:05 -> 11:00, so gaps of 5 and 55 minutes.
  // `/model` at 10:02 is not a prompt, and the 9h overnight gap is not a leash.
  assert.equal(s.medianLeashMin, 30);
  assert.equal(s.archetype, "Orchestrator");
});

test("the same prompt logged twice is one prompt", () => {
  // history.jsonl stores submit time in ms; the transcript stores ISO seconds.
  // A sub-second difference must not become two prompts a moment apart.
  const twice = merge(
    [{ ts: 1_700_000_000_000, text: "ship it", project: "/p", isSlash: false, pasted: false }],
    [{ ts: 1_700_000_000_400, text: "ship it", project: "/p", isSlash: false, pasted: false }],
  );
  assert.equal(twice.length, 1);
  // The same words typed again much later are genuinely two prompts.
  const later = merge(
    [{ ts: 1_700_000_000_000, text: "ship it", project: "/p", isSlash: false, pasted: false }],
    [{ ts: 1_700_000_300_000, text: "ship it", project: "/p", isSlash: false, pasted: false }],
  );
  assert.equal(later.length, 2);
});

test("without transcripts the agent's side is unknown, not guessed", () => {
  assert.equal(s.longestUnattendedH, 0);
  assert.equal(s.longestUnattendedAt, "");
  assert.deepEqual(m.series.autonomy, [0, 0, 0, 0]);
  assert.equal(m.coverage, undefined);
});

test("archetype thresholds", () => {
  assert.equal(archetypeOf(2.9), "Babysitter");
  assert.equal(archetypeOf(3), "Collaborator");
  assert.equal(archetypeOf(14.9), "Collaborator");
  assert.equal(archetypeOf(15), "Orchestrator");
});

test("autonomy is the agent's run time, per local day, from transcripts", () => {
  const h = 3600_000;
  const t0 = Date.UTC(2026, 0, 2, 22, 0); // 22:00 on the 2nd (tests run in UTC)
  const agent = { runs: [[t0, t0 + 4 * h], [t0 + 1 * h, t0 + 2 * h]] as [number, number][], coverage: { from: "2026-01-02", to: "2026-01-04" } };
  const a = computeMetrics(events, { agent });
  // 22:00–02:00 straddles midnight; the overlapping second run adds nothing.
  assert.deepEqual(a.series.autonomy, [0, 2, 2, 0]);
  assert.equal(a.stats.autonomyHours, 4);
  assert.equal(a.stats.longestUnattendedH, 4);
  assert.equal(a.stats.longestUnattendedAt, "2026-01-02");
  assert.deepEqual(a.coverage, agent.coverage);
});

test("agent runs end when the agent stops or you speak again", async () => {
  const { agentRuns, hoursByDay } = await import("../src/agent.js");
  const m = 60_000;
  const t0 = Date.UTC(2026, 5, 1, 23, 30);
  const runs = agentRuns([
    { ts: t0, human: true },
    { ts: t0 + 10 * m, human: false },
    { ts: t0 + 50 * m, human: false },
    { ts: t0 + 60 * m, human: true }, // cuts the first run
    { ts: t0 + 65 * m, human: false },
    { ts: t0 + 65 * m + 3 * 3600_000, human: false }, // after a 3 h silence: idle, not working
    { ts: t0 + 400 * m, human: true }, // a prompt the agent never answered
  ]);
  assert.deepEqual(runs, [[t0, t0 + 50 * m], [t0 + 60 * m, t0 + 65 * m]]);
  const days = hoursByDay(runs);
  assert.equal(Math.round(days.get("2026-06-01")! * 60), 30);
  assert.equal(Math.round(days.get("2026-06-02")! * 60), 25);
});

test("overnight handoff is credited to the evening you left", () => {
  assert.equal(s.overnightHandoffs, 1);
  assert.equal(s.overnightHours, 9);
  assert.deepEqual(m.series.overnight, [0, 0, 1, 0]);
});

test("nudges, spec shape, at-night and politeness", () => {
  assert.equal(s.nudges, 4);
  assert.equal(s.nudgeRatio, 0.8);
  assert.equal(s.specShaped, 1);
  assert.deepEqual(m.series.nightOwl, [0, 0, 1, 0]);
  assert.equal(s.please, 1);
  assert.equal(s.thanks, 1);
  assert.equal(s.sorry, 0);
});

test("text stats, in words as well as characters", () => {
  assert.equal(s.medianLength, 7);
  assert.equal(s.medianWords, 1);
  assert.equal(s.maxWords, 4);
  assert.equal(s.words, 10);
  assert.equal(s.chars, 5032);
  assert.deepEqual(m.series.promptWords, [1, 0, 3, 1]);
});

test("streaks", () => {
  assert.equal(s.longestStreak, 2);
  assert.equal(s.longestStreakEnd, "2026-01-04");
});

test("codec round-trips every metric and stat", async () => {
  const payload = await encode(m);
  const back = await decode(payload);
  assert.equal(back.v, 1);
  assert.equal(back.from, m.from);
  assert.equal(back.to, m.to);
  assert.deepEqual(back.series, m.series);
  assert.deepEqual(back.stats, m.stats);
});

test("payload stays small enough for a URL", async () => {
  const big = computeMetrics(
    Array.from({ length: 4000 }, (_, i) => ({
      ts: Date.UTC(2025, 8, 1) + i * 2 * 3600_000,
      text: "x".repeat(200),
      project: "/p",
      isSlash: false,
      pasted: false,
    })),
  );
  const payload = await encode(big);
  assert.ok(payload.length < 8000, `payload was ${payload.length} chars`);
});
