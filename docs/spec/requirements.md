# Requirements: Lab run monitor take-home

> Spec 1 of 3 · [requirements](requirements.md) → [design](design.md) → [tasks](tasks.md)
> Status: v1.0 · 2026-10-21 · sources: `README.md` (the brief), `docs/SOLUTION_OUTLINE.md`, decisions A–I and Q1–Q4 (listed at the end)

Each requirement has a user story and acceptance criteria in EARS form ("WHEN … THE … SHALL …"). Criteria marked **[gate]** are checked by a provided test or script. **[new test]** means we add a test. **[manual]** means we check it by running a `FAIL_STEP` scenario and looking at the screen.

Words used throughout:

- **seq**: the event's position in the stream, 1, 2, 3, … per run.
- **watermark**: the highest seq published so far.
- **buffer**: the last N events the server keeps (`REPLAY_BUFFER_SIZE`, default 64).
- **resume point**: the seq the browser says it already has when it reconnects (`resume_from`).
- **gap**: events that happened but can't be replayed to this browser any more.
- **hole**: a seq the browser hasn't received although it has received later ones.
- **attempt**: one try of one step on one instrument. A retried step has several attempts.

---

## Problem 1: make the run honest

### R1. Number every event (rung 1)

*As an integrator, I want every event to carry a unique, increasing number, so that I can tell new from duplicate and spot anything missing.*

1. WHEN an event is published, THE stream SHALL give it `seq = previous seq + 1`, starting at 1 for each run. **[gate]** `test_seq_is_assigned_and_monotonic`
2. THE stream SHALL assign seq before the event leaves `stream.py`, so the wire chaos knobs (reorder, duplicate) act on already-numbered events.
3. WHEN asked for `watermark()`, THE stream SHALL return the highest seq published, or 0 if none. **[gate]**
4. WHEN `GET /runs/{id}` is served, THE snapshot's `seq` SHALL be a watermark that covers every change the snapshot shows. That is, no event with a seq at or below it is missing from the snapshot. The snapshot may also show changes *newer* than its seq; R6.2 makes those harmless. (Already true of the provided handler; see design §3.3.)

### R2. Keep the recent past and replay it (rungs 1 and 3)

*As a scientist whose Wi-Fi blinked, I want the screen to catch up on what I missed, so that the timeline is complete.*

1. THE stream SHALL keep the last `buf_size` events in order and drop the oldest when full.
2. WHEN `subscribe(resume_from)` is called and every event after `resume_from` is still held, THE stream SHALL return exactly those events as the backlog, in seq order, with `gap = false`. **[gate]** `test_resume_returns_exactly_the_gap`
3. THE stream SHALL compute the backlog and register the new viewer in one step, so that no event is lost or sent twice between the replay and the live feed. **[new test]**
4. WHEN the browser reconnects, IT SHALL ask to resume from its resume point (R6.5), and the timeline SHALL end up the same as if it had never disconnected. **[gate]** `check-disconnect.sh` (3b: 7 bars, all done)

### R3. A slow viewer must not stall the run (decision A)

*As the lab, I want one stuck browser not to hold up the run or anyone else.*

1. `publish()` SHALL never wait on any viewer. **[gate]** `test_one_stalled_viewer_does_not_break_the_run`
2. WHEN a viewer has more than 256 events queued, THE stream SHALL start a 2-second grace clock for that viewer.
3. WHEN that viewer still has more than 256 queued after the 2 s, OR it reaches more than 512 queued at any time, THE stream SHALL disconnect it: clear its queue and put the end-of-stream marker (`None`). **[gate]** (the test accepts "disconnected") **[new test]** for the 512 limit and the 2 s grace
4. WHEN a viewer drops back to 256 or fewer before the 2 s are up, THE stream SHALL cancel the clock.
5. THE stream SHALL check these limits on each `publish()`, with no background timer.
6. A viewer SHALL never be left silently missing events. It either has every event, or it is disconnected and can resume or be told about a gap.

### R4. Admit a gap the server can't fill (rung 4, decision C, Q1)

*As a scientist, I want to be told when part of the run couldn't be recovered, so that I don't trust a timeline that is missing things.*

