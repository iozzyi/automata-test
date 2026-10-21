"""The engine is provided. These should pass before you change anything."""

from __future__ import annotations

import asyncio

import pytest

from simulator.engine import DONE, FAILED, new_run
from simulator.events import (
    RUN_BLOCKED,
    RUN_COMPLETED,
    STEP_DISPATCHED,
    STEP_FAILED,
    STEP_FINISHED,
    STEP_REFUSED,
    STEP_STARTED,
    Event,
)
from simulator.stream import Stream
from simulator.workflow import DEFAULT_WORKFLOW


async def _collect(stream: Stream, until: str, timeout: float = 30.0) -> list[Event]:
    sub = await stream.subscribe(0)
    seen: list[Event] = []

    async def pump() -> None:
        while True:
            event = await sub.queue.get()
            if event is None:
                return
            seen.append(event)
            if event.type == until:
                return

    try:
        await asyncio.wait_for(pump(), timeout=timeout)
    finally:
        sub.cancel()
    return seen


async def test_clean_run_shape() -> None:
    stream = Stream(256)
    run = new_run("r-1", stream)
    task = asyncio.create_task(_collect(stream, RUN_COMPLETED))
    await asyncio.sleep(0)
    await run.start()
    seen = await task

    counts: dict[str, int] = {}
    for event in seen:
        counts[event.type] = counts.get(event.type, 0) + 1

    assert counts.get(STEP_FINISHED) == len(DEFAULT_WORKFLOW)
    assert counts.get(STEP_DISPATCHED) == len(DEFAULT_WORKFLOW)
    # fill_buffer_plate and warm_reagent_plate each find their device busy.
    assert counts.get(STEP_REFUSED) == 2

    # No device may run two steps at once.
    occupied: dict[str, str] = {}
    for event in seen:
        if event.type == STEP_STARTED:
            assert event.device_id not in occupied, (
                f"{event.device_id} started {event.step_id} "
                f"while still running {occupied.get(event.device_id)}"
            )
            occupied[str(event.device_id)] = str(event.step_id)
        elif event.type in (STEP_FINISHED, STEP_FAILED):
            occupied.pop(str(event.device_id), None)

    assert run.steps["read_plate"].status == DONE


async def test_failure_blocks_run() -> None:
    """A failed step blocks the run rather than ending it, so an operator can retry."""
    stream = Stream(256)
    run = new_run("r-1", stream, fail_at="warm_reagent_plate")
    task = asyncio.create_task(_collect(stream, RUN_BLOCKED))
    await asyncio.sleep(0)
    await run.start()
    await task

    step = run.steps["warm_reagent_plate"]
    assert step.status == FAILED
    assert step.error is not None
    assert step.error.code == "SETPOINT_NOT_REACHED"


@pytest.mark.parametrize(
    ("fail_step", "code", "retryable"),
    [
        ("warm_reagent_plate", "SETPOINT_NOT_REACHED", True),
        ("fill_buffer_plate", "TIP_PICKUP_FAILED", True),
        ("read_plate", "CALIBRATION_EXPIRED", False),
    ],
)
async def test_each_instrument_reports_its_own_fault(
    fail_step: str, code: str, retryable: bool
) -> None:
    stream = Stream(256)
    run = new_run("r-1", stream, fail_at=fail_step)
    task = asyncio.create_task(_collect(stream, RUN_BLOCKED, timeout=40.0))
    await asyncio.sleep(0)
    await run.start()
    await task

    error = run.steps[fail_step].error
    assert error is not None
    assert error.code == code
    assert error.retryable is retryable
    assert error.context, "every fault carries context, and the keys differ by instrument"
