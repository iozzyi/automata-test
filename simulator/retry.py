"""Retrying a failed step.

The endpoint serves two callers: a scientist clicking a button, and an
integrator's script that has just noticed a run is blocked. The contract
(docs/spec/design.md section 4.1):

    POST /runs/{run_id}/steps/{step_id}/retry
    optional JSON body {"attempt": n} -- "retry failed attempt n"

    202  accepted        {run_id, step_id, retrying_attempt, next_attempt,
                          status, duplicate, message}
                         duplicate is true when attempt n was already retried:
                         nothing new happens, so repeating a pinned call is safe
    400  INVALID_BODY    the body is not {"attempt": <positive int>}
    404  UNKNOWN_RUN / UNKNOWN_STEP
    409  STEP_NOT_FAILED the step is not failed (and, if pinned, attempt n was
                         never retried); carries the step as it is now
    422  NOT_RETRYABLE   the instrument says retrying will fail the same way;
                         carries the instrument's error

Every error body is {"code", "message", ...details}. 202 rather than 200: the
retry is accepted, not done. The only confirmation is step.dispatched for
next_attempt on the event stream.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from fastapi import Response
from fastapi.responses import JSONResponse

from simulator.engine import FAILED, PENDING

if TYPE_CHECKING:
    from simulator.engine import Run, Step


def _reset_for_retry(step: Step) -> None:
    """The failed -> pending transition. Caller holds run.lock."""
    step.status = PENDING
    step.refused = False
    step.started_at, step.ended_at, step.error = None, None, None


async def claim_retry(run: Run, step_id: str) -> tuple[int, bool]:
    """Provided.

    Moves a failed step back to pending so the engine dispatches it again, and
    reports what the next attempt will be.

    The decision and the state change are one critical section on purpose: two
    callers racing for the same failed step would otherwise both find it failed,
    and one failure would become two attempts. The transition itself is the
    claim -- the first caller moves the step out of failed and everyone else
    fails their own guard.
    """
    async with run.lock:
        step = run.steps.get(step_id)
        if step is None or step.status != FAILED:
            return 0, False
        _reset_for_retry(step)
        # The engine increments attempt when it dispatches, so report the next
        # one rather than incrementing here.
        return step.attempt + 1, True


async def handle_retry(run: Run | None, run_id: str, step_id: str, body: bytes) -> Response:
    """The retry endpoint. See the module docstring for the contract."""
    if run is None:
        return _error(404, "UNKNOWN_RUN", f"There is no run {run_id}.")

    pinned, problem = _parse_body(body)
    if problem is not None:
        return _error(400, "INVALID_BODY", problem)

    # Checking the attempt, checking retryable and claiming are one critical
    # section, for the same reason claim_retry is: two callers must not both
    # win, and the claim clears the error that says whether retrying can help.
    async with run.lock:
        step = run.steps.get(step_id)
        if step is None:
            return _error(404, "UNKNOWN_STEP", f"Run {run_id} has no step {step_id}.")

        n = step.attempt if pinned is None else pinned

        if step.status == FAILED and step.attempt == n:
            if step.error is not None and not step.error.retryable:
                return _error(
                    422,
                    "NOT_RETRYABLE",
                    f"{step.error.instrument} reported {step.error.code}, which retrying "
                    f"will not fix: {step.error.detail}",
                    error=step.error.as_dict(),
                )
            _reset_for_retry(step)
            return _accepted(run_id, step, n, duplicate=False)

        # Attempt n has already been retried: a newer attempt exists, or the
        # step is pending again at attempt n (claimed, not yet dispatched; a
        # step that never ran is pending at attempt 0).
        if pinned is not None and (
            step.attempt > n or (step.attempt == n and step.status == PENDING)
        ):
            return _accepted(run_id, step, n, duplicate=True)

        if step.status == PENDING and step.attempt > 0:
            message = (
                f"{step_id} has already been retried: attempt {step.attempt + 1} is "
                "waiting to start. There is nothing to retry."
            )
        else:
            message = (
                f"{step_id} is {step.status} (attempt {step.attempt}), not failed; "
                "there is nothing to retry."
            )
        return _error(409, "STEP_NOT_FAILED", message, step=step.as_dict())


def _parse_body(body: bytes) -> tuple[int | None, str | None]:
    """(pinned attempt or None, problem or None). An empty body pins nothing."""
    if not body.strip():
        return None, None
    try:
        data = json.loads(body)
    except ValueError:
        return None, 'The body is not valid JSON. Send {"attempt": <n>} or no body.'
    if not isinstance(data, dict):
        return None, 'The body must be a JSON object: {"attempt": <n>}.'
    unknown = sorted(set(data) - {"attempt"})
    if unknown:
        return None, f"Unknown field(s): {', '.join(unknown)}. Only 'attempt' is accepted."
    if "attempt" not in data:
        return None, None
    attempt = data["attempt"]
    # bool is an int in Python; true is not an attempt number.
    if isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 1:
        return None, "'attempt' must be a whole number of 1 or more."
    return attempt, None


def _accepted(run_id: str, step: Step, n: int, *, duplicate: bool) -> Response:
    if duplicate:
        message = f"Attempt {n} was already retried; nothing new was started."
    else:
        message = f"Retry accepted. Attempt {n + 1} will start when {step.device_id} is free."
    return JSONResponse(
        {
            "run_id": run_id,
            "step_id": step.id,
            "retrying_attempt": n,
            "next_attempt": n + 1,
            "status": step.status,
            "duplicate": duplicate,
            "message": message,
        },
        status_code=202,
    )


def _error(status: int, code: str, message: str, **details: Any) -> Response:
    return JSONResponse({"code": code, "message": message, **details}, status_code=status)
