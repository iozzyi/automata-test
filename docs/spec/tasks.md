# Tasks: Lab run monitor take-home

> Spec 3 of 3 · [requirements](requirements.md) → [design](design.md) → [tasks](tasks.md)
> Status: v1.0 · 2026-10-21 · Tick boxes as we go. Each task names the requirements it satisfies and how we know it's done.
> Time budget: about 1.5 h spent on planning (14:15–15:45), plus spec writing (15:45–16:00). Target for the rest is about 3 h, with 30 min kept for NOTES.

Order follows the brief's ladder: rung 1 → rung 2 → Problem 2 → rungs 3–4 → NOTES. Problem 2 only needs rungs 1–2. If time runs short, T5 is what we drop, and we say so in NOTES.

## T0. Set up (≈15 min)

- [x] T0.1 Commit the untouched starter, then the solution outline (`37cf299`, `564c4b4`).
- [x] T0.2 Commit `CLAUDE.md` and `docs/spec/*` ("Add spec: requirements, design, tasks").
- [x] T0.3 Check prerequisites (installed via Homebrew: uv, node@22 (keg-only, needs `/opt/homebrew/opt/node@22/bin` on PATH), pnpm 12 (project pins 11.26.0); Python pinned to 3.12 in `.python-version` to match the Docker image; **Docker not installed**: run the simulator with `uv run` instead): `docker --version`, `node -v` (22), `pnpm -v` (11), `uv --version`, then `uv sync`, `cd web && pnpm install && pnpm exec playwright install chromium`.
- [x] T0.4 Baseline: `uv run pytest` and `cd web && pnpm test` fail as the README says (only the engine tests pass). Record the counts in `docs/WORKLOG.md`.
- [x] T0.5 *(you)* `brew install gh && gh auth login`, then `gh repo create automata-test --private --source=. --remote=origin --push`.
- [ ] T0.6 Bring `docs/SOLUTION_OUTLINE.md` §8 up to date (it still says "pending"; the decisions are settled), and fix diagram 6.3/6.4 "draft" labels.

## T1. Rung 1: number the events (`stream.py`) (≈30 min) · R1, R2.1–R2.3, R3, R4.1–R4.3

- [x] T1.1 `_seq`, `_buf` deque, `publish` assigns seq and buffers (design §2.2 step 1). `watermark()`, `earliest()`.
- [x] T1.2 `subscribe` computes backlog, gap and `earliest` atomically; add `Subscription.earliest` with a default (§2.3).
- [x] T1.3 Slow-viewer policy: `_Viewer` with `over_since`; 256 / 2 s / 512; disconnect = clear + `None` + remove; `sleep(0)` after the lock (§2.2).
- [x] T1.4 `tests/test_spec.py`: 512 limit, 2 s grace with a fake clock, grace cancelled when the queue drains, resume above watermark → gap, resume 0 after eviction → gap, `earliest` equals `backlog[0].seq`, no loss or duplicate when subscribing mid-publish.
- **Done when:** `uv run pytest` has the 4 stream gates and the T1.4 tests green. ✅ 16:12: 23/24 green (the 1 left is the retry gate, T3); ruff + mypy strict clean.

## T2. Rung 2: fold events into state (`runState.ts`) (≈50 min) · R5, R6, R7, R8.1–R8.2

- [x] T2.1 State shape (§3.1), `createRunState`, `mergeAttempt` with status and run-status ranks.
- [x] T2.2 `applyMessage` frame classification; `applyEvent` (drop rules, contiguous tracking, per-type patches, refused map) (§3.2–3.3).
- [x] T2.3 `applySnapshot` forward-only merge, skip `pending`, floor and contiguous (§3.4).
- [x] T2.4 `applyTransport`, `connection` derivation incl. hole tolerance of 10 (§3.6, O1).
- [x] T2.5 `selectTracks` (DEVICES order, unknown devices appended, deterministic sort), `selectResumeFrom`, `selectAttempt`.
- [x] T2.6 `RunPage`: await the snapshot, then `connect` (R6.4).
- [x] T2.7 `web/tests/runState.spec.test.ts`: foreign run_id; refused order; late snapshot no regress; pending snapshot step; hole clears on arrival; `selectAttempt.supersededBy`.
- **Done when:** `pnpm test` all green (provided + new), `pnpm check` clean, and with the simulator up a clean run draws 7 green bars (`./scripts/acceptance.sh`). ✅ 16:26: 44/44 vitest (17 gates + 27 new), `pnpm check` + `tsc` clean, `acceptance.sh` 3/3 against the Docker simulator; checked by eye in the browser.

## T3. Problem 2: the retry endpoint (≈30 min) · R9

- [ ] T3.1 `claim_retry(..., expected_attempt=None)` guard; `_decide_and_claim` under one lock (§4.1).
- [ ] T3.2 `handle_retry(run, step_id, body)` with body parsing and the response table; `api.py` route passes the body and returns a coded 404 for an unknown run.
- [ ] T3.3 `tests/test_spec.py`: every row of the §4.1 table, plus two concurrent pinned calls → exactly one `duplicate:false`.
- [ ] T3.4 `web/src/lib/api.ts`: `retryStep(runId, stepId, attempt)` sends `{attempt}` and returns `RetryResult` (`ok`/`status`/`code`/`message`/body; network error → `code: 'NETWORK'`).
- **Done when:** `uv run pytest` green, incl. the provided `test_retry_endpoint_retries_the_step`; `curl` against a `FAIL_STEP=warm_reagent_plate` run shows 202, then 202 duplicate, and `read_plate` shows 422.

