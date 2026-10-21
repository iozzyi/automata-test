"""Carries run events to connected browsers.

---------------------------------------------------------------------------
THIS IS THE EXERCISE. See "Make the run honest" in README.md.
---------------------------------------------------------------------------

What it does: numbers every event (``seq`` 1, 2, 3, ... per run), keeps the
last ``buf_size`` in a replay buffer, and serves ``subscribe(resume_from)`` from
that buffer before going live. ``gap`` is reported when the next event a caller
needs is no longer held, or when it asks to resume from beyond anything
published (it cannot vouch for that position). ``watermark`` is the last seq
published, so a snapshot can say where it sits.

A viewer that stops reading is cut off rather than allowed to stall the run or
silently drop events: over SUBSCRIBER_QUEUE_SIZE queued starts a SLOW_GRACE_S
clock, and past it (or past SUBSCRIBER_HARD_LIMIT at any time) its queue is
cleared and ended with None. It reconnects and resumes, or is told of a gap.
See docs/spec/design.md section 2.
"""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field

from simulator.events import Event

#: How many events a subscriber may fall behind before something has to give.
#: Past this a grace clock starts (see SLOW_GRACE_S).
SUBSCRIBER_QUEUE_SIZE = 256

#: How long a viewer may stay over SUBSCRIBER_QUEUE_SIZE before it is cut off.
SLOW_GRACE_S = 2.0

#: Over this many queued events a viewer is cut off at once, grace or not.
SUBSCRIBER_HARD_LIMIT = 512


@dataclass
class Subscription:
    """What ``Stream.subscribe`` hands back.

    ``backlog`` is written to the socket before ``queue`` is drained.
    ``gap`` reports that the requested position can no longer be served.
    ``earliest`` is the oldest seq held at the moment of subscribing, captured
    with the backlog so the two always agree.
    """

    backlog: list[Event]
    queue: asyncio.Queue[Event | None]
    gap: bool
    cancel: Callable[[], None]
    earliest: int = 0


@dataclass
class _Viewer:
    # Unbounded at the asyncio level: the limits are enforced in publish(), which
    # guarantees there is always room for the final None.
    queue: asyncio.Queue[Event | None] = field(default_factory=asyncio.Queue)
    #: Loop time at which the queue first went over SUBSCRIBER_QUEUE_SIZE.
    over_since: float | None = None


class Stream:
    """One run's events: numbered, kept for replay, fanned out to viewers.

    A viewer that falls behind is given a grace period and then disconnected
    (its queue is cleared and ends with None). It is never left silently
    missing events: it reconnects with resume_from and is either replayed from
    the buffer or told about the gap.
    """

    def __init__(self, buf_size: int) -> None:
        self._buf_size = max(buf_size, 1)
        self._buf: deque[Event] = deque(maxlen=self._buf_size)
        self._seq = 0
        self._lock = asyncio.Lock()
        self._subs: dict[int, _Viewer] = {}
        self._next_id = 0

    async def publish(self, event: Event) -> None:
        """Number the event, keep it for replay, and deliver it to every viewer.

        Never waits on a viewer: a slow one is cut off instead (see _Viewer).
        """
        async with self._lock:
            self._seq += 1
            event.seq = self._seq
            self._buf.append(event)
            now = asyncio.get_running_loop().time()
            for sub_id, viewer in list(self._subs.items()):
                viewer.queue.put_nowait(event)
                if self._too_slow(viewer, now):
                    self._disconnect(sub_id, viewer)
        # An uncontended asyncio.Lock never yields, so without this a burst of
        # publishes would give readers no chance to drain and even a healthy
        # viewer would hit the hard limit. This waits on nobody.
        await asyncio.sleep(0)

    async def subscribe(self, resume_from: int) -> Subscription:
        """Register a listener, replaying everything after ``resume_from``.

        The backlog, the gap check and the registration happen under the same
        lock publish() takes, so no event can slip between replay and live.
        """
        async with self._lock:
            earliest = self._buf[0].seq if self._buf else self._seq + 1
            gap = resume_from > self._seq or (
                resume_from < self._seq and earliest > resume_from + 1
            )
            backlog = [e for e in self._buf if e.seq > resume_from]
            sub_id = self._next_id
            self._next_id += 1
            viewer = _Viewer()
            self._subs[sub_id] = viewer

        def cancel() -> None:
            self._subs.pop(sub_id, None)

        return Subscription(
            backlog=backlog,
            queue=viewer.queue,
            gap=gap,
            cancel=cancel,
            earliest=earliest,
        )

    async def watermark(self) -> int:
        """The sequence number of the most recent published event, or 0."""
        async with self._lock:
            return self._seq

    async def earliest(self) -> int:
        """The oldest sequence number you can still replay, or 0 when you hold
        nothing. Only meaningful alongside a gap."""
        async with self._lock:
            return self._buf[0].seq if self._buf else 0

    async def close(self) -> None:
        """End every viewer's stream (each gets None) and take no more.
        Used by the simulator's testing-only reset."""
        async with self._lock:
            for sub_id, viewer in list(self._subs.items()):
                self._disconnect(sub_id, viewer)

    @staticmethod
    def _too_slow(viewer: _Viewer, now: float) -> bool:
        size = viewer.queue.qsize()
        if size > SUBSCRIBER_HARD_LIMIT:
            return True
        if size <= SUBSCRIBER_QUEUE_SIZE:
            viewer.over_since = None
            return False
        if viewer.over_since is None:
            viewer.over_since = now
            return False
        return now - viewer.over_since >= SLOW_GRACE_S

    def _disconnect(self, sub_id: int, viewer: _Viewer) -> None:
        """Cut a viewer off: drop what it has not read and end its stream.
        Caller holds the lock."""
        while not viewer.queue.empty():
            viewer.queue.get_nowait()
        viewer.queue.put_nowait(None)
        del self._subs[sub_id]
