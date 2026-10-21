# Hand-off: Automata take-home (Lab run monitor)

Context carried over from a planning session in Claude (claude.ai/code, 2026-10-21, ~14:15–15:45 UK). Read this first, then `docs/SOLUTION_OUTLINE.md` (diagrams, gap analysis, full decisions register) and `README.md` (the brief).

## Who I am and how to work with me

- Take-home for a **Principal Engineer** role at Automata (lab automation). AI use is permitted, but **I must be able to explain and justify every decision** in the interview. The brief also asks to share AI conversations.
- **When anything is ambiguous, stop and ask me.** When you have the context, give **3 options with one recommended** (recommended first), then ask me to choose. Use the AskUserQuestion tool where available.
- Explain in **plain English**; treat me as a layman on the engineering terms. Be honest about trade-offs and weak ideas, including mine.
- Process is **spec-driven**: settled decisions → `SPEC.md` (behaviour + acceptance criteria) → implement → verify.
- Keep a running **time and decisions log** so `NOTES.md` (required) almost writes itself.
- Git author for this repo: **Osman Ilyas <osmanilyas@hotmail.com>** (set in the repo's local git config). End commit messages with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## The exercise in one screen

- **Problem 1, "make the run honest"** (graded by tests), four rungs in order: (1) number events with a monotonic `seq` and give the snapshot a real watermark; (2) fold events into state so late, duplicate and out-of-order delivery give the same result; (3) survive a reconnect by resuming without loss; (4) admit an unrecoverable gap on screen. Files: `simulator/stream.py`, `web/src/lib/runState.ts`, the `TASK` block in `simulator/api.py`.
- **Problem 2, "make a failure actionable"** (mostly ungated, "where we look first"): design the retry endpoint (`simulator/retry.py`, `handle_retry`) and the failure UI for a scientist at the bench and an integrator's script. Problem 2 needs rungs 1–2 only; rungs 3–4 can be dropped if time runs short (say so in the notes).
- **`NOTES.md`** (required): time spent, then ~400 words on: what we deliberately didn't build; where the state layer is most likely to break; an event for a never-seen step; what to change or keep in the event contract and endpoint before integrators build on it. End with blunt feedback on the exercise.
- Suggested timebox 2–4 h. **Time so far: ~1.5 h on understanding, planning and decisions (14:15–15:45), no code yet.**

## Commands

```bash
docker compose up --build -d            # simulator on :5002
cd web && pnpm install && pnpm exec playwright install chromium && pnpm dev   # :3000
uv run pytest                           # stream + endpoint
cd web && pnpm test                     # state layer (vitest)
./scripts/acceptance.sh                 # clean run (needs both running, no knobs on)
./scripts/check-disconnect.sh           # dropped socket
cd web && pnpm check                    # eslint + prettier (pnpm format fixes)
# Failure scenarios for Problem 2:
FAIL_STEP=warm_reagent_plate docker compose up -d simulator   # incubator, retryable
FAIL_STEP=read_plate         docker compose up -d simulator   # plate reader, NOT retryable
FAIL_STEP=fill_buffer_plate  docker compose up -d simulator   # liquid handler
# Gap: SOCKET_KILL_MS=2500 SOCKET_REJECT_MS=6000 REPLAY_BUFFER_SIZE=2 docker compose up -d simulator
```

Prereqs (not yet verified on this Mac): Docker, Node 22 + pnpm 11, Python 3.12 + uv.

## Current state

- Git: the folder was just `git init`-ed on `main` with **no commits**. The earlier commits were undone to fix the author. Planned commits: (1) the untouched starter, everything except `docs/SOLUTION_OUTLINE.md` and this file; (2) the solution outline; then the hand-off and spec as we go.
- GitHub: repo **`automata-test`** (private suggested) **not created yet**. `gh` is not installed locally: `brew install gh && gh auth login`, then `gh repo create automata-test --private --source=. --remote=origin --push`.
- Written so far: `docs/SOLUTION_OUTLINE.md` (v0.2, 17 Mermaid diagrams, decisions A–I in §8). No source files changed yet.

## Decisions (settled; details and rejected alternatives in SOLUTION_OUTLINE.md §8)

**Problem 1**
- **A, slow viewer (`stream.py`):** grace period, then disconnect. Each viewer's queue: over **256** queued starts a **2 s** clock; if still over 256 when it expires, or as soon as it's over **512**, disconnect: clear its queue and put the `None` end-of-stream marker. Check on every `publish()`, no timer task. `publish()` must never await a viewer. The browser then resumes from the buffer, or gets a gap. *Rejected:* plain disconnect, unbounded queue, drop + inline gap, retry/backoff + per-viewer DLQ (the replay buffer already is the replay store; a DLQ is for poison messages, not slow consumers; retrying in `publish()` stalls the run), count-only grace (same as a bigger queue).
- **B, ordering (`runState.ts`):** apply every event immediately with an order-proof merge: attempts keyed `stepId#attempt`, status only moves forward (dispatched < running < done/failed), times taken from each event's own `at`. Remember seen seqs, so duplicates are ignored. Ignore events whose `run_id` isn't ours, and anything at or below the snapshot `seq`. A hole still open after **5** later events → `stale` with note "An update was lost in transit; this view may be incomplete", cleared if it arrives. **`selectResumeFrom` = the highest seq with nothing missing before it** (not the max seen), so a reconnect refills holes.
- **C, unservable resume (`api.py` TASK):** send `{"type":"gap","from":<resume_from>,"earliest":<oldest held>}`, then the backlog still held, then live. Client status `gap`, **sticky** across reconnects. Seqs `from+1 .. earliest-1` are **written off**, so later resumes don't re-request them. Bars whose end fell in the gap stay `running`. *Not built (for NOTES):* re-fetching the snapshot to repair the present.

**Problem 2**
- **D, retry endpoint:** idempotent per attempt. **Optional** JSON body `{"attempt": n}`; the provided test posts with **no body**, so it must work without one, meaning "retry the current failed attempt". Responses:
  - **202** `{step_id, retrying_attempt, next_attempt, status, duplicate}`; a repeat of the same pinned request gives `duplicate: true` and creates no new attempt.
  - **409** `STEP_NOT_FAILED` with the current step.
  - **422** `NOT_RETRYABLE` with the instrument's error (enforced on the server; `claim_retry` doesn't check `retryable`).
  - **404** `UNKNOWN_RUN` / `UNKNOWN_STEP`.
  - **400** for a malformed body.
  - Every error body has a machine-readable `code`. The browser always sends the attempt.