## T4. Problem 2: the failure surface (≈60 min) · R10–R14

- [ ] T4.1 `runState.ts`: `retries`, `applyRetryRequested`, `applyRetryResult`, `selectFailures(state, now)` with phase precedence (§4.2). Unit tests for every ladder transition, incl. the 10 s rule, connection not live, someone else's retry (refused n+1 with no request), 422 → needs service, error → retry again.
- [ ] T4.2 `contextFormat.ts` + `contextFormat.test.ts`: `tidyLabel`, `formatScalar`, `serviceReport`.
- [ ] T4.3 `InstrumentDetails` with recursive `ContextValue` (boxes for objects, numbered boxes for lists), raw key beside the label, Copy JSON.
- [ ] T4.4 `FailureCard` (retryable and needs-service variants), `NeedsAttention` panel; wire into `RunPage` between Banner and Timeline; Retry click → request → result.
- [ ] T4.5 `Timeline` `onSelect`/`selected` props (keyboard-accessible; test ids and `data-*` unchanged) + `AttemptDetail` below it.
- [ ] T4.6 Manual check, three runs (record what you saw in WORKLOG, screenshots optional):
  - `FAIL_STEP=warm_reagent_plate`: card appears on failure; details show all 6 keys with tidied labels; Retry → Requested → Accepted → (Queued) → card leaves; red bar #1 stays; clicking it shows "Superseded by attempt #2"; the run completes.
  - `FAIL_STEP=read_plate`: no Retry button; needs-service styling; `service_ticket` visible; Copy report works; the run stays blocked.
  - `FAIL_STEP=fill_buffer_plate`: liquid handler keys render; retry works on a contended device (Queued state may show).
  - Double-click Retry → only one new attempt.
  - Stop the simulator mid-retry → "Not confirmed yet…".
- **Done when:** the T4.6 checklist passes, `pnpm test` and `pnpm check` are green, and the acceptance script is still green.

## T5. Rungs 3–4: reconnect and gap (≈30 min) · R2.4, R4.4–R4.8, R8.3

- [ ] T5.1 `api.py` TASK: send the gap frame (§2.4).
- [x] T5.2 (done early in T2: two provided vitest gates need it) `runState.ts`: `applyGap` (sticky, write off), closed-after-gap note.
- [ ] T5.3 `tests/test_spec.py`: websocket test that the first frame after an unservable resume is the gap frame, then the backlog.
- [ ] T5.4 `./scripts/check-disconnect.sh` green.
- [ ] T5.5 Manual: `SOCKET_KILL_MS=2500 SOCKET_REJECT_MS=6000 REPLAY_BUFFER_SIZE=2` → rose banner, it stays after reconnect, and some bars stay striped (matches `docs/timeline-gap.png`).
- [ ] T5.6 Manual: `REORDER_PCT=30 DUPLICATE_PCT=20` → the run converges to 7 green bars. Note whether the hole warning ever flashes at tolerance 10 (for NOTES).
- **Done when:** all four README commands are green.

## T6. NOTES.md (≈30 min, protected) · R15

- [ ] T6.1 Time spent (from WORKLOG).
- [ ] T6.2 Not built: snapshot re-fetch after a gap; refilling holes on a live socket; retry history for late joiners; idempotency key; per-instrument layouts.
- [ ] T6.3 Where it breaks: the snapshot's missing retry history; the shared `_held` list; server restart; unknown device not drawn; the hole tolerance trade-off; `37.0` → `37`.
- [ ] T6.4 Never-seen step: design §3.8.
- [ ] T6.5 Contract changes before integrators build on it: add a `step.retry_requested` event (a retry is silent today); put `seq` on the gap frame or version the frames; an `attempt` on the snapshot's step history; keep `seq`/`at`/`attempt` keys and the 202/409/422 codes stable.
- [ ] T6.6 Feedback on the exercise: README `cd ../web` typo; RunPage comment vs. code race; `step.refused` carrying `attempt + 1`; what had to be guessed.
- [ ] T6.7 Final commit; check the submission list in the README.

## Traceability

| Requirement | Tasks |
|---|---|
| R1 | T1.1, T1.4 |
| R2 | T1.1–T1.2, T2.6, T5.4 |
| R3 | T1.3, T1.4 |
| R4 | T1.2, T5.1–T5.3, T5.5 |
| R5 | T2.1–T2.2, T2.5, T2.7 |
| R6 | T2.3, T2.5–T2.7 |
| R7 | T2.4, T2.7 |
| R8 | T2.4, T5.2 |
| R9 | T3.1–T3.4 |
| R10 | T4.4–T4.5 |
| R11 | T4.1 |
| R12 | T4.1, T4.4, T4.6 |
| R13 | T4.2–T4.3 |
| R14 | T4.2, T4.4 |
| R15 | T6 |
