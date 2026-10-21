"""Checks for the behaviour in docs/spec/requirements.md that the provided gates
do not cover. Requirement ids are in each test's docstring."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi.testclient import TestClient

from simulator.api import Config, create_app
from simulator.engine import DISPATCHED, DONE, FAILED, PENDING, RUNNING, Run
from simulator.events import STEP_STARTED, Event, StepError
from simulator.stream import (
    SLOW_GRACE_S,
    SUBSCRIBER_HARD_LIMIT,
    SUBSCRIBER_QUEUE_SIZE,
    Stream,
)


def _event() -> Event:
    return Event(run_id="r-1", type=STEP_STARTED, at="2026-09-02T00:00:00Z")


async def _publish(stream: Stream, n: int) -> None:
    for _ in range(n):
        await stream.publish(_event())


def _drain(queue: asyncio.Queue[Event | None]) -> list[Event | None]:
    out: list[Event | None] = []
    while not queue.empty():
        out.append(queue.get_nowait())
    return out


class _Clock:
    """Stands in for the event loop's clock so the grace period can be tested
    without sleeping."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
async def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    c = _Clock()
    monkeypatch.setattr(asyncio.get_running_loop(), "time", c)
    return c


# ---------------------------------------------------------------------------
# R3: a slow viewer
# ---------------------------------------------------------------------------


async def test_hard_limit_disconnects_at_once(clock: _Clock) -> None:
    """R3.3: over SUBSCRIBER_HARD_LIMIT queued is cut off, grace or not."""
    stream = Stream(4096)
    stalled = await stream.subscribe(0)

    await _publish(stream, SUBSCRIBER_HARD_LIMIT)
    assert stalled.queue.qsize() == SUBSCRIBER_HARD_LIMIT, "at the limit is still allowed"

    await _publish(stream, 1)
    assert _drain(stalled.queue) == [None], "over the limit: cleared and ended"


async def test_grace_period_then_disconnect(clock: _Clock) -> None:
    """R3.2, R3.3: over SUBSCRIBER_QUEUE_SIZE starts a clock; still over when it
    runs out means disconnect."""
    stream = Stream(4096)
    slow = await stream.subscribe(0)

    await _publish(stream, SUBSCRIBER_QUEUE_SIZE + 1)
    clock.now += SLOW_GRACE_S - 0.01
    await _publish(stream, 1)
    assert None not in _peek(slow.queue), "still inside the grace period"

    clock.now += 0.01
    await _publish(stream, 1)
    assert _drain(slow.queue) == [None]


async def test_grace_clock_resets_when_viewer_catches_up(clock: _Clock) -> None:
    """R3.4: dropping back to the limit cancels the clock."""
    stream = Stream(4096)
    slow = await stream.subscribe(0)

    await _publish(stream, SUBSCRIBER_QUEUE_SIZE + 1)  # clock starts
    for _ in range(10):
        slow.queue.get_nowait()
    await _publish(stream, 1)  # back under: clock cancelled
    clock.now += SLOW_GRACE_S * 3
    await _publish(stream, 9)  # over again: a fresh clock, not the old one
    assert None not in _peek(slow.queue)


async def test_healthy_viewer_keeps_everything_while_stalled_one_is_cut_off() -> None:
    """R3.1, R3.6: a burst must not cost a reader that is keeping up."""
    stream = Stream(4096)
    healthy = await stream.subscribe(0)
    stalled = await stream.subscribe(0)
    got: list[int] = []

    async def read() -> None:
        while len(got) < 2000:
            event = await healthy.queue.get()
            assert event is not None, f"healthy viewer was cut off after {len(got)}"
            got.append(event.seq)

    reader = asyncio.create_task(read())
    await _publish(stream, 2000)
    await asyncio.wait_for(reader, timeout=5)

    assert got == list(range(1, 2001))
    assert _drain(stalled.queue) == [None]


# ---------------------------------------------------------------------------
# R2, R4: resume and gap
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("buf", "published", "resume_from", "want_gap", "want_backlog"),
    [
        (64, 10, 4, False, [5, 6, 7, 8, 9, 10]),  # normal resume
        (64, 10, 10, False, []),  # up to date
        (64, 10, 0, False, list(range(1, 11))),  # first connect, nothing evicted
        (64, 0, 0, False, []),  # nothing published yet
        (4, 20, 1, True, [17, 18, 19, 20]),  # evicted
        (4, 10, 0, True, [7, 8, 9, 10]),  # R4.3: first connect after eviction
        (4, 10, 6, False, [7, 8, 9, 10]),  # oldest still needed is held
        (64, 3, 50, True, []),  # R4.2: ahead of the server (restart)
    ],
)
async def test_resume_and_gap_rules(
    buf: int,
    published: int,
    resume_from: int,
    want_gap: bool,
    want_backlog: list[int],
) -> None:
    """R2.2, R4.1-R4.3: the table in design section 2.3."""
    stream = Stream(buf)
    await _publish(stream, published)
    sub = await stream.subscribe(resume_from)
    assert sub.gap is want_gap
    assert [e.seq for e in sub.backlog] == want_backlog
    sub.cancel()