1. WHEN `subscribe(resume_from)` is called and the event after `resume_from` is no longer held, THE stream SHALL report `gap = true`. **[gate]** `test_evicted_cursor_reports_gap`
2. WHEN `resume_from` is above the watermark (for example, the simulator restarted), THE stream SHALL report `gap = true`, because it can't vouch for the browser's position. **[new test]**
3. WHEN `resume_from = 0` and seq 1 is no longer held, THE stream SHALL report `gap = true`. 0 is not a special case. **[new test]**
4. WHEN there is a gap, THE server SHALL send `{"type":"gap","from":<resume_from>,"earliest":<oldest seq held>}` first, then the backlog it still holds, then live events. **[new test]**
5. WHEN the browser receives a gap frame, THE connection status SHALL become `gap`. **[gate]** vitest "a gap frame is surfaced"
6. THE `gap` status SHALL be sticky: reconnecting SHALL NOT bring back `live`. **[gate]** vitest "reconnecting after a gap…"
7. THE browser SHALL write off seqs `from+1 … earliest-1`, so that later resumes don't ask for them again.
8. WHEN a bar's `finished` or `failed` event fell inside the gap, THE bar SHALL stay `running` with no end until the page has re-read the snapshot. The screen doesn't claim to know it ended. **[manual]** gap knobs
9. WHEN a gap frame arrives, THE page SHALL re-read the snapshot and merge it forward-only *without moving the stream position* (so events still on their way still apply: QA-16), so a failure that happened inside the gap still gets its card and finished bars get their end from the server's record. The gap banner stays. (Added after QA review, QA-1.) **[new test]** + **[manual]**

### R5. Fold events in any order (rung 2, decision B)

*As a scientist, I want the timeline to be correct even when the network delivers events late, twice or out of order.*

1. THE state SHALL hold one attempt per `step_id + attempt` number. A retry adds an attempt and SHALL NOT replace the earlier one. **[gate]** "a retry does not erase…"
2. THE result SHALL be the same whatever order the events arrive in, and however many times each one arrives. **[gate]** "reordered and duplicated delivery converges"
3. An attempt's status SHALL only move forward: `dispatched` → `running` → `done` or `failed`.
4. `startedAt` SHALL come from the `step.started` event's own `at`, and `endedAt` from the `step.finished`/`step.failed` event's `at`, never from the arrival time.
5. WHILE an attempt has started but not finished, its `endedAt` SHALL be null. **[gate]** vitest + `acceptance.sh` gate 2
6. THE state SHALL ignore an event whose seq it has already applied. **[gate]**
7. THE state SHALL ignore an event whose `run_id` is not the current run.
8. THE state SHALL ignore frames it does not recognise without failing.
9. THE failure's `error` (code, instrument, detail, retryable, every `context` key) SHALL be kept intact on its attempt. A later attempt's success SHALL NOT clear it. **[gate]** "why a step failed"
10. WHEN a `step.refused` event arrives, THE matching attempt SHALL be marked `refused = true`, whatever order it arrives in relative to that attempt's `step.dispatched`.
11. THE run status SHALL only move forward: `created` → `running` → `blocked` → `completed`.
12. `selectTracks` SHALL return one track per device, in `DEVICES` order. No track SHALL show two attempts overlapping in time. **[gate]**

### R6. Use the snapshot correctly (rung 2, Q1, Q2)

1. `applySnapshot` SHALL record the snapshot's `seq`. Any event at or below it SHALL be ignored, since the snapshot already covers it. **[gate]** "events already covered by the snapshot are ignored"
2. `applySnapshot` SHALL merge with existing state using the same forward-only rules as events. An older snapshot SHALL NOT move anything backwards. **[new test]**
3. Steps in the snapshot whose status is `pending` SHALL NOT create an attempt (nothing has run on an instrument yet).
4. `RunPage` SHALL load the snapshot first and only then open the socket, so the first connection resumes from the snapshot's `seq`. (Its comment already says this; the code didn't do it.)
5. `selectResumeFrom` SHALL return the highest seq with nothing missing before it, counting the snapshot `seq` and written-off seqs as "had". After a clean run that is the last seq. **[gate]** (= 28 on the fixture; = 12 after `snapshotAt(12)`)

### R7. Notice a lost event (decision B)

