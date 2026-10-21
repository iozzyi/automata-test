"""The workflow and the faults each instrument reports. Provided."""

from __future__ import annotations

from dataclasses import dataclass, field

from simulator.events import StepError


@dataclass(frozen=True)
class StepDef:
    id: str
    device_id: str
    duration_s: float
    depends_on: tuple[str, ...] = ()


# fill_sample_plate --+--> incubate_samples ---------------------+
#                     |                                          |
#                     +--> fill_reagent_plate --> warm_reagent ---+--> combine --> read_plate
#                     |                                          |
#                     +--> fill_buffer_plate ---------------------+
#
# Three steps share the liquid handler and two share the incubator, so the
# devices are contended and the run produces refusals without any help.
DEFAULT_WORKFLOW: tuple[StepDef, ...] = (
    StepDef("fill_sample_plate", "liquid-handler-1", 2.0),
    StepDef("incubate_samples", "incubator-1", 4.0, ("fill_sample_plate",)),
    StepDef("fill_reagent_plate", "liquid-handler-1", 2.0, ("fill_sample_plate",)),
    StepDef("fill_buffer_plate", "liquid-handler-1", 2.0, ("fill_sample_plate",)),
    StepDef("warm_reagent_plate", "incubator-1", 3.0, ("fill_reagent_plate",)),
    StepDef(
        "combine",
        "liquid-handler-1",
        2.0,
        ("incubate_samples", "warm_reagent_plate", "fill_buffer_plate"),
    ),
    StepDef("read_plate", "plate-reader-1", 2.0, ("combine",)),
)

DEVICES: tuple[str, ...] = ("liquid-handler-1", "incubator-1", "plate-reader-1")


def fault_for(device_id: str, step_id: str) -> StepError:
    """What a device reports when FAIL_STEP makes it go wrong.

    The context each one carries is whatever that instrument knows about itself.
    """
    if device_id == "incubator-1":
        return StepError(
            code="SETPOINT_NOT_REACHED",
            instrument=device_id,
            detail="chamber did not reach 37.0C within tolerance",
            retryable=True,
            context={
                "target_c": 37.0,
                "actual_c": 31.2,
                "tolerance_c": 0.5,
                "elapsed_s": 180,
                "labware": "PLT-00421",
                "door_cycles": 2,
            },
        )
    if device_id == "liquid-handler-1":
        return StepError(
            code="TIP_PICKUP_FAILED",
            instrument=device_id,
            detail="no tip detected on channel 4 after pickup",
            retryable=True,
            context={
                "channel": 4,
                "tip_box": "TIP-07",
                "wells_remaining": 12,
                "volume_ul": 45.0,
                "labware": "PLT-00421",
            },
        )
    if device_id == "plate-reader-1":
        return StepError(
            code="CALIBRATION_EXPIRED",
            instrument=device_id,
            detail="last calibration was 41 days ago; limit is 30",
            retryable=False,
            context={
                "last_calibrated": "2026-07-22",
                "max_age_days": 30,
                "filter_set": "FITC/TRITC",
                "service_ticket": "SVC-3312",
            },
        )
    return StepError(
        code="UNKNOWN",
        instrument=device_id,
        detail=f"step {step_id} failed",
        retryable=True,
    )


_ = field  # re-exported for dataclass users
