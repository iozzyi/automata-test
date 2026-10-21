# Notes

## Time spent

About 3 h 40 min, in one sitting on 21 Oct (14:15–17:55 UK):

- 1 h 30 understanding the brief and code, and settling the design decisions (`docs/SOLUTION_OUTLINE.md`)
- 15 min writing the spec (`docs/spec/`: requirements, design, tasks)
- 15 min machine setup (Docker, Node, pnpm, uv were not installed)
- 45 min building and checking all four rungs and Problem 2, in that order
- 20 min on three rounds of independent QA review (a separate AI agent briefed as QA lead against the README), and fixing what it found
- 30 min on what my own manual testing turned up, plus one more QA round on it: a run outcome line, a frozen timeline once complete, reopening runs after a refresh, and a scenario picker with a Reset (simulator-only `PUT /config` and `POST /reset`) so failures can be tried without restarting Docker
- 5 min drafting this note, then keeping it accurate as the work changed

AI-assisted throughout (Claude), which is why the build part is short. I made the decisions; the reasoning is in `docs/spec/design.md` and `docs/WORKLOG.md`, and I can share the conversations.

## 1. What I deliberately didn't build

- **Detecting a lost final event.** A missing number only shows when a later one arrives, so a lost last event leaves every bar done but the run "running". The fix belongs in the contract (see 4).
- **An attempt superseded inside a gap.** If a failure and its retry both fall in a gap, the snapshot only knows the retry, so the first attempt stays striped.
- **Retry history for a late-opened page.** The snapshot keeps only the latest attempt and `claim_retry` clears the error, so the first failure is invisible.
- An idempotency-key header, auth, who-retried, and per-instrument layouts for `context`.

## 2. Where the state layer is most likely to break

- **The thresholds are tuned to this simulator.** "Lost" means 10 later events or 2 s open. A slower or burstier real stream would need different numbers.
- **A simulator restart.** Run ids restart at `r-1`: the page either reconnects forever under "Disconnected", or merges the new run into the old one's bars.
- **No snapshot.** The run id is then learned from the first event. Under the reorder knob, that event can belong to another run.
- **A retry request that never answers** leaves the card on "Retry requested"; the 10 s "not confirmed" rule only starts after a 202.

## 3. An event for a step it has never seen

Step ids aren't checked, so it becomes an attempt like any other on its instrument's lane, and a failure gets a card with its context shown generically. An unknown instrument's attempt is kept and its failure still reaches "Needs attention", but the Timeline only draws the three known lanes; I'd add an "other instruments" lane.

## 4. Before integrators build on it

Change:

- **Add a heartbeat** with the stream position (`{"type":"heartbeat","seq":N}`): it reveals a lost final event, and tells a quiet blocked run from a dead connection.
- **Emit an event when a retry is accepted.** `claim_retry` is silent today.
- **Rename `step.refused`'s `attempt`** to `next_attempt`: that's what it carries.
- **Add a "run resumed" event**, since status stays `blocked` while a retry runs.
- **Put all attempts in the snapshot**, with their errors.
- **Make run ids unique across restarts.**
- **On the endpoint:** a distinct code when the named attempt isn't the failed one, and document that only a named attempt is repeat-safe.

Keep:

- The per-run `seq` assigned at the stream, `at` on every event, and attempt numbers.
- The error shape, with `context` open-ended.
- The retry endpoint: 202 (accepted, not done), repeat-safe when the attempt is named, coded 409/422/404/400, unknown body fields rejected.

## Feedback on the exercise

- **Clear, and well-laddered.** The rungs build on each other, and the tests are a good spec. The gap frame's shape was effectively given away by a test, which was useful.
- **The `RunPage` comment says "snapshot first", but the code fetches the snapshot and opens the socket at the same time.** I fixed it. If it was a planted bug, fine; if not, it's misleading.
- **The reorder knob does more than reorder.**
  - Its holding list is shared by all sockets and runs, so events leak onto other runs' connections.
  - It never releases the last held event, so it also loses events.
  - That forced design work (the 2 s rule and the reconnect-to-refill). If it's deliberate, say so in the README.
- **`pnpm test` doesn't type-check.** Vitest passed while `tsc` found a missing field. Adding `tsc` to `pnpm check` would catch that.
- **The engine tests take about 55 s** (real sleeps), which slows `uv run pytest`.
- **Setup:**
  - `cd ../web` in the README should be `cd web`.
  - `requires-python >=3.12` let uv pick Python 3.15; a `.python-version` would pin 3.12 like the Dockerfile does.
  - Homebrew installs pnpm 12, though the pin then took over correctly.
- **The brief doesn't say what the screen shows once a run ends.** The provided Timeline keeps growing with the clock and nothing states the outcome, so a finished run looked broken in manual testing. And switching scenarios means restarting Docker; I added a testing-only picker.
- **The "Queued, instrument busy" retry state can't be reached** with the provided `FAIL_STEP`s, because the retried step's instrument is always free by then. A contended failure scenario would let candidates exercise it.
- **On time:** 2–4 h is realistic with AI help. Without it, Problem 2 alone could fill that. Half my time went on understanding and deciding, which felt like the right split.
