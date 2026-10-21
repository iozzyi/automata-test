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

- [x] T3.1 Pinned-attempt check, retryable check and claim under one `run.lock`; transition shared with `claim_retry` via `_reset_for_retry` (§4.1, changed from the `expected_attempt` plan).
- [x] T3.2 `handle_retry(run, step_id, body)` with body parsing and the response table; `api.py` route passes the body and returns a coded 404 for an unknown run.
- [x] T3.3 `tests/test_spec.py`: every row of the §4.1 table, plus two concurrent pinned calls → exactly one `duplicate:false`.
- [x] T3.4 `web/src/lib/api.ts`: `retryStep(runId, stepId, attempt)` sends `{attempt}` and returns `RetryResult` (`ok`/`status`/`code`/`message`/body; network error → `code: 'NETWORK'`).
- **Done when:** `uv run pytest` green, incl. the provided `test_retry_endpoint_retries_the_step`; `curl` against a `FAIL_STEP=warm_reagent_plate` run shows 202, then 202 duplicate, and `read_plate` shows 422. ✅ 16:34: 47/47 pytest (10 provided + 37 new); curl on all three `FAIL_STEP` runs in Docker as expected (incubator and liquid handler: 202 → 202 duplicate → 409 → 400, run completes on attempt 2; plate reader: 422 every time with `service_ticket`, run stays blocked).

## T4. Problem 2: the failure surface (≈60 min) · R10–R14

- [x] T4.1 `runState.ts`: `retries`, `applyRetryRequested`, `applyRetryResult`, `selectFailures(state, now)` with phase precedence (§4.2). Unit tests for every ladder transition, incl. the 10 s rule, connection not live, someone else's retry (refused n+1 with no request), 422 → needs service, error → retry again.
- [x] T4.2 `contextFormat.ts` + `contextFormat.test.ts`: `tidyLabel`, `formatScalar`, `serviceReport`.
- [x] T4.3 `InstrumentDetails` with recursive `ContextValue` (boxes for objects, numbered boxes for lists), raw key beside the label, Copy JSON.
- [x] T4.4 `FailureCard` (retryable and needs-service variants), `NeedsAttention` panel; wire into `RunPage` between Banner and Timeline; Retry click → request → result.
- [x] T4.5 `Timeline` `onSelect`/`selected` props (keyboard-accessible; test ids and `data-*` unchanged) + `AttemptDetail` below it.
- [x] T4.6 Manual check, three runs (record what you saw in WORKLOG, screenshots optional):
  - `FAIL_STEP=warm_reagent_plate`: card appears on failure; details show all 6 keys with tidied labels; Retry → Requested → Accepted → (Queued) → card leaves; red bar #1 stays; clicking it shows "Superseded by attempt #2"; the run completes.
  - `FAIL_STEP=read_plate`: no Retry button; needs-service styling; `service_ticket` visible; Copy report works; the run stays blocked.
  - `FAIL_STEP=fill_buffer_plate`: liquid handler keys render; retry works on a contended device (Queued state may show).
  - Double-click Retry → only one new attempt.
  - Stop the simulator mid-retry → "Not confirmed yet…".