1. WHEN a seq is missing AND 10 or more later events have arrived (decision O1: 10, not the original 5, so the reorder knob doesn't raise false alarms), THE connection SHALL report `stale` with the note "An update was lost in transit; this view may be incomplete." **[gate]** "a permanently missing event does not freeze the screen in silence"
2. Events after the hole SHALL still be applied immediately. Nothing waits for the hole. **[gate]** "the run keeps moving…"
3. WHEN the missing seq arrives (or is written off by a gap frame), THE hole warning SHALL clear.
4. A complete stream SHALL stay `live`. **[gate]**
5. WHEN a seq has been missing for 2 s of wall-clock time, THE connection SHALL report `stale` with the same note, however few later events have arrived (O5: at the end of a run there may be none to count). The page feeds the time in with `applyTick(state, now)`; `runState.ts` never reads a clock. **[new test]**
6. WHEN a missing seq is reported on a live connection, THE page SHALL reconnect once for that seq, resuming from below it, so the server replays it from its buffer (or sends a gap frame if it can't). **[manual]**

### R8. Say when the screen isn't being updated (rung 3)

1. WHEN the socket closes, THE connection status SHALL be `stale`. **[gate]** vitest + `check-disconnect.sh` gate 3
2. WHEN the socket opens, THE status SHALL be `live`, unless a gap or an open hole says otherwise.
3. WHEN the socket closes after a gap, THE status SHALL be `stale` (not updating is the more urgent fact), and the note SHALL also say part of the run was not recorded. On reopening it SHALL return to `gap`.

---

## Problem 2: make a failure actionable

### R9. Retry endpoint (decision D)

*As an integrator's script, I want a retry call with clear, machine-readable outcomes that's safe to repeat. As a scientist, I want my double-click not to start two retries.*

`POST /runs/{id}/steps/{step_id}/retry`, optional JSON body `{"attempt": n}` meaning "retry failed attempt n".

1. WHEN the body is empty, THE endpoint SHALL retry the step's current attempt if it has failed. **[gate]** `test_retry_endpoint_retries_the_step`
2. WHEN the retry is accepted, THE endpoint SHALL respond **202** with `{run_id, step_id, retrying_attempt, next_attempt, status, duplicate: false, message}`, and the step SHALL be `pending`. **[gate]**
3. WHEN the body names attempt n AND attempt n has already been retried, THE endpoint SHALL respond **202** with the same body but `duplicate: true`, and SHALL NOT create another attempt. **[new test]**
4. WHEN the step hasn't failed (and, if pinned, attempt n was never retried), THE endpoint SHALL respond **409** `STEP_NOT_FAILED` with the current step, and SHALL NOT change the step. **[gate]**
5. WHEN the failure is not retryable, THE endpoint SHALL respond **422** `NOT_RETRYABLE` with the instrument's error, and SHALL NOT change the step. This SHALL be enforced on the server. **[new test]**
6. WHEN the run or step doesn't exist, THE endpoint SHALL respond **404** `UNKNOWN_RUN` / `UNKNOWN_STEP`. **[new test]**
7. WHEN the body is not valid JSON, is not an object, has a field other than `attempt`, or `attempt` is not a positive whole number, THE endpoint SHALL respond **400** `INVALID_BODY`. **[new test]**
8. Every error body SHALL have `{"code": …, "message": …}` plus any details.
9. Checking the pinned attempt, checking `retryable` and claiming the retry SHALL happen in one locked step, so two callers can't both win. **[new test]** concurrent calls → one `duplicate: false`
10. THE browser SHALL always send the attempt it is looking at.

### R10. Where failures show up (decision E)

*As a scientist at the bench, I want a failure to be impossible to miss and its explanation one glance away.*

1. WHILE at least one failure is actionable (R11), THE page SHALL show a "Needs attention" panel between the connection banner and the timeline; otherwise the panel SHALL NOT be shown. `data-testid="needs-attention"`
2. Each actionable failure SHALL have a card showing: the step, the attempt, the instrument, when it failed, the error code, the instrument's own explanation (`detail`), and the instrument details (R13). `data-testid="failure-card"`
3. WHEN the user clicks any bar (including an older, superseded failure), THE page SHALL show that attempt's details below the timeline. `data-testid="attempt-detail"`
4. WHEN a failed attempt has been superseded, its detail SHALL say "Superseded by attempt #n".
5. Existing test ids and the bar's `data-*` attributes SHALL stay unchanged. **[gate]** e2e

### R11. Which failures need action (decision F)

1. A failure SHALL be actionable when it is the step's latest attempt, it has failed, and no retry is in flight.
2. IT SHALL appear as soon as `step.failed` arrives, without waiting for `run.blocked`.
3. WHEN a newer attempt of the same step exists, THE older failure SHALL become history: its red bar stays, but it leaves the panel.
4. This SHALL be a new selector over the same state. `selectTracks` keeps every attempt and its error. **[new test]**

### R12. Between the click and the stream (decision G, Q4)

*As a scientist, I want to know my click was received, and never be told the instrument is running again before it actually is.*

1. WHEN Retry is clicked, THE card SHALL show "Retry requested", disable the button, and send the request with the attempt number.
2. WHEN the server answers 202, THE card SHALL show "Accepted, waiting for the instrument".
3. WHEN `step.refused` arrives for the next attempt, THE card SHALL show "Queued, instrument busy".
4. WHEN `step.dispatched` arrives for the next attempt, THE card SHALL leave the panel.
5. WHEN no such event has arrived 10 s after the 202, OR the connection is not `live` while a retry is in flight, THE card SHALL show "Not confirmed yet; this screen isn't receiving updates".
6. WHEN the server answers with an error, THE card SHALL show the server's message and enable the button again (except for 422, which switches the card to the not-retryable view, R14).
7. THE timeline SHALL NOT change until real events arrive.
8. WHEN a `step.refused` for the next attempt arrives without a click from this screen (someone else retried), THE card SHALL show "Queued, instrument busy" and the button SHALL be disabled.
9. This retry state SHALL live in `runState.ts` as plain functions, with the 10 s rule as a selector that takes the current time. **[new test]** for each step of the ladder

### R13. Instrument details: `context` (decision H, Q3)

*As a scientist, I want to read what the instrument reported without knowing its internal key names. As an integrator, I want the raw data.*

1. THE card SHALL list every `context` key, in the order received. No key SHALL be dropped. There are no per-instrument templates.
2. Each label SHALL be tidied (`actual_c` → "Actual (°C)", `_s` → "(s)", `_ul` → "(µL)", `_days` → "(days)", underscores → spaces, first letter capitalised), with the raw key shown beside it.
3. Values SHALL be formatted by type: numbers as written, booleans as Yes/No, null as "—", strings as written.
4. WHEN a value is an object or a list, IT SHALL be shown in readable form: a labelled, bordered box with its own rows (lists as numbered items), nested as deep as the data goes, using the same label and value rules.
5. The section SHALL be titled "Instrument details", open by default, with a "Copy JSON" button that copies the full `error` object. `data-testid="instrument-details"`, `data-testid="copy-json"`
6. An empty or missing `context` SHALL show "The instrument reported no further details."

### R14. When a retry won't help (decision I)

*As a scientist, I want to know a retry will fail the same way and what to do instead.*

1. WHEN `retryable` is false, THE card SHALL NOT show a Retry button.
2. IT SHALL explain: "Retrying won't help: this instrument will fail the same way until it is serviced."
3. IT SHALL show the instrument details (R13), including e.g. `service_ticket`.
4. IT SHALL offer "Copy report for service" that copies run, step, attempt, instrument, time and the full error as text. `data-testid="copy-service-report"`
5. IT SHALL state "The run can't finish until this is fixed. Completed steps are kept." (Changed from "The run stays blocked": a step can fail while other steps are still running, so the run is not always blocked yet when the card appears.)
6. IT SHALL look visibly different from a retryable card (different colour and icon/label), not just lack a button.

### R15. The note (required)

1. `NOTES.md` SHALL start with time spent, then about 400 words on: what we deliberately didn't build; where the state layer is most likely to break; what happens with an event for a never-seen step; what to change or keep in the event contract and endpoint. It SHALL end with blunt feedback on the exercise.

---

## Out of scope (deliberately not built; goes in NOTES.md)

- Detecting a lost *final* event (O6): needs a heartbeat with the stream position in the contract.
- Getting back the retry history a late-joining browser can't see (the snapshot only keeps the latest attempt).
- Auth, multiple runs per page, persistence across server restarts, an `Idempotency-Key` header.
- Per-instrument layouts for `context`.

## Decisions this spec rests on

| ID | Decision | Where |
|---|---|---|
| A | Slow viewer: 256 / 2 s grace / 512 hard limit, then disconnect | R3 |
| B | Apply now, order-proof merge, hole → `stale` after 10 (O1), resume = contiguous high point | R5, R6.5, R7 |
| C | Gap frame, then backlog, then live; sticky; write off the missing range | R4 |
| D | Idempotent-per-attempt retry endpoint, optional body | R9 |
| E | "Needs attention" panel and click-a-bar detail | R10 |
| F | Actionable = latest attempt failed and no retry in flight | R11 |
| G | Requested-state ladder; the timeline only moves on real events | R12 |
| H | Generic `context` list with tidied labels and Copy JSON | R13 |
| I | Not retryable: explain, details, copy report, distinct styling | R14 |
| Q1 | Strict gap rule (above watermark and 0-after-eviction are gaps) and fix RunPage's snapshot/socket race | R4.2, R4.3, R6.4 |
| Q2 | A late snapshot merges forward-only | R6.2 |
| Q3 | Nested `context` values shown as labelled boxes, not raw JSON | R13.4 |
| Q4 | Retry-in-flight state in `runState.ts` | R12.9 |
| O1 | Hole tolerance raised from 5 to 10 later events | R7.1 |
