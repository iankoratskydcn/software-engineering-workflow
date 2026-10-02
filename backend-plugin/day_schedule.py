"""Pure scheduling logic for the daily cadence: no I/O, no clock, no database.

A day is a list of blocks. A block is one retro/plan hour followed by N work
hours (N from 2 to 6). Every hour is one sprint, and hours run back to back.
All times are epoch seconds (UTC); `now` is always passed in, so every function
here is deterministic.

The minute maps below are a starting hypothesis. The first manual trial block
is meant to adjust them, so they live in two tables rather than in code paths.
"""

from __future__ import annotations

import math
from typing import Optional

HOUR_SECONDS = 3600
MIN_WORK_HOURS = 2
MAX_WORK_HOURS = 6
MAX_BLOCK_HOURS = MAX_WORK_HOURS + 1  # the retro hour plus a full block of work
MIN_BLOCK_HOURS = MIN_WORK_HOURS + 1
MIN_DAY_HOURS = MIN_BLOCK_HOURS
MAX_DAY_HOURS = 24

HATS = ("spec", "review", "decide", "retro")

# (first minute, end minute, ceremony, suggested hat, what to do now)
WORK_PHASES = (
    (0, 5, "sprint_planning", "spec", "Commit the Ready features for this hour; the fleet decomposes them and starts building."),
    (5, 35, "refinement", "spec", "Refine the next feature to Ready: criteria, estimate, risks."),
    (35, 50, "review", "review", "Review the previous hour's work and accept or reject it."),
    (50, 55, "decision_sweep", "decide", "Clear any pending decision cards."),
    (55, 60, "mini_retro", "retro", "Log estimate against actual and mark carryovers."),
)
RETRO_PHASES = (
    (0, 25, "retro_review", "retro", "Read the log for the block just finished: what worked, what did not."),
    (25, 40, "process_changes", "retro", "Decide process changes and quadrant-2 work; log each one."),
    (40, 50, "block_planning", "spec", "Re-rank the roadmap and plan this block's hours."),
    (50, 60, "ready_first_feature", "spec", "Bring the first work hour's feature to Ready."),
)
_PHASES = {"work": WORK_PHASES, "retro": RETRO_PHASES}


class ScheduleError(ValueError):
    """Invalid input to the scheduler."""


def plan(hours_available: int) -> list[int]:
    """Work hours per block for a day of `hours_available` hours.

    Prefers the fewest, longest blocks (so a 12 hour day is two blocks of
    1+5), then spreads the hours evenly, larger blocks first. 3 gives [2],
    5 gives [4], 7 gives [6], 12 gives [5, 5], 13 gives [6, 5].
    """
    if isinstance(hours_available, bool) or not isinstance(hours_available, int):
        raise ScheduleError("hours must be a whole number")
    if not MIN_DAY_HOURS <= hours_available <= MAX_DAY_HOURS:
        raise ScheduleError(f"hours must be between {MIN_DAY_HOURS} and {MAX_DAY_HOURS}")
    blocks = math.ceil(hours_available / MAX_BLOCK_HOURS)
    base, extra = divmod(hours_available, blocks)
    return [base + (1 if index < extra else 0) - 1 for index in range(blocks)]


def hour_slots(work_hours_per_block: list[int], start_ts: float) -> list[dict]:
    """Lay the blocks out as contiguous hours. `block` and `hour` are 1-based;
    hour 1 of every block is its retro hour."""
    slots = []
    cursor = start_ts
    for block, work_hours in enumerate(work_hours_per_block, start=1):
        if not MIN_WORK_HOURS <= work_hours <= MAX_WORK_HOURS:
            raise ScheduleError(f"a block has {MIN_WORK_HOURS} to {MAX_WORK_HOURS} work hours")
        for hour in range(1, work_hours + 2):
            slots.append({
                "block": block,
                "hour": hour,
                "kind": "retro" if hour == 1 else "work",
                "start_ts": cursor,
                "end_ts": cursor + HOUR_SECONDS,
            })
            cursor += HOUR_SECONDS
    return slots


def phase_at(kind: str, hour_start_ts: float, now_ts: float) -> dict:
    """Which ceremony is running `now_ts` inside the hour that began at
    `hour_start_ts`."""
    phases = _PHASES.get(kind)
    if phases is None:
        raise ScheduleError("kind must be 'work' or 'retro'")
    elapsed = now_ts - hour_start_ts
    if not 0 <= elapsed < HOUR_SECONDS:
        raise ScheduleError("now is outside this hour")
    minute = int(elapsed // 60)
    for first, end, ceremony, hat, action in phases:
        if first <= minute < end:
            phase_end = hour_start_ts + end * 60
            return {
                "ceremony": ceremony,
                "suggested_hat": hat,
                "next_best_action": action,
                "minute": minute,
                "phase_start_ts": hour_start_ts + first * 60,
                "phase_end_ts": phase_end,
                "seconds_remaining": max(0, math.ceil(phase_end - now_ts)),
            }
    raise AssertionError("phase tables must cover minutes 0-59")  # pragma: no cover


def snapshot(hours: list[dict], now_ts: float) -> dict:
    """Where `now_ts` falls in a laid-out day. `hours` are slots from
    hour_slots() (or the stored equivalents), in order."""
    if not hours:
        raise ScheduleError("a day has at least one hour")
    first, last = hours[0], hours[-1]
    if now_ts < first["start_ts"]:
        return {"state": "not_started", "starts_in_seconds": math.ceil(first["start_ts"] - now_ts),
                "current": None, "next": first}
    if now_ts >= last["end_ts"]:
        return {"state": "finished", "current": None, "next": None}
    for index, hour in enumerate(hours):
        if hour["start_ts"] <= now_ts < hour["end_ts"]:
            following: Optional[dict] = hours[index + 1] if index + 1 < len(hours) else None
            return {
                "state": "in_progress",
                "current": {**hour, "phase": phase_at(hour["kind"], hour["start_ts"], now_ts)},
                "next": following,
                "hours_remaining": len(hours) - index,
            }
    raise ScheduleError("hours must be contiguous")  # pragma: no cover
