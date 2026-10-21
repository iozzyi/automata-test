"""The run engine. Provided."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from simulator.events import (
    RUN_BLOCKED,
    RUN_COMPLETED,
    STEP_DISPATCHED,
    STEP_FAILED,
    STEP_FINISHED,
    STEP_REFUSED,
    STEP_STARTED,
    Event,
    StepError,
)
from simulator.workflow import DEFAULT_WORKFLOW, StepDef, fault_for

if TYPE_CHECKING:
    from simulator.stream import Stream

TICK_S = 0.1

# A step is dispatched before it is running: the command has been sent to the
# instrument but the instrument has not confirmed yet.
PENDING = "pending"
DISPATCHED = "dispatched"
RUNNING = "running"
DONE = "done"
FAILED = "failed"


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


@dataclass
class Step:
    id: str
    device_id: str
    depends_on: tuple[str, ...]
    duration_s: float
    status: str = PENDING
    attempt: int = 0
    started_at: str | None = None
    ended_at: str | None = None
    error: StepError | None = None
    ticks_left: int = 0
    refused: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "device_id": self.device_id,
            "depends_on": list(self.depends_on),
            "status": self.status,
            "attempt": self.attempt,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "error": self.error.as_dict() if self.error else None,
        }


class Run:
    """Owns the steps and which device is busy.

    `lock` is public because retry.py needs to make a decision and a state
    change without another caller slipping between them.
    """

    def __init__(
        self,
        run_id: str,
        defs: tuple[StepDef, ...],
        stream: Stream,
        fail_at: str = "",
    ) -> None:
        self.id = run_id
        self.status = "created"
        self.lock = asyncio.Lock()
        self.steps: dict[str, Step] = {
            d.id: Step(d.id, d.device_id, d.depends_on, d.duration_s) for d in defs
        }
        self._order = [d.id for d in defs]
        self._busy: dict[str, str] = {}
        self._stream = stream
        self._started = False
        self._fail_at = fail_at
        self._task: asyncio.Task[None] | None = None

    def ordered_steps(self) -> list[Step]:
        return [self.steps[i] for i in self._order]

    async def start(self) -> None:
        async with self.lock:
            if self._started:
                return
            self._started = True
            self.status = "running"
        self._task = asyncio.create_task(self._loop())

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(TICK_S)
            if await self._tick():
                return

    async def _tick(self) -> bool:
        """Advance every step by one interval. True when the run is over.

        Events are collected under the lock and published after it is released,
        so a slow subscriber cannot stall the engine.
        """
        out: list[Event] = []

        async with self.lock:
            for step in self.steps.values():
                if step.status == DISPATCHED:
                    step.status = RUNNING
                    step.ticks_left = max(int(step.duration_s / TICK_S), 1)
                    step.started_at, step.ended_at = _now(), None
                    out.append(self._ev(STEP_STARTED, step))
                elif step.status == RUNNING:
                    step.ticks_left -= 1
                    if step.ticks_left > 0:
                        continue
                    self._busy.pop(step.device_id, None)
                    step.ended_at = _now()
                    if step.id == self._fail_at and step.attempt == 1:
                        step.status = FAILED
                        step.error = fault_for(step.device_id, step.id)
                        out.append(self._ev(STEP_FAILED, step))
                    else:
                        step.status = DONE
                        step.error = None
                        out.append(self._ev(STEP_FINISHED, step))
            out.extend(self._dispatch_ready())
            out.extend(self._settle())
            done = self.status == "completed"

        for event in out:
            await self._stream.publish(event)
        return done

    def _dispatch_ready(self) -> list[Event]:
        """Send every ready step to its device; announce a refusal when it is busy.

        Caller holds the lock.
        """
        out: list[Event] = []
        for step in self.ordered_steps():
            if step.status != PENDING or not self._ready(step):
                continue
            if step.device_id in self._busy:
                if not step.refused:
                    step.refused = True
                    out.append(self._ev(STEP_REFUSED, step, attempt=step.attempt + 1))
                continue
            self._busy[step.device_id] = step.id
            step.attempt += 1
            step.status = DISPATCHED
            step.refused = False
            out.append(self._ev(STEP_DISPATCHED, step))
        return out

    def _ready(self, step: Step) -> bool:
        return all(self.steps[d].status == DONE for d in step.depends_on if d in self.steps)

    def _settle(self) -> list[Event]:
        """End the run when everything is done, or block it when a failure means
        nothing further can happen without an operator. Caller holds the lock."""
        if self.status not in ("running", "blocked"):
            return []
        all_done, any_failed, any_active = True, False, False
        for step in self.steps.values():
            if step.status == DONE:
                continue
            if step.status == FAILED:
                all_done, any_failed = False, True
                continue
            all_done = False
            if step.status != PENDING or self._ready(step):
                any_active = True

        if all_done and self.status != "completed":
            self.status = "completed"
            return [Event(run_id=self.id, type=RUN_COMPLETED, at=_now())]
        if any_failed and not any_active and self.status != "blocked":
            self.status = "blocked"
            return [Event(run_id=self.id, type=RUN_BLOCKED, at=_now())]
        return []

    def _ev(self, kind: str, step: Step, attempt: int | None = None) -> Event:
        return Event(
            run_id=self.id,
            type=kind,
            at=_now(),
            step_id=step.id,
            attempt=step.attempt if attempt is None else attempt,
            device_id=step.device_id,
            error=step.error if kind == STEP_FAILED else None,
        )


def new_run(run_id: str, stream: Stream, fail_at: str = "") -> Run:
    return Run(run_id, DEFAULT_WORKFLOW, stream, fail_at)


_ = field