async def test_earliest_is_captured_with_the_backlog() -> None:
    """R4.4: the gap frame's `earliest` must agree with the replay that follows."""
    stream = Stream(4)
    await _publish(stream, 20)
    sub = await stream.subscribe(1)
    assert sub.earliest == sub.backlog[0].seq == 17
    assert await stream.earliest() == 17
    assert await stream.watermark() == 20
    sub.cancel()


async def test_subscribing_mid_run_loses_and_doubles_nothing() -> None:
    """R2.3: replay and live join with no hole and no repeat, however the
    subscribe lands among the publishes."""
    stream = Stream(4096)
    total = 500
    subs = []

    async def publisher() -> None:
        await _publish(stream, total)

    async def subscriber(i: int) -> None:
        for _ in range(i * 5):
            await asyncio.sleep(0)
        # Never ahead of the stream: that is a gap by design (R4.2).
        resume_from = min(i * 3, await stream.watermark())
        subs.append((resume_from, await stream.subscribe(resume_from)))

    await asyncio.gather(publisher(), *(subscriber(i) for i in range(15)))
    assert len({r for r, _ in subs}) > 5, "subscribes should land at different points"

    for resume_from, sub in subs:
        seqs = [e.seq for e in sub.backlog]
        seqs += [e.seq for e in _drain(sub.queue) if e is not None]
        assert seqs == list(range(resume_from + 1, total + 1)), f"resume_from={resume_from}"
        sub.cancel()


def _peek(queue: asyncio.Queue[Event | None]) -> list[Event | None]:
    items = _drain(queue)
    for item in items:
        queue.put_nowait(item)
    return items


# ---------------------------------------------------------------------------
# R9: the retry endpoint (design section 4.1)
# ---------------------------------------------------------------------------

STEP = "warm_reagent_plate"


@pytest.fixture
async def api() -> AsyncIterator[tuple[httpx.AsyncClient, Run]]:
    """A client and a fresh run that has not been started, so tests set step
    state by hand and the engine never moves it underneath them."""
    app = create_app(Config(replay_buffer_size=64))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sim") as client:
        run_id = (await client.post("/runs")).json()["id"]
        yield client, app.state.server.runs[run_id]


async def _set(run: Run, status: str, attempt: int, error: StepError | None = None) -> None:
    async with run.lock:
        step = run.steps[STEP]
        step.status, step.attempt, step.error = status, attempt, error
        step.ended_at = "2026-09-02T00:00:03Z" if status == FAILED else None


def _fault(retryable: bool) -> StepError:
    return StepError(
        code="SETPOINT_NOT_REACHED" if retryable else "CALIBRATION_EXPIRED",
        instrument="incubator-1",
        detail="it went wrong",
        retryable=retryable,
        context={"actual_c": 31.2},
    )


def _url(run: Run, step: str = STEP) -> str:
    return f"/runs/{run.id}/steps/{step}/retry"


async def test_retry_accepts_a_failed_step_with_no_body(
    api: tuple[httpx.AsyncClient, Run],
) -> None:
    """R9.1, R9.2."""
    client, run = api
    await _set(run, FAILED, 1, _fault(retryable=True))

    res = await client.post(_url(run))

    assert res.status_code == 202
    assert res.json() == {
        "run_id": run.id,
        "step_id": STEP,
        "retrying_attempt": 1,
        "next_attempt": 2,
        "status": PENDING,
        "duplicate": False,
        "message": "Retry accepted. Attempt 2 will start when incubator-1 is free.",
    }
    assert run.steps[STEP].status == PENDING
    assert run.steps[STEP].error is None


async def test_repeating_a_pinned_retry_is_a_duplicate_not_a_new_attempt(
    api: tuple[httpx.AsyncClient, Run],
) -> None:
    """R9.3: a double click, or a script retrying after a timeout."""
    client, run = api
    await _set(run, FAILED, 1, _fault(retryable=True))

    first = await client.post(_url(run), json={"attempt": 1})
    again = await client.post(_url(run), json={"attempt": 1})

    assert first.status_code == again.status_code == 202
    assert first.json()["duplicate"] is False
    assert again.json()["duplicate"] is True
    assert again.json()["next_attempt"] == 2
    assert (run.steps[STEP].status, run.steps[STEP].attempt) == (PENDING, 1)


