# Lab Run Monitor — Solution Outline

> **Status:** draft v0.1 · 2026-10-21
> **Purpose:** describe the system as it is today (components, data flow, user flows), name the gaps, and outline the target solution. Open design decisions are listed in §8 and are **not yet made**; anything marked _draft_ shows the current recommendation only.
>
> Diagrams are Mermaid and render on GitHub. In a sequence diagram each vertical line is a **swimlane** for one component; time runs top to bottom.

---

## 1. What the system is

A slice of a lab automation platform. A **run** executes a **workflow** of steps on robotic **instruments**; a scientist watches it on a **timeline** (one lane per instrument, one bar per attempt).

| Half | Tech | Where | Role |
|---|---|---|---|
| Simulator | Python · FastAPI · asyncio | `simulator/`, Docker, port 5002 | Plays the lab: runs the workflow, emits events, serves HTTP + WebSocket |
| Web app | React · TypeScript · Vite · Tailwind | `web/`, port 3000 | Loads a snapshot, listens to events, draws the timeline |

---

## 2. Components

Yellow = files the exercise asks us to write. Everything else is provided.

```mermaid
flowchart LR
  subgraph Browser["Browser - web/ - port 3000"]
    RP["RunPage.tsx<br/>wires everything together"]
    AP["api.ts<br/>HTTP calls"]
    SK["socket.ts<br/>connect + reconnect with backoff"]
    RS["runState.ts<br/>state layer"]
    TL["Timeline.tsx + Banner.tsx<br/>drawing"]
  end
  subgraph Sim["Simulator - simulator/ - Docker - port 5002"]
    API["api.py<br/>HTTP routes + WebSocket<br/>one TASK block"]
    RT["retry.py<br/>retry endpoint"]
    EN["engine.py<br/>run engine"]
    WF["workflow.py<br/>recipe + instrument faults"]
    ST["stream.py<br/>event stream"]
  end
  RP --> AP
  RP --> SK
  RP --> RS
  RS --> TL
  AP -->|"HTTP: create, start, snapshot, retry"| API
  SK <-->|"WebSocket /ws ?run_id ?resume_from"| API
  API --> EN
  API --> RT
  RT --> EN
  WF --> EN
  EN -->|"publish(event)"| ST
  API -->|"subscribe(resume_from), watermark()"| ST

  classDef you fill:#fde68a,stroke:#b45309,color:#111
  class RS,ST,RT,API you
```

### 2.1 The workflow (a DAG)

Arrows mean "must finish before". Three steps share the liquid handler and two share the incubator, so steps queue for a busy instrument (`step.refused`) as a normal part of a run.

```mermaid
flowchart LR
  FS["fill_sample_plate<br/>liquid handler - 2s"] --> IS["incubate_samples<br/>incubator - 4s"]
  FS --> FR["fill_reagent_plate<br/>liquid handler - 2s"]
  FS --> FB["fill_buffer_plate<br/>liquid handler - 2s"]
  FR --> WR["warm_reagent_plate<br/>incubator - 3s"]
  IS --> CB["combine<br/>liquid handler - 2s"]
  WR --> CB
  FB --> CB
  CB --> RD["read_plate<br/>plate reader - 2s"]
```

### 2.2 Lifecycle of one step (engine.py)

```mermaid
stateDiagram-v2
  [*] --> pending
  pending --> pending: device busy, emits step.refused once
  pending --> dispatched: deps done and device free, attempt + 1, emits step.dispatched
  dispatched --> running: next tick, emits step.started
  running --> done: duration elapsed, emits step.finished
  running --> failed: instrument fault, emits step.failed with error
  failed --> pending: operator retry via claim_retry, emits nothing
  done --> [*]
```

### 2.3 Lifecycle of a run

```mermaid
stateDiagram-v2
  [*] --> created: POST /runs
  created --> running: POST /runs/id/start
  running --> completed: every step done, emits run.completed
  running --> blocked: a step failed and nothing else can progress, emits run.blocked
  blocked --> completed: after a successful retry, emits run.completed
  completed --> [*]
```

Note: after a retry the run status stays `blocked` until it completes. There is no "unblocked" event.

---

## 3. Current data flow (as-is)

### 3.1 Swimlane: the life of one event

Red = where the chain is broken today.

