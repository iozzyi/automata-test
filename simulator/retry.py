"""Retrying a failed step."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import Response
from fastapi.responses import JSONResponse

from simulator.engine import FAILED, PENDING

if TYPE_CHECKING:
    from simulator.engine import Run


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
        step.status = PENDING
        step.refused = False
        step.started_at, step.ended_at, step.error = None, None, None
        # The engine increments attempt when it dispatches, so report the next
        # one rather than incrementing here.
        return step.attempt + 1, True


# ---------------------------------------------------------------------------
# THIS IS THE EXERCISE. See "Make a failure actionable" in README.md.
# ---------------------------------------------------------------------------
#
# The endpoint two different callers need: a scientist clicking a button, and
# an integrator's script that has just noticed a run is blocked.
#
# Nobody has specified it. Status codes, response body, what a second identical
# call does, what a caller is told when the step cannot be retried -- all yours.
#
# The route is wired in api.py and the browser calls it through
# web/src/lib/api.ts. Change either if your design wants a different shape.
async def handle_retry(run: Run, step_id: str) -> Response:
    """TODO(candidate): implement."""
    return JSONResponse({"error": "not implemented"}, status_code=501)