@pytest.mark.parametrize("status", [DISPATCHED, RUNNING, DONE, FAILED])
async def test_a_pinned_retry_of_a_superseded_attempt_is_a_duplicate(
    api: tuple[httpx.AsyncClient, Run], status: str
) -> None:
    """R9.3: attempt 2 exists in any state, so retrying 1 already happened.
    Even when attempt 2 has failed too: that one needs its own decision."""
    client, run = api
    await _set(run, status, 2, _fault(retryable=True) if status == FAILED else None)

    res = await client.post(_url(run), json={"attempt": 1})

    assert res.status_code == 202
    assert res.json()["duplicate"] is True
    assert (run.steps[STEP].status, run.steps[STEP].attempt) == (status, 2)


async def test_an_unpinned_repeat_cannot_tell_and_says_not_failed(
    api: tuple[httpx.AsyncClient, Run],
) -> None:
    """R9.4: without the attempt, a repeat after success looks like a retry of
    a step that is not failed. That is why the browser always pins."""
    client, run = api
    await _set(run, FAILED, 1, _fault(retryable=True))
    await client.post(_url(run))

    res = await client.post(_url(run))

    assert res.status_code == 409
    assert res.json()["code"] == "STEP_NOT_FAILED"
    assert "attempt 2 is waiting to start" in res.json()["message"]


@pytest.mark.parametrize(
    ("status", "attempt", "body"),
    [
        (PENDING, 0, None),  # never ran
        (RUNNING, 1, None),
        (DONE, 1, {"attempt": 1}),
        (FAILED, 1, {"attempt": 2}),  # pinned to an attempt that does not exist
        (RUNNING, 1, {"attempt": 1}),  # attempt 1 is running, not failed
    ],
)
async def test_a_step_that_is_not_failed_is_left_alone(
    api: tuple[httpx.AsyncClient, Run],
    status: str,
    attempt: int,
    body: dict[str, int] | None,
) -> None:
    """R9.4."""
    client, run = api
    await _set(run, status, attempt, _fault(retryable=True) if status == FAILED else None)

    res = await client.post(_url(run), json=body) if body else await client.post(_url(run))

    assert res.status_code == 409
    assert res.json()["code"] == "STEP_NOT_FAILED"
    assert res.json()["step"]["status"] == status
    assert (run.steps[STEP].status, run.steps[STEP].attempt) == (status, attempt)


async def test_a_fault_that_retrying_cannot_fix_is_refused(
    api: tuple[httpx.AsyncClient, Run],
) -> None:
    """R9.5: enforced here, not left to the button."""
    client, run = api
    await _set(run, FAILED, 1, _fault(retryable=False))

    res = await client.post(_url(run), json={"attempt": 1})

    assert res.status_code == 422
    assert res.json()["code"] == "NOT_RETRYABLE"
    assert res.json()["error"]["code"] == "CALIBRATION_EXPIRED"
    assert res.json()["error"]["context"] == {"actual_c": 31.2}
    step = run.steps[STEP]
    assert step.status == FAILED and step.error is not None, "the step must be untouched"


async def test_unknown_run_and_step(api: tuple[httpx.AsyncClient, Run]) -> None:
    """R9.6."""
    client, run = api
    res = await client.post("/runs/r-99/steps/x/retry")
    assert (res.status_code, res.json()["code"]) == (404, "UNKNOWN_RUN")
    res = await client.post(_url(run, "spin_down"))
    assert (res.status_code, res.json()["code"]) == (404, "UNKNOWN_STEP")


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[1]",
        b'{"attempt": "1"}',
        b'{"attempt": true}',
        b'{"attempt": 0}',
        b'{"attempt": 1.5}',
        b'{"attempts": 1}',  # a typo must not silently become "unpinned"
    ],
)
async def test_a_malformed_body_is_rejected_and_changes_nothing(
    api: tuple[httpx.AsyncClient, Run], body: bytes
) -> None:
    """R9.7, R9.8."""
    client, run = api
    await _set(run, FAILED, 1, _fault(retryable=True))

    res = await client.post(_url(run), content=body)

    assert res.status_code == 400
    assert res.json()["code"] == "INVALID_BODY"
    assert res.json()["message"]
    assert run.steps[STEP].status == FAILED


async def test_an_empty_object_means_unpinned(api: tuple[httpx.AsyncClient, Run]) -> None:
    client, run = api
    await _set(run, FAILED, 1, _fault(retryable=True))
    res = await client.post(_url(run), json={})
    assert res.status_code == 202