```mermaid
flowchart LR
  subgraph EN["Engine - engine.py"]
    E1["tick every 100 ms<br/>update steps under run.lock"] --> E2["collect events<br/>seq = 0"]
  end
  subgraph ST["Stream - stream.py"]
    S1["publish(event)<br/>no seq assigned<br/>no history kept"] --> S2{"viewer queue<br/>full?"}
    S2 -->|no| S3["put on each<br/>viewer's queue"]
    S2 -->|yes| S4["event silently dropped<br/>for that viewer"]
  end
  subgraph WS["WebSocket - api.py"]
    W1["take from queue"] --> W2["chaos knobs: may hold back<br/>or send twice"] --> W3["send JSON frame"]
  end
  subgraph SK["Browser socket - socket.ts"]
    C1["parse JSON"] --> C2["onMessage(frame)"]
  end
  subgraph RS["State layer - runState.ts"]
    R1["applyMessage<br/>stub: returns state unchanged"]
  end
  subgraph TL["Screen - Timeline + Banner"]
    V1["selectTracks returns nothing<br/>blank timeline, no banner"]
  end
  E2 --> S1
  S3 --> W1
  W3 --> C1
  C2 --> R1
  R1 --> V1

  classDef broken fill:#fee2e2,stroke:#b91c1c,color:#111
  class E2,S1,S4,R1,V1 broken
```

### 3.2 Swimlane: starting a run and the first load

```mermaid
sequenceDiagram
  autonumber
  actor Sci as Scientist
  participant UI as RunPage.tsx
  participant RS as runState.ts
  participant SK as socket.ts
  participant API as api.py
  participant EN as engine.py
  participant ST as stream.py
  Sci->>UI: click Start a run
  UI->>API: POST /runs
  API->>ST: create Stream(buffer size)
  API->>EN: new_run(r-1)
  API-->>UI: 201 id r-1
  par snapshot and socket start at the same moment
    UI->>API: GET /runs/r-1
    API->>ST: watermark()
    ST-->>API: 0 (always, today)
    API-->>UI: seq 0 + run status + steps
    UI->>RS: applySnapshot (stub, ignored)
  and
    UI->>SK: connect(r-1)
    SK->>RS: selectResumeFrom()
    RS-->>SK: 0 (stub)
    SK->>API: WS /ws?run_id=r-1 and resume_from=0
    API->>ST: subscribe(0)
    ST-->>API: backlog empty, gap false (always, today)
    SK->>RS: applyTransport(open) (stub)
  end
  UI->>API: POST /runs/r-1/start
  API->>EN: start() begins the 100 ms tick loop
  API-->>UI: 202 running
```

### 3.3 Swimlane: events during a run

```mermaid
sequenceDiagram
  participant EN as engine.py
  participant ST as stream.py
  participant WS as api.py WebSocket
  participant SK as socket.ts
  participant RS as runState.ts
  participant TL as Timeline + Banner
  loop every 100 ms tick
    EN->>EN: advance steps under run.lock
    EN->>ST: publish(event) with seq 0
    Note over ST: not numbered, not remembered
    ST->>WS: put on each connected viewer's queue
    WS->>SK: JSON frame (chaos may reorder or duplicate)
    SK->>RS: applyMessage(frame)
    Note over RS: stub, frame discarded
    RS->>TL: selectTracks() returns nothing
  end
```

### 3.4 Swimlane: the connection drops (today)

```mermaid
sequenceDiagram
  participant EN as engine.py
  participant ST as stream.py
  participant WS as api.py WebSocket
  participant SK as socket.ts
  participant RS as runState.ts
  EN->>ST: publish events 1 to 10
  ST->>WS: delivered
  WS->>SK: delivered
  Note over WS,SK: socket dropped (SOCKET_KILL_MS)
  WS--xSK: close 1001
  SK->>RS: applyTransport(closed) (stub, screen still claims nothing changed)
  EN->>ST: publish events 11 to 20
  Note over ST: nobody connected, events gone for good
  SK->>WS: reconnect after 250 ms backoff, resume_from=0
  alt SOCKET_REJECT_MS still active
    WS--xSK: close 1013 try later
  else accepted
    WS->>ST: subscribe(0)
    ST-->>WS: backlog empty, gap false
    WS->>SK: events 21 onwards only
    Note over SK,RS: 11 to 20 missing and nobody is told. Looks correct, is not.
  end
```

### 3.5 Swimlane: a step fails (today)

