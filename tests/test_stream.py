"""The gates. Everything here fails on the starter."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from simulator.api import Config, create_app
from simulator.engine import FAILED, PENDING
from simulator.events import STEP_STARTED, Event
from simulator.stream import Stream

# ---------------------------------------------------------------------------
# Make the stream resumable.
# ---------------------------------------------------------------------------


def _event() -> Event:
    return Event(run_id="r-1", type=STEP_STARTED, at="2026-09-02T00:00:00Z")


async def test_seq_is_assigned_and_monotonic() -> None:
    stream = Stream(64)
    sub = await stream.subscribe(0)

    for _ in range(5):
        await stream.publish(_event())

    last = 0
    for _ in range(5):
        event = await asyncio.wait_for(sub.queue.get(), timeout=2)
        assert event is not None
        assert event.seq != 0, "event has no sequence number"
        assert event.seq > last, f"seq {event.seq} did not advance past {last}"
        last = event.seq
    assert await stream.watermark() == last
    sub.cancel()


async def test_resume_returns_exactly_the_gap() -> None:
    stream = Stream(64)
    for _ in range(10):
        await stream.publish(_event())

    sub = await stream.subscribe(4)
    assert not sub.gap, "the buffer holds 64 and only 10 were published"
    assert len(sub.backlog) == 6, "want seq 5 through 10"
    assert [e.seq for e in sub.backlog] == [5, 6, 7, 8, 9, 10]
    sub.cancel()


async def test_evicted_cursor_reports_gap() -> None:
    stream = Stream(4)
    for _ in range(20):
        await stream.publish(_event())

    sub = await stream.subscribe(1)
    assert sub.gap, "resumed from seq 1 with a 4-event buffer holding 17-20"
    sub.cancel()


async def test_one_stalled_viewer_does_not_break_the_run() -> None:
    """One viewer that stops reading must not take the run down with it, and must
    not be left with a hole it cannot see.

    There is more than one defensible answer here. Blocking is not one of them.
    """
    total = 2000
    stream = Stream(4096)

    healthy = await stream.subscribe(0)
    stalled = await stream.subscribe(0)  # opened the page and walked away

    seen = 0

    async def drain() -> None:
        nonlocal seen
        while seen < total:
            event = await healthy.queue.get()
            if event is None:
                return
            seen += 1

    drainer = asyncio.create_task(drain())

    async def publish_all() -> None:
        for _ in range(total):
            await stream.publish(_event())

    try:
        await asyncio.wait_for(publish_all(), timeout=10)
    except TimeoutError:
        pytest.fail("publishing stalled: one viewer that stopped reading has blocked the whole run")

    try:
        await asyncio.wait_for(drainer, timeout=10)
    except TimeoutError:
        pytest.fail(f"the healthy viewer got {seen} of {total} events")

    # What was the stalled viewer left holding? Either it is still whole, or it
    # was disconnected and can resume. What it must not be is quietly missing
    # events with no way to find out.
    got: list[Event] = []
    disconnected = False
    while True:
        try:
            event = stalled.queue.get_nowait()
        except asyncio.QueueEmpty:
            break
        if event is None:
            disconnected = True
            break
        got.append(event)

    healthy.cancel()
    stalled.cancel()

    if disconnected:
        return  # told it lost its place; it can reconnect with resume_from
    for i, event in enumerate(got):
        assert event.seq == i + 1, (
            f"the stalled viewer holds seq {event.seq} at position {i} "
            f"(want {i + 1}) and was never told: events were dropped silently"
        )


# ---------------------------------------------------------------------------
# Make a failure actionable.
# ---------------------------------------------------------------------------


async def test_retry_endpoint_retries_the_step() -> None:
    """The endpoint has to work. What it looks like is your call -- this checks
    what it does, not what it returns."""
    app = create_app(Config(replay_buffer_size=64))
    server = app.state.server
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://sim") as client:
        created = await client.post("/runs")
        run_id = created.json()["id"]
        run = server.runs[run_id]

        async with run.lock:
            run.steps["warm_reagent_plate"].status = FAILED
            run.steps["warm_reagent_plate"].attempt = 1

        res = await client.post(f"/runs/{run_id}/steps/warm_reagent_plate/retry")
        assert res.status_code < 400, (
            f"retrying a failed step returned {res.status_code}; "
            "an operator has to be able to do this"
        )
        assert run.steps["warm_reagent_plate"].status == PENDING, (
            "after a retry the step must be pending so the engine picks it up"
        )

        # A step that is not failed must not be quietly restarted.
        await client.post(f"/runs/{run_id}/steps/fill_sample_plate/retry")
        step = run.steps["fill_sample_plate"]
        assert step.status == PENDING and step.attempt == 0, (
            f"retrying a step that never failed changed it to {step.status} attempt {step.attempt}"
        )
