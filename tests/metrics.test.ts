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

test("leash is the median in-session gap, and sets the archetype", () => {
  // Gaps inside one session: 2, 3 and 55 minutes. The 9h overnight gap breaks
  // the session, so it is not a leash measurement.
  assert.equal(s.medianLeashMin, 3);
  assert.equal(s.archetype, "Collaborator");
});

test("archetype thresholds", () => {
  assert.equal(archetypeOf(2.9), "Babysitter");
  assert.equal(archetypeOf(3), "Collaborator");
  assert.equal(archetypeOf(14.9), "Collaborator");
  assert.equal(archetypeOf(15), "Orchestrator");
});

test("autonomy counts only gaps of 15 minutes or more", () => {
  assert.deepEqual(m.series.autonomy, [0.9, 0, 0, 0]); // the 55-minute gap
  assert.equal(s.autonomyHours, 1);
});

test("overnight handoff is credited to the evening you left", () => {
  assert.equal(s.overnightHandoffs, 1);
  assert.equal(s.overnightHours, 9);
  assert.deepEqual(m.series.overnight, [0, 0, 1, 0]);
});

test("nudges, spec shape, night owl and politeness", () => {
  assert.equal(s.nudges, 4);
  assert.equal(s.nudgeRatio, 0.8);
  assert.equal(s.specShaped, 1);
  assert.deepEqual(m.series.nightOwl, [0, 0, 1, 0]);
  assert.equal(s.please, 1);
  assert.equal(s.thanks, 1);
  assert.equal(s.sorry, 0);
});

test("text stats", () => {
  assert.equal(s.medianLength, 7);
  assert.equal(s.words, 10);
  assert.equal(s.chars, 5032);
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
