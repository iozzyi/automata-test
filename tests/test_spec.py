"""Checks for the behaviour in docs/spec/requirements.md that the provided gates
do not cover. Requirement ids are in each test's docstring."""

from __future__ import annotations

import asyncio

import pytest

from simulator.events import STEP_STARTED, Event
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