async def test_concurrent_retries_claim_exactly_once(
    api: tuple[httpx.AsyncClient, Run],
) -> None:
    """R9.9: ten callers race for one failure; one wins, the rest are told it
    already happened."""
    client, run = api
    await _set(run, FAILED, 1, _fault(retryable=True))

    results = await asyncio.gather(
        *(client.post(_url(run), json={"attempt": 1}) for _ in range(10))
    )

    assert all(r.status_code == 202 for r in results)
    assert sorted(r.json()["duplicate"] for r in results) == [False] + [True] * 9


# ---------------------------------------------------------------------------
# R4.4: the gap frame on the wire (api.py TASK block)
# ---------------------------------------------------------------------------


def _ws_app(buf: int, published: int) -> tuple[TestClient, str]:
    """A test client with one run whose stream has `published` events in it.
    Events go in through the app's own event loop, as the engine's would."""
    app = create_app(Config(replay_buffer_size=buf))
    client = TestClient(app)
    client.__enter__()
    run_id = client.post("/runs").json()["id"]
    stream = app.state.server.streams[run_id]
    for _ in range(published):
        event = Event(run_id=run_id, type=STEP_STARTED, at="2026-09-02T00:00:00Z")
        assert client.portal is not None
        client.portal.call(stream.publish, event)
    return client, run_id


@pytest.mark.parametrize(
    ("resume_from", "earliest"),
    [
        (2, 7),  # evicted: the buffer holds 7-10
        (0, 7),  # a first connection is not special
        (50, 7),  # ahead of the server, e.g. after a restart
    ],
)
def test_an_unservable_resume_is_told_first_then_gets_what_is_held(
    resume_from: int, earliest: int
) -> None:
    client, run_id = _ws_app(buf=4, published=10)
    try:
        with client.websocket_connect(f"/ws?run_id={run_id}&resume_from={resume_from}") as ws:
            assert ws.receive_json() == {"type": "gap", "from": resume_from, "earliest": earliest}
            if resume_from < earliest:
                assert [ws.receive_json()["seq"] for _ in range(4)] == [7, 8, 9, 10]
    finally:
        client.__exit__(None, None, None)


def test_a_servable_resume_gets_no_gap_frame() -> None:
    client, run_id = _ws_app(buf=4, published=10)
    try:
        with client.websocket_connect(f"/ws?run_id={run_id}&resume_from=7") as ws:
            first = ws.receive_json()
            assert "type" in first and first["type"] != "gap"
            assert [first["seq"]] + [ws.receive_json()["seq"] for _ in range(2)] == [8, 9, 10]
    finally:
        client.__exit__(None, None, None)


# ---------------------------------------------------------------------------
# R18: switching scenarios at runtime (PUT /config)
# ---------------------------------------------------------------------------


async def test_config_can_be_changed_and_is_reported_by_health() -> None:
    app = create_app(Config())
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sim") as client:
        res = await client.put("/config", json={"fail_step": "read_plate", "reorder_pct": 30})
        assert res.status_code == 200
        assert res.json()["config"]["fail_step"] == "read_plate"
        health = (await client.get("/health")).json()["config"]
        assert health == {
            "fail_step": "read_plate",
            "reorder_pct": 30,
            "duplicate_pct": 0,
            "socket_kill_ms": 0,
            "socket_reject_ms": 0,
            "replay_buffer_size": 64,
        }


async def test_new_runs_pick_up_the_changed_config() -> None:
    app = create_app(Config())
    server = app.state.server
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sim") as client:
        await client.put("/config", json={"fail_step": "read_plate", "replay_buffer_size": 3})
        run_id = (await client.post("/runs")).json()["id"]
        assert server.runs[run_id]._fail_at == "read_plate"
        assert server.streams[run_id]._buf_size == 3


async def test_changing_config_clears_held_events_and_lockout() -> None:
    app = create_app(Config(reorder_pct=100))
    server = app.state.server
    server._held = [Event(run_id="r-1", type=STEP_STARTED, at="x")]
    server._open_from = 10**9
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sim") as client:
        await client.put("/config", json={"reorder_pct": 0})
    assert server._held == []
    assert server._open_from == 0.0


@pytest.mark.parametrize(
    "body",
    [
        b"nope",
        b"[1]",
        b'{"colour": "red"}',
        b'{"fail_step": "teleport"}',
        b'{"reorder_pct": 101}',
        b'{"duplicate_pct": -1}',
        b'{"socket_kill_ms": "4000"}',
        b'{"replay_buffer_size": 0}',
        b'{"replay_buffer_size": true}',
    ],
)
async def test_bad_config_is_rejected_and_changes_nothing(body: bytes) -> None:
    app = create_app(Config())
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sim") as client:
        res = await client.put("/config", content=body)
        assert res.status_code == 400
        assert res.json()["code"] == "INVALID_CONFIG"
    assert app.state.server.cfg == Config()
