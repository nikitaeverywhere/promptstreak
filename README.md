# promptstreak

[![npm](https://img.shields.io/npm/v/promptstreak?color=40c463&label=npm)](https://www.npmjs.com/package/promptstreak)
[![CI](https://github.com/nikitaeverywhere/promptstreak/actions/workflows/ci.yaml/badge.svg)](https://github.com/nikitaeverywhere/promptstreak/actions/workflows/ci.yaml)

Your Claude Code prompting habits as a GitHub-style contribution graph.

**Demo: [promptstreak.pages.dev](https://promptstreak.pages.dev) · get yours: `npx promptstreak`**

[![A year of prompting, as a contribution graph](https://raw.githubusercontent.com/nikitaeverywhere/promptstreak/main/docs/promptstreak.png)](https://promptstreak.pages.dev)

A commit graph stopped meaning anything the moment agents started committing daily. This one
counts the part you actually did: **the prompts you wrote.** Ten metrics, one year, one
screenshot.

```bash
npx promptstreak
```

Reads your local Claude Code history, prints the graph in your terminal, and opens a shareable
version at [promptstreak.pages.dev](https://promptstreak.pages.dev). **Nothing is uploaded** — not by the CLI, and not by the page.

## What it measures

The grid switches between fifteen metrics. Four of them are the interesting ones:

| Metric | What it says about you |
|---|---|
| **God prompts** | Prompts of 5,000+ characters — a spec, not a message. These get gold cells. |
| **Leash** | Median minutes between your prompts — short is steering, long is delegating. Watch it by month: if it is rising, you are handing over more. |
| **Autonomy** | Hours the agent worked while you were away. |
| **Nudges** | How much of your year was `yes`, `continue`, `try again`. |

Plus prompt length, spec-shaped prompts, overnight handoffs, prompts at night, politeness, the plain
prompt count, and a mood family — swearing, annoyed, caps lock, thanks, emoji — that also works as
an overlay on any of the others.

## Usage

```bash
npx promptstreak                          # graph + stats, opens the shareable page
npx promptstreak --metric leash           # pick the metric that fills the grid
npx promptstreak --print-url              # print the share link instead of opening it
npx promptstreak --no-open                # terminal only
npx promptstreak --json                   # raw metrics, for scripting
npx promptstreak --local                  # history.jsonl only, skip transcripts
npx promptstreak --no-quotes              # keep "Things you said" out of the link
npx promptstreak --curate                 # let your local `claude` pick the quotes
```

### More than one machine

Prompts on a server or a second laptop live in that machine's history. Merge them:

```bash
ssh box 'cat ~/.claude/history.jsonl' > box.jsonl
npx promptstreak box.jsonl
```

Any number of files or directories can be passed, and duplicates are dropped. The web page takes
dropped files the same way.

### Things you said

The run ends with up to ten of your own lines — the swearing, the caps lock, the apologies — and
they travel with the link so the page can show them. They are redacted first (links, paths, emails
and anything token-shaped are stripped) and printed in the terminal before the browser opens, so
you see exactly what ships. `--no-quotes` keeps them home. `--curate` hands the top candidates to
your local `claude` CLI to pick the funniest, and uses the built-in ranking if that fails.

On the page, select any words in a quote to blank them out, or remove a quote you would rather not
show; the link in the address bar updates as you go, so what you share is what you see. Only your
browser keeps the originals, so only there can they be undone or restored.

## Where the numbers come from

Two files, with very different reach:

- **`~/.claude/history.jsonl`** — every prompt you submitted, going back roughly a year. This is
  what fills the grid.
- **`~/.claude/projects/**/*.jsonl`** — full session transcripts, but Claude Code prunes these
  after `cleanupPeriodDays` (about a month by default). Used to catch headless sessions the
  history file misses.

If you want a fuller picture next year, raise `cleanupPeriodDays` in your Claude Code settings
now. Nothing can recover transcripts that have already been pruned.

`$CLAUDE_CONFIG_DIR` and `$XDG_CONFIG_HOME` are both honoured, and every directory that exists is
merged rather than the first one winning.

## Privacy

Nothing you typed leaves your machine unless you let it. The one thing that can is the quotes,
and you see them before they go.

- **`npx promptstreak`** reads `~/.claude/history.jsonl` and the session transcripts on disk,
  counts them locally, and prints the result. Its only network action is opening a browser tab;
  it sends no telemetry and calls no API.
- **The link it opens** carries view data, never the source — per-day counts, headline numbers
  and, unless you pass `--no-quotes`, the redacted quotes printed in the terminal — compressed
  into the URL **fragment**, which browsers never send to a server. File paths and project names
  are not in it.
- **The page** is static: no backend, no upload endpoint. Dropped files are parsed in the
  browser and stay there. Saved machines live in your browser's local storage. Google Analytics
  counts visits; it is configured to receive the page address without the fragment, so the share
  data never reaches it.

Read the source if you want to check: `src/parse-core.ts` is the whole of what is extracted, and
`src/mood.ts` is everything that touches prompt text.

## Development

```bash
npm install
npm test          # fixture-based; every metric is asserted against hand-computed values
npm run build     # CLI to lib/, browser bundle to web/app.js
npm run dev       # run the CLI from source
npm run web:dev   # serve the page locally
```

Tests run under `TZ=UTC` because every metric buckets by *local* calendar day — a night owl's
day must not split at midnight UTC.

## Licence

[MIT](./LICENSE) © [Nikita Savchenko](https://nikitaeverywhere.com)