- **Done when:** the T4.6 checklist passes, `pnpm test` and `pnpm check` are green, and the acceptance script is still green. ✅ 16:42: 94/94 vitest, `pnpm check` + `tsc` clean, acceptance 3/3. T4.6 results:
  - incubator: card on `step.failed`; 6 keys tidied; recorded ladder requested (58 ms) → accepted (113 ms) → card gone on dispatch (133 ms) → bar #2 appears only at `step.started` (240 ms); red #1 stays; its detail says "Superseded by attempt #2"; run completed.
  - plate reader: rose card, "Needs service", no Retry button, `service_ticket` SVC-3312 shown; Copy report produces the full text (checked with a stand-in clipboard: the embedded preview browser's real clipboard never answers).
  - liquid handler: 5 keys incl. "Volume (µL)"; double-click sent exactly one request (button disables), one new attempt, run completed.
  - simulator stopped: "Not confirmed yet…" then "Couldn't reach the lab server" with Try again.
  - Not seen live: "Queued, instrument busy" (the workflow never contends on a retried step); covered by unit tests.

## T5. Rungs 3–4: reconnect and gap (≈30 min) · R2.4, R4.4–R4.8, R8.3

- [x] T5.1 `api.py` TASK: send the gap frame (§2.4).
- [x] T5.2 (done early in T2: two provided vitest gates need it) `runState.ts`: `applyGap` (sticky, write off), closed-after-gap note.
- [x] T5.3 `tests/test_spec.py`: websocket test that the first frame after an unservable resume is the gap frame, then the backlog.
- [x] T5.4 `./scripts/check-disconnect.sh` green.
- [x] T5.5 Manual: `SOCKET_KILL_MS=2500 SOCKET_REJECT_MS=6000 REPLAY_BUFFER_SIZE=2` → rose banner, it stays after reconnect, and some bars stay striped (matches `docs/timeline-gap.png`).
- [x] T5.6 Manual: `REORDER_PCT=30 DUPLICATE_PCT=20` → the run converges to 7 green bars. Note whether the hole warning ever flashes at tolerance 10 (for NOTES).
- **Done when:** all four README commands are green. ✅ 16:47: pytest 51/51 (4 new websocket tests), vitest 94/94, acceptance 3/3, check-disconnect 2/2.
  - Gap run (kill 2.5 s, reject 6 s, buffer 2): gap frame `{from:8, earliest:18}`; banner gap, then "Disconnected. Part of this run was also not recorded.", then gap again (sticky); next resume asked from 22, not 8 (write-off works); run completed with 2 bars still striped, as in `docs/timeline-gap.png`; 2 steps missing entirely.
  - O5 fix re-run, reorder 30 / duplicate 20, 4 runs: run 1 lost an event mid-run; the hole warning showed, the page reconnected from 17 by itself, and the run ended complete and live. Runs 3–4 lost their *final* event (`run.completed`, held by the knob with nothing after it) → O6. acceptance 3/3 and check-disconnect 2/2 still green after the change.
  - Reorder 30 / duplicate 20, 3 runs: 2–6 duplicates and 2–4 out-of-order per run; runs 1–2 converged to 7 green bars. Run 3: one false "update lost" flash that cleared, and **one event lost for good at the end** (`read_plate` finished, held by the reorder knob and never released): screen showed completed + live with a running bar, because fewer than 10 events followed the hole. See O5 in design §6.

## T6. NOTES.md (≈30 min, protected) · R15

- [x] T6.1 Time spent (from WORKLOG).
- [x] T6.2 Not built: snapshot re-fetch after a gap; heartbeat / tail-loss detection (O6); retry history for late joiners; idempotency key; per-instrument layouts.
- [x] T6.3 Where it breaks: the snapshot's missing retry history; the shared `_held` list; server restart; unknown device not drawn; the hole tolerance trade-off; `37.0` → `37`.
- [x] T6.4 Never-seen step: design §3.8.
- [x] T6.5 Contract changes before integrators build on it: **a heartbeat frame carrying the watermark (O6: a lost final event is otherwise undetectable; also catches a half-dead socket on a long blocked run)**; add a `step.retry_requested` event (a retry is silent today); put `seq` on the gap frame or version the frames; an `attempt` on the snapshot's step history; keep `seq`/`at`/`attempt` keys and the 202/409/422 codes stable.
- [x] T6.6 Feedback on the exercise: README `cd ../web` typo; RunPage comment vs. code race; `step.refused` carrying `attempt + 1`; what had to be guessed.
- [ ] T6.7 Final commit; check the submission list in the README.

## T7. QA review loops (≈30 min)

- [x] T7.1 Loop 1: QA-lead subagent review against README. All gates green, every README item Met; 15 gaps, none labelled Critical. QA-1 to QA-4 fixed (design §6), 11 regression tests (`web/tests/runState.qa.test.ts`), 110/110 vitest, acceptance 3/3, check-disconnect 2/2, live gap+failure run: snapshot re-read on the gap completed the bars and showed the card.
- [x] T7.2 Loop 2: fixes confirmed; QA-16 (regression from the QA-1 fix) and QA-18 fixed; 7 new tests (117/117); mutation check: the old gap re-read fails 3 of them; acceptance 3/3, check-disconnect 2/2.
- [x] T7.3 Loop 3: QA-16 and QA-18 confirmed closed; no new Critical gaps, so the loop stops (3 of 3 used). New: QA-20 (gap re-read dropped if the run id is still unknown; needs the initial snapshot to fail too) and QA-21 (snapshot time can win over the event's `at` by <1 ms), left for NOTES.
- [x] T7.4 NOTES.md corrected for what the loops changed (snapshot re-read is now built) and what they found (QA-5/6/7/9/17).

## T8. Changes from Osman's manual testing (17:22–17:31)

- [x] T8.1 R16: the timeline stops at the last report once the run is completed; one outcome line under the header (`selectTimelineEnd`, `selectOutcome`, 9 tests).
- [x] T8.2 R17: no false "Connecting" banner or ticking axis when no run is open; a run list (`GET /runs`) to reopen or switch runs.
- [x] T8.3 R18: `PUT /config` (validated, 12 pytest tests) and a scenario picker with 7 named scenarios; the check scripts still warn from `/health`.
- [x] T8.4 Checks: pytest 63/63, vitest 128/128, tsc and pnpm check clean, acceptance 3/3, check-disconnect 2/2. Browser: picker switched the simulator live; outcome went "Running · 1 step done" → "Blocked: … can be retried" → "Retrying … (attempt 2)" → "Completed in 25.6 s · 7 steps · 1 retry"; axis frozen; refresh → no run → reopened r-1 from the list (attempt 1's red bar absent: snapshot limit). Found and fixed on the way: a bare "Blocked" while the run had resumed, a stale "Applied" message, an empty-list wording.

- [x] T8.5 QA review of R16–R18: no gaps labelled Critical; by our definition (false claims) QA-22, QA-24 and QA-25 are Critical and were fixed with QA-23, QA-27, QA-28 (wording) and QA-26 (reset hint). 4 new tests (132/132); browser: switching runs starts from an empty state (old bars never shown under the new id). QA-29 (no cap on replay_buffer_size) left as a nit. acceptance 3/3, check-disconnect 2/2.

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