- **E, placement:** a "Needs attention" panel between the Banner and the Timeline, shown only while something is actionable. Clicking any bar (including superseded failures) shows that attempt's details below the timeline.
- **F, actionable:** the step's **latest attempt failed and no retry is in flight**. It appears on `step.failed`, without waiting for `run.blocked`. Once a newer attempt exists it becomes history (red bar stays, detail says "superseded by #2"). Implemented as a **new selector**: `selectTracks` keeps every attempt and its error.
- **G, after clicking Retry:** a requested-state ladder on the card with the button disabled: "Retry requested" → "Accepted, waiting for the instrument" (202) → "Queued, instrument busy" (`step.refused`) → leaves the panel (`step.dispatched` for the next attempt). No events within **10 s**, or connection not live → "Not confirmed yet; this screen isn't receiving updates". An HTTP error → show the server's reason. **The timeline doesn't change until real events arrive.**
- **H, `context`:** generic list of every key. The label is tidied (`actual_c` → "Actual (°C)", `_s` → s, `_ul` → µL, `_days` → days) with the raw key shown beside it. Values formatted by type. Open by default under "Instrument details", with "Copy JSON". Never drop a key; no per-instrument templates.
- **I, not retryable:** no Retry button. Explain that it will fail the same way until the instrument is serviced. Show the instrument details (e.g. `service_ticket`) and "Copy report for service" (run, step, attempt, time, full error). State "The run stays blocked; completed steps are kept." Visibly distinct styling.

## Constraints to preserve

- Keep the exported signatures in `runState.ts` and in `stream.py` (`Stream.publish/subscribe/watermark/earliest`, `Subscription`): the tests call them.
- Keep the existing `data-testid`s and the bar's `data-*` attributes: `start-run`, `run-status`, `timeline`, `lane`, `bar`, `connection-banner`. The new UI uses **new** test ids only.
- Assign `seq` in `stream.py` (the chaos knobs act after seq assignment, in `api.py`).

## Code findings (use in SPEC.md and NOTES.md)

- **The snapshot drops retry history:** `GET /runs/{id}` has only the latest attempt per step, and `claim_retry` clears `error`. Only the stream carries attempt-1 failures.
- **`RunPage` race:** it fetches the snapshot and opens the socket concurrently, so `selectResumeFrom` is 0 on the first connect, and events may be applied before the snapshot arrives. `applySnapshot` must merge, not overwrite.
- **`claim_retry` is silent:** no event is emitted. The first evidence is `step.dispatched` for the next attempt, which may be preceded by `step.refused`.
- **Run status stays `blocked`** while a retried step runs, until `run.completed`. There is no "unblocked" event.
- **`step.refused` carries `attempt + 1`** (the upcoming attempt).
- **`server._held` (reorder chaos) is one list shared by all sockets and runs,** so a held event can surface on another connection. Hence: ignore a foreign `run_id`.
- **README typo:** `cd ../web` should be `cd web` (for the feedback section).
- The tests' gap frame shape is `{type:'gap', from:10, earliest:40}`. The stalled-viewer test accepts either "still whole" or "disconnected (None)".

## Open questions to settle while writing SPEC.md (ask me, 3 options + recommendation)

- Gap rule edge cases: `resume_from` above the watermark; a first connect with `resume_from=0` after early events have been evicted.
- `applySnapshot` arriving after newer events (snapshot `seq` lower than what's applied).
- How `context` values that are objects or arrays are shown.
- Where the "retry in flight" state lives (`runState.ts`, so it can be unit-tested, vs. React component state).

## Next steps

1. Make the commits (starter, then outline), create and push `automata-test`.
2. Write `SPEC.md` from the decisions above, with acceptance criteria per decision (and new unit tests for Problem 2 behaviour).
3. Rung 1, `stream.py` → `uv run pytest`.
4. Rung 2, `runState.ts` → `pnpm test`.
5. Problem 2: endpoint, then the failure surface; check with the three `FAIL_STEP` scenarios.
6. Rungs 3–4 → both scripts.
7. `NOTES.md` with time spent; leave time for it.
