# Work log

Running record of time and decisions, so `NOTES.md` almost writes itself. Times are UK (BST).

## 2026-10-21

| When | What | Decisions / findings |
|---|---|---|
| 14:15–15:45 | Read the brief and code, wrote `docs/SOLUTION_OUTLINE.md`, settled decisions A–I (claude.ai/code session) | See CLAUDE.md "Decisions" |
| 15:45–16:00 | Spec: `docs/spec/requirements.md`, `design.md`, `tasks.md` (Claude Code desktop) | Q1 strict gap rule + fix RunPage race · Q2 late snapshot merges forward-only · Q3 nested `context` as labelled boxes (my choice over the recommended inline JSON: better for a scientist) · Q4 retry state in `runState.ts` |
| | Found while writing the spec | `RunPage` comment says "snapshot first" but the code races · `asyncio.Lock` doesn't yield when free, so bursts starve readers (added a `sleep(0)` after publish) · `REORDER_PCT=30` will make a 5-event hole tolerance flash false alarms (open item O1) · the snapshot handler's watermark is already safe (read before the lock) |
| ~16:02 | O1 settled | Hole tolerance raised from 5 to 10 later events: false alarms under reorder chaos ~17% → ~3%; real loss still flagged within ~1 s |
| 16:06–16:09 | T0: tooling | Nothing installed beyond brew/gh. Brewed uv, node@22, pnpm (gives 12; project pins 11.26.0). uv chose Python 3.15 → pinned 3.12 (`.python-version`) to match `python:3.12-slim`. Docker skipped: simulator can run via `uv run`. Baseline: 5 engine tests pass, 5 stream/endpoint fail, as the README says |
| 16:09–16:12 | T1: rung 1, `stream.py` | Implemented design §2 as specced. 4/4 stream gates green + 14 new tests (`tests/test_spec.py`): hard limit, grace with fake clock, grace reset, healthy reader under burst, gap-rule table (8 cases), `earliest` agrees with backlog, subscribe mid-publish no loss/dup. Mutation check: removing the `sleep(0)` makes the burst test fail (healthy viewer cut off after 0 events), so the design call is justified by a test. My own test bug: subscribed ahead of the watermark and got a gap, which is correct per R4.2 |

**Time so far:** ~2 h (planning 1.5 h, spec 0.25 h, setup + rung 1 ~0.2 h, wall-clock 14:15–16:12).