```mermaid
sequenceDiagram
  actor Sci as Scientist
  actor Int as Integrator script
  participant UI as Browser
  participant API as api.py
  participant RT as retry.py
  participant EN as engine.py
  participant ST as stream.py
  EN->>ST: step.failed warm_reagent_plate attempt 1, error with code, detail, retryable, context
  ST->>UI: event
  Note over UI: at best a red bar. No reason, no action.
  EN->>ST: run.blocked once nothing else can progress
  ST->>UI: event
  Sci-->>UI: no way to retry from the screen
  Int->>API: POST /runs/r-1/steps/warm_reagent_plate/retry
  API->>RT: handle_retry(run, step)
  RT-->>API: 501 not implemented
  API-->>Int: 501
  Note over RT,EN: claim_retry (failed to pending, atomic) exists but nothing calls it
  Note over EN: when it is called, no event is emitted. The first sign is step.dispatched for attempt 2.
```

---

## 4. Current user flows (as-is)

### 4.1 Scientist at the bench

```mermaid
flowchart TD
  A(["Opens localhost:3000"]) --> B["Clicks Start a run"]
  B --> C["Header shows r-1 - unknown"]
  C --> D["Timeline stays blank<br/>state layer is a stub"]
  D --> E{"Connection drops?"}
  E -->|yes| F["Nothing says so<br/>no banner, missed steps never appear"]
  E -->|no| G{"A step fails?"}
  F --> G
  G -->|yes| H["At best a red bar<br/>no reason, no detail, no button"]
  H --> I(["Has to find someone with API access<br/>or start the whole run again"])
  G -->|no| J(["Run completes, but the screen never shows it"])

  classDef broken fill:#fee2e2,stroke:#b91c1c,color:#111
  class C,D,F,H,I,J broken
```

### 4.2 Integrator's script

```mermaid
flowchart TD
  A(["Script creates and starts a run<br/>POST /runs then POST /runs/id/start"]) --> B["Watches GET /runs/id or the /ws stream"]
  B --> C{"Sees run.blocked<br/>or status blocked"}
  C --> D["Reads step error from snapshot or event"]
  D --> E["POST /runs/id/steps/step/retry"]
  E --> F["501 Not Implemented"]
  F --> G(["Dead end: no contract for status codes, body,<br/>repeat calls or non-retryable faults"])

  classDef broken fill:#fee2e2,stroke:#b91c1c,color:#111
  class F,G broken
```

---

## 5. Gap analysis

| # | Gap | Where | Fixed by |
|---|---|---|---|
| G1 | Every event has `seq: 0` | `stream.py` | Problem 1, rung 1 |
| G2 | No history, so nothing can be replayed | `stream.py` | Rung 1 (buffer) + rung 3 |
| G3 | `watermark()` always 0, so the snapshot can't say where it sits | `stream.py` | Rung 1 |
| G4 | A slow viewer silently loses events | `stream.py` | Rung 1 (decision A) |
| G5 | State layer discards everything, so the timeline is blank | `runState.ts` | Rung 2 |
| G6 | Late, duplicate and out-of-order events not handled | `runState.ts` | Rung 2 (decision B) |
| G7 | Reconnect resumes from 0 and loses the window | `runState.ts`, `stream.py` | Rung 3 |
| G8 | Disconnect not shown on screen | `runState.ts` | Rung 3/4 |
| G9 | Unservable resume is silent | `api.py` TASK, `runState.ts` | Rung 4 (decision C) |
| G10 | Retry endpoint returns 501 | `retry.py` | Problem 2 (decision D) |
| G11 | Failure shows only a red bar | new UI | Problem 2 (decisions E to I) |

**Found while reading the code, not stated in the brief:**

- **The snapshot drops retry history.** `GET /runs/id` holds only each step's latest attempt, and `claim_retry` clears the error. A browser that loads after a retry cannot see the first failure or its reason; only the event stream carries it.
- **Snapshot and socket race.** `RunPage` fetches the snapshot and opens the socket at the same time, so events can arrive before the snapshot. The state layer has to accept either order.
- **A retry is silent.** `claim_retry` emits no event. The screen's only confirmation is a later `step.dispatched` for the next attempt, which may itself wait behind a busy instrument (`step.refused`).
- **The run stays `blocked`** while a retried step runs, until `run.completed`.
- **`step.refused` carries the next attempt number** (`attempt + 1`), not the current one.
- **README typo:** `cd ../web` should be `cd web`.

