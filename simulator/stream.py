"""Carries run events to connected browsers.

---------------------------------------------------------------------------
THIS IS THE EXERCISE. See "Make the run honest" in README.md.
---------------------------------------------------------------------------

What it does today: hands each event to whoever is connected at that instant.
Nothing else. No sequence number, no history, nothing to come back to.

So a browser that loses its connection for ten seconds loses ten seconds of the
run permanently, and cannot tell that it did. It also cannot tell a duplicate
from a new event, or notice that two arrived in the wrong order.

Your job is to make the stream resumable:

  * give every event a monotonic ``seq``, assigned here
  * keep the recent past in a bounded buffer
  * serve ``subscribe(resume_from)`` from that buffer, then go live
  * report ``gap`` when resume_from is older than anything you still hold
  * return a real ``watermark`` so a snapshot can say where it sits in the stream

Add whatever else you need. Keep the signatures below -- the tests call them --
but nothing stops you adding more.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass

from simulator.events import Event

#: How many events a subscriber may fall behind before something has to give.
SUBSCRIBER_QUEUE_SIZE = 256


@dataclass
class Subscription:
    """What ``Stream.subscribe`` hands back.

    ``backlog`` is written to the socket before ``queue`` is drained.
    ``gap`` reports that the requested position can no longer be served.
    """

    backlog: list[Event]
    queue: asyncio.Queue[Event | None]
    gap: bool
    cancel: Callable[[], None]


class Stream:
    def __init__(self, buf_size: int) -> None:
        # TODO(candidate): buf_size is the replay buffer capacity, and nothing
        # reads it yet. Deciding what happens when it fills is part of the job.
        self._buf_size = buf_size
        self._lock = asyncio.Lock()
        self._subs: dict[int, asyncio.Queue[Event | None]] = {}
        self._next_id = 0

    async def publish(self, event: Event) -> None:
        """Deliver an event to every current subscriber.

        TODO(candidate): assign ``event.seq`` here, and record the event so it
        can be replayed. Note who else may be inside this object at the same
        moment.
        """
        async with self._lock:
            for queue in self._subs.values():
                try:
                    queue.put_nowait(event)
                except asyncio.QueueFull:
                    # This subscriber is not keeping up. Dropping is one answer.
                    pass

    async def subscribe(self, resume_from: int) -> Subscription:
        """Register a listener.

        TODO(candidate): backlog and gap are always empty and False. Both are
        yours.
        """
        async with self._lock:
            sub_id = self._next_id
            self._next_id += 1
            queue: asyncio.Queue[Event | None] = asyncio.Queue(maxsize=SUBSCRIBER_QUEUE_SIZE)
            self._subs[sub_id] = queue

        def cancel() -> None:
            self._subs.pop(sub_id, None)

        return Subscription(backlog=[], queue=queue, gap=False, cancel=cancel)

    async def watermark(self) -> int:
        """The sequence number of the most recent published event.

        The snapshot handler puts it in its response so a client knows where the
        snapshot sits relative to the stream.

        TODO(candidate): always 0 today, which tells a client nothing.
        """
        return 0

    async def earliest(self) -> int:
        """The oldest sequence number you can still replay, or 0 when you hold
        nothing. Only meaningful alongside a gap.

        TODO(candidate): always 0 today.
        """
        return 0
