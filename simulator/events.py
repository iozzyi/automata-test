"""The wire contract. Provided."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

STEP_DISPATCHED = "step.dispatched"
STEP_REFUSED = "step.refused"
STEP_STARTED = "step.started"
STEP_FINISHED = "step.finished"
STEP_FAILED = "step.failed"
RUN_BLOCKED = "run.blocked"
RUN_COMPLETED = "run.completed"


@dataclass
class StepError:
    """What an instrument reports when a step goes wrong.

    code, instrument, detail and retryable are the same for every instrument.
    context is not: each one reports whatever it happens to know, so the keys
    differ by device and by fault. Nothing enumerates them.
    """

    code: str
    instrument: str
    detail: str
    retryable: bool
    context: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "instrument": self.instrument,
            "detail": self.detail,
            "retryable": self.retryable,
            "context": self.context,
        }


@dataclass
class Event:
    """Everything the browser learns about a run.

    seq is the stream's sequence number. It is 0 in the starter because nothing
    assigns it yet -- see stream.py.
    """

    run_id: str
    type: str
    at: str
    seq: int = 0
    step_id: str | None = None
    attempt: int | None = None
    device_id: str | None = None
    error: StepError | None = None

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "seq": self.seq,
            "run_id": self.run_id,
            "type": self.type,
            "at": self.at,
        }
        if self.step_id is not None:
            out["step_id"] = self.step_id
        if self.attempt is not None:
            out["attempt"] = self.attempt
        if self.device_id is not None:
            out["device_id"] = self.device_id
        if self.error is not None:
            out["error"] = self.error.as_dict()
        return out