---

## 6. Target solution outline

### 6.1 Changes by component

| Component | Change | Rung / problem |
|---|---|---|
| `stream.py` | Under one lock: assign `seq = last + 1`, append to a fixed-size buffer (oldest evicted), hand to subscribers. `subscribe(resume_from)` computes backlog (`seq > resume_from`) and `gap` (the next needed event is already evicted) and registers the viewer **atomically**, so nothing is missed or doubled between replay and live. Real `watermark()` and `earliest()`. Slow-viewer policy per decision A. | Rung 1, 3 |
| `api.py` (TASK) | On `gap`, tell the client before sending the backlog. Shape per decision C. | Rung 4 |
| `runState.ts` | Attempts keyed by `step + attempt`. Order-proof merge (status only moves forward, times from each event's own `at`). Ignore duplicates and anything at or below the snapshot's `seq`. Resume from the highest `seq` applied. Missing numbers per decision B. Socket closed → `stale`. Gap frame → `gap`, sticky across reconnects. Unknown frames ignored safely. Error and `context` kept intact. | Rung 2, 3, 4 |
| `retry.py` | HTTP contract per decision D, built on `claim_retry`. | Problem 2 |
| New UI | Failure surface per decisions E to I. | Problem 2 |
| `NOTES.md` | Time spent, four questions, feedback on the exercise. | Required |

### 6.2 Target swimlane: reconnect and resume (rung 3)

```mermaid
sequenceDiagram
  participant ST as stream.py
  participant WS as api.py WebSocket
  participant SK as socket.ts
  participant RS as runState.ts
  participant TL as Timeline + Banner
  Note over ST: every event gets seq 1, 2, 3 and the last N are kept
  WS->>SK: events seq 1 to 10
  SK->>RS: applyMessage, lastSeq = 10
  Note over WS,SK: socket dropped
  SK->>RS: applyTransport(closed)
  RS->>TL: status stale, banner says not updating
  Note over ST: events 11 to 20 published and buffered
  SK->>RS: selectResumeFrom()
  RS-->>SK: 10
  SK->>WS: WS /ws?resume_from=10
  WS->>ST: subscribe(10)
  ST-->>WS: backlog 11 to 20, gap false
  WS->>SK: replay 11 to 20, then live from 21
  SK->>RS: applyTransport(open) then applyMessage for each
  RS->>TL: status live, banner hidden, nothing missing
```

### 6.3 Target swimlane: the gap cannot be served (rung 4) — _draft, depends on decision C_

```mermaid
sequenceDiagram
  participant ST as stream.py
  participant WS as api.py WebSocket
  participant SK as socket.ts
  participant RS as runState.ts
  participant TL as Timeline + Banner
  Note over SK: away long enough for the buffer to move past seq 10
  SK->>WS: WS /ws?resume_from=10
  WS->>ST: subscribe(10)
  ST-->>WS: gap true, earliest 40, backlog 40 onwards
  WS->>SK: frame type gap, from 10, earliest 40
  SK->>RS: applyMessage(gap)
  RS->>TL: status gap (sticky), banner says part of the run was not recorded
  WS->>SK: backlog 40 onwards, then live
  Note over TL: bars whose finish fell in the gap stay running, because the screen does not know they ended
```

### 6.4 Target swimlane: retry a failed step (problem 2) — _draft, depends on decisions D and G_

```mermaid
sequenceDiagram
  actor Sci as Scientist
  participant UI as Failure surface
  participant RS as runState.ts
  participant API as api.py + retry.py
  participant EN as engine.py
  participant ST as stream.py
  EN->>ST: step.failed attempt 1 with error
  ST->>RS: event, error and context kept
  RS->>UI: actionable failure, retryable true
  Sci->>UI: Retry
  UI->>UI: show retry requested, waiting for the instrument
  UI->>API: POST retry for attempt 1
  API->>EN: claim_retry (atomic failed to pending)
  API-->>UI: 202 accepted, next attempt 2
  Note over UI: still only requested. Nothing is confirmed until events arrive.
  EN->>ST: step.dispatched attempt 2
  ST->>RS: event
  RS->>UI: attempt 2 is on the timeline, failure 1 kept as history
  Sci->>UI: double click or repeat request
  UI->>API: POST retry for attempt 1 again
  API-->>UI: same answer as before, no second attempt
```

### 6.5 Target user flow: scientist handling a failure — _draft, depends on decisions E to I_

```mermaid
flowchart TD
  A(["Run is going"]) --> B{"A step fails"}
  B --> C["Bar turns red and the failure is called out<br/>where the scientist will see it"]
  C --> D["Sees what failed, on which instrument,<br/>the instrument's own explanation and details"]
  D --> E{"Can it be retried?"}
  E -->|yes| F["Fix the cause at the bench<br/>then press Retry"]
  F --> G["Screen shows retry requested<br/>until the instrument confirms"]
  G --> H{"Attempt 2 outcome"}
  H -->|done| I(["Run continues. Failure stays in history,<br/>no longer asks for action"])
  H -->|fails again| C
  E -->|no| J["No retry button. Screen says why,<br/>and what to do instead, for example the service ticket"]
  J --> K(["Run stays blocked until the instrument is fixed"])
```

### 6.6 Target user flow: integrator's script — _draft, depends on decision D_

```mermaid
flowchart TD
  A(["Script sees run.blocked"]) --> B["Reads the failed attempt's error"]
  B --> C{"retryable?"}
  C -->|no| D(["Raise to a human with code, detail and context"])
  C -->|yes| E["POST retry naming the failed attempt"]
  E --> F{"Response"}
  F -->|"202 accepted"| G["Wait for step.dispatched for the new attempt"]
  F -->|"repeat of the same request"| G
  F -->|"409 step is not failed"| H(["Someone else already acted. Re-read state."])
  F -->|"422 not retryable"| D
  F -->|"404 unknown step or run"| I(["Bug in the script"])
  F -->|"network error"| E
```

---

## 7. How we check it

| Command | Covers |
|---|---|
| `uv run pytest` | Stream numbering, resume, gap, stalled viewer; retry endpoint works |
| `cd web && pnpm test` | State layer: ordering, duplicates, retries, snapshot watermark, holes, connection honesty |
| `./scripts/acceptance.sh` | Timeline during a clean run (needs simulator + web running) |
| `./scripts/check-disconnect.sh` | Dropped connection is admitted, run still finishes |
| `cd web && pnpm check` | eslint + prettier |

Problem 2 is mostly ungated; we check it by running the three `FAIL_STEP` scenarios and looking at the screen.

---

## 8. Decisions register

All **pending**. Each has three options; the recommendation is listed first.

| ID | Decision | Options (recommended first) | Status |
|---|---|---|---|
| A | Slow viewer whose queue fills (`stream.py`) | 1. Disconnect it; it resumes from the buffer or is told about a gap · 2. Unbounded queue · 3. Drop events and flag a gap inline | Pending |
| B | Out-of-order and missing events (`runState.ts`) | 1. Apply now with an order-proof merge, track holes, stop claiming `live` if a hole persists · 2. Hold back and release in order, write off after N events · 3. Hold back with a timer | Pending |
| C | Unservable resume (`api.py` TASK) | 1. Send a gap frame, then what is still held; sticky banner · 2. Same, plus re-fetch the snapshot to repair current state · 3. Close the socket and reset the client | Pending |
| D | Retry endpoint contract (`retry.py`) | 1. Idempotent per attempt: 202 / same answer on repeat / 409 / 422 / 404 · 2. Simple 202 then 409 · 3. Idempotency-Key header | Pending |
| E | Where failures live on screen | To be framed at spec stage | Open |
| F | Which failures are actionable (failed then retried) | To be framed at spec stage | Open |
| G | What the screen claims between click and stream | To be framed at spec stage | Open |
| H | Showing `context` with unknown keys | To be framed at spec stage | Open |
| I | What to offer when `retryable` is false | To be framed at spec stage | Open |

---

## 9. Delivery order

1. `git init`, commit the untouched starter so the diff shows our work.
2. Settle decisions A to D, write `SPEC.md`.
3. Rung 1 (`stream.py`) → `uv run pytest`.
4. Rung 2 (`runState.ts`) → `pnpm test`.
5. Problem 2: endpoint, then failure surface (decisions E to I first).
6. Rungs 3 and 4 (smaller once 1 and 2 exist) → both scripts.
7. `NOTES.md`, kept as a running log throughout and finished with time to spare.
