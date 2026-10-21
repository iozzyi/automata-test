# Work log

Running record of time and decisions, so `NOTES.md` almost writes itself. Times are UK (BST).

## 2026-10-21

| When | What | Decisions / findings |
|---|---|---|
| 14:15–15:45 | Read the brief and code, wrote `docs/SOLUTION_OUTLINE.md`, settled decisions A–I (claude.ai/code session) | See CLAUDE.md "Decisions" |
| 15:45–16:15 | Spec: `docs/spec/requirements.md`, `design.md`, `tasks.md` (Claude Code desktop) | Q1 strict gap rule + fix RunPage race · Q2 late snapshot merges forward-only · Q3 nested `context` as labelled boxes (my choice over the recommended inline JSON: better for a scientist) · Q4 retry state in `runState.ts` |
| | Found while writing the spec | `RunPage` comment says "snapshot first" but the code races · `asyncio.Lock` doesn't yield when free, so bursts starve readers (added a `sleep(0)` after publish) · `REORDER_PCT=30` will make a 5-event hole tolerance flash false alarms (open item O1) · the snapshot handler's watermark is already safe (read before the lock) |
| 16:20 | O1 settled | Hole tolerance raised from 5 to 10 later events: false alarms under reorder chaos ~17% → ~3%; real loss still flagged within ~1 s |

**Time so far:** ~2 h (planning 1.5 h, spec 0.5 h). No code yet.
