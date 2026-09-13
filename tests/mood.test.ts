import assert from "node:assert/strict";
import { test } from "node:test";
import { asCandidate, moodScores, pickQuotes, redact } from "../src/mood.js";

// Every expected value is hand-derived from the patterns in src/mood.ts.

test("swearing and annoyance are separate signals", () => {
  const s = moodScores("fuck this, it broke again");
  assert.equal(s.swearing, 1);
  // "again" alone is a weak marker; one weak marker is a bug report, not a mood.
  assert.equal(s.annoyed, 0);
});

test("a bare bug report is not annoyance", () => {
  assert.equal(moodScores("doesn't work").annoyed, 0);
});

test("strong markers plus weak ones stack", () => {
  // "i told you" + "??" are strong (2), "still broken" is weak (0.5).
  assert.equal(moodScores("still broken?? I told you twice").annoyed, 2.5);
});

test("caps lock ignores acronyms", () => {
  assert.equal(moodScores("Can you fix the JSON parser and update the README").caps, 0);
  const s = moodScores("WHY DID YOU DELETE THE TESTS!!!");
  assert.equal(s.caps, 2); // DELETE, TESTS
  assert.equal(s.annoyed, 2); // "why did you" + "!!!"
});

test("thanks, sorry, banter, ultrathink, go-ahead", () => {
  assert.equal(moodScores("thanks, looks great 🙏").thanks, 2);
  const s = moodScores("sorry, my bad — go ahead and use your judgment");
  assert.equal(s.sorry, 2);
  assert.equal(s.goAhead, 2);
  assert.equal(moodScores("ultrathink about this").ultrathink, 1);
  const b = moodScores("haha nice one bro");
  assert.equal(b.banter, 2);
  assert.equal(b.thanks, 1);
});

test("redact strips links, paths, emails, tokens and attachments", () => {
  assert.equal(
    redact("see https://example.com/x and /Users/me/proj/a.ts, mail me@x.io"),
    "see ‹link› and ‹path› mail ‹email›",
  );
  assert.equal(redact("[Image #1] deploy it"), "deploy it");
  assert.equal(redact("key abcdefghijklmnopqrstuvwxyz0123 leaked"), "key ‹token› leaked");
});

test("asCandidate drops code, short and neutral prompts", () => {
  assert.equal(asCandidate("```js\nfuck()\n```", 1, "2026-01-01"), null);
  assert.equal(asCandidate("ugh", 1, "2026-01-01"), null);
  assert.equal(asCandidate("please add a unit test for the parser", 1, "2026-01-01"), null);
  const c = asCandidate("WHY DID YOU DELETE THE TESTS!!!", 1, "2026-01-01");
  assert.ok(c);
  assert.equal(c.scores.annoyed, 2);
});

const cand = (text: string, i: number) => asCandidate(text, i, `2026-01-0${i}`)!;

test("pickQuotes caps each category so one mood can't crowd out the rest", () => {
  const qs = pickQuotes(
    [
      cand("fuck this build", 1),
      cand("what the fuck happened here", 2),
      cand("shit, wrong branch again", 3),
      cand("sorry, my mistake", 4),
    ],
    3,
  );
  assert.deepEqual(
    qs.map((q) => q.c),
    ["swearing", "swearing", "sorry"],
  );
});

test("pickQuotes drops repeats and near-repeats", () => {
  const qs = pickQuotes([cand("fuck this", 1), cand("fuck this", 2), cand("fuck this thing", 3)]);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].d, "2026-01-03"); // equal scores: the most recent wins
});

test("spoil blanks a run without spelling out its length", async () => {
  const { spoil } = await import("../src/web-quotes.js");
  const t = "Because you fucking dumb asshole stashed changes";
  const s = spoil(t, 12, 32);
  assert.equal(s, "Because you ███████ stashed changes");
  // Hiding next to an existing run merges into one longer run.
  assert.equal(spoil(s, 8, 12), "Because ██████████ stashed changes");
  // Long or repeated hides never grow past the cap.
  assert.equal(spoil("x".repeat(120), 0, 120), "█".repeat(12));
  assert.equal(spoil("ab", 0, 2), "███");
});
