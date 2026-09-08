# promptstreak

Your Claude Code prompting habits as a GitHub-style contribution graph.

A commit graph stopped meaning anything the moment agents started committing daily. This one
counts the part you actually did: **the prompts you wrote.** Ten metrics, one year, one
screenshot.

```bash
npx promptstreak
```

Reads your local Claude Code history, prints the graph in your terminal, and opens a shareable
version in the browser. **Nothing is uploaded** — not by the CLI, and not by the page.

## What it measures

The grid switches between ten metrics. Four of them are the interesting ones:

| Metric | What it says about you |
|---|---|
| **God prompts** | Prompts of 5,000+ characters — a spec, not a message. These get gold cells. |
| **Leash** | Median minutes between your prompts. Under 3 you are a **Babysitter**, 3–15 a **Collaborator**, 15+ an **Orchestrator**. |
| **Autonomy** | Hours the agent worked while you were away. |
| **Nudges** | How much of your year was `yes`, `continue`, `try again`. |

Plus prompt length, spec-shaped prompts, overnight handoffs, night-owl hours, politeness, and the
plain prompt count. Your leash by month is the one worth watching — if it is rising, you are
learning to delegate.

## Usage

```bash
npx promptstreak                          # graph + stats, opens the shareable page
npx promptstreak --metric leash           # pick the metric that fills the grid
npx promptstreak --print-url              # print the share link instead of opening it
npx promptstreak --no-open                # terminal only
npx promptstreak --json                   # raw metrics, for scripting
npx promptstreak --local                  # history.jsonl only, skip transcripts
```

### More than one machine

Prompts on a server or a second laptop live in that machine's history. Merge them:

```bash
ssh box 'cat ~/.claude/history.jsonl' > box.jsonl
npx promptstreak box.jsonl
```

Any number of files or directories can be passed, and duplicates are dropped. The web page takes
dropped files the same way.

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

Everything runs in the browser only. The share link carries view data only, never the source —
per-day counts and headline numbers, in the URL **fragment**, which browsers never send to a
server. The page is static: no analytics, no backend, no upload endpoint.

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

MIT.
