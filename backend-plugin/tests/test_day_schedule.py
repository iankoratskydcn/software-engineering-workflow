"""Day planner and phase clock: pure functions, deterministic."""
import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import day_schedule as ds  # noqa: E402

START = 1_790_000_000.0  # an arbitrary epoch second; only offsets matter


# --- plan --------------------------------------------------------------------

@pytest.mark.parametrize("hours, expected", [
    (3, [2]), (4, [3]), (5, [4]), (6, [5]), (7, [6]),      # one block
    (8, [3, 3]), (12, [5, 5]), (13, [6, 5]), (14, [6, 6]),  # two blocks, even split first
    (15, [4, 4, 4]), (16, [5, 4, 4]), (24, [5, 5, 5, 5]),
])
def test_plan_layouts(hours, expected):
    assert ds.plan(hours) == expected


@pytest.mark.parametrize("hours", range(ds.MIN_DAY_HOURS, ds.MAX_DAY_HOURS + 1))
def test_plan_invariants_hold_for_every_day_length(hours):
    blocks = ds.plan(hours)
    assert sum(work + 1 for work in blocks) == hours          # every hour is used
    assert all(ds.MIN_WORK_HOURS <= work <= ds.MAX_WORK_HOURS for work in blocks)
    assert len(blocks) == math.ceil(hours / ds.MAX_BLOCK_HOURS)  # fewest blocks possible
    assert blocks == sorted(blocks, reverse=True)             # larger blocks first
    assert max(blocks) - min(blocks) <= 1                     # evenly spread


@pytest.mark.parametrize("hours", [0, 1, 2, 25, -3, 2.5, "5", None, True])
def test_plan_rejects_unusable_hours(hours):
    with pytest.raises(ds.ScheduleError):
        ds.plan(hours)


# --- hour_slots ----------------------------------------------------------------

def test_hour_slots_are_contiguous_and_start_each_block_with_a_retro():
    slots = ds.hour_slots([4, 2], START)

    assert [(s["block"], s["hour"], s["kind"]) for s in slots] == [
        (1, 1, "retro"), (1, 2, "work"), (1, 3, "work"), (1, 4, "work"), (1, 5, "work"),
        (2, 1, "retro"), (2, 2, "work"), (2, 3, "work"),
    ]
    assert slots[0]["start_ts"] == START
    for earlier, later in zip(slots, slots[1:]):
        assert earlier["end_ts"] == later["start_ts"]
    assert all(s["end_ts"] - s["start_ts"] == ds.HOUR_SECONDS for s in slots)


@pytest.mark.parametrize("blocks", [[1], [7], [0], [4, 1]])
def test_hour_slots_reject_blocks_outside_two_to_six_work_hours(blocks):
    with pytest.raises(ds.ScheduleError):
        ds.hour_slots(blocks, START)


# --- phase_at -------------------------------------------------------------------

WORK_EXPECTED = (
    [(m, "sprint_planning", "spec") for m in range(0, 5)]
    + [(m, "refinement", "spec") for m in range(5, 35)]
    + [(m, "review", "review") for m in range(35, 50)]
    + [(m, "decision_sweep", "decide") for m in range(50, 55)]
    + [(m, "mini_retro", "retro") for m in range(55, 60)]
)
RETRO_EXPECTED = (
    [(m, "retro_review", "retro") for m in range(0, 25)]
    + [(m, "process_changes", "retro") for m in range(25, 40)]
    + [(m, "block_planning", "spec") for m in range(40, 50)]
    + [(m, "ready_first_feature", "spec") for m in range(50, 60)]
)


@pytest.mark.parametrize("minute, ceremony, hat", WORK_EXPECTED)
def test_every_minute_of_a_work_hour_has_the_expected_ceremony(minute, ceremony, hat):
    phase = ds.phase_at("work", START, START + minute * 60)
    assert (phase["ceremony"], phase["suggested_hat"], phase["minute"]) == (ceremony, hat, minute)
    assert phase["suggested_hat"] in ds.HATS and phase["next_best_action"]


@pytest.mark.parametrize("minute, ceremony, hat", RETRO_EXPECTED)
def test_every_minute_of_a_retro_hour_has_the_expected_ceremony(minute, ceremony, hat):
    phase = ds.phase_at("retro", START, START + minute * 60)
    assert (phase["ceremony"], phase["suggested_hat"]) == (ceremony, hat)


def test_phase_countdown_at_the_edges():
    start_of_planning = ds.phase_at("work", START, START)
    assert start_of_planning["seconds_remaining"] == 300
    assert start_of_planning["phase_end_ts"] == START + 300

    last_second = ds.phase_at("work", START, START + 299)
    assert (last_second["ceremony"], last_second["seconds_remaining"]) == ("sprint_planning", 1)

    next_phase = ds.phase_at("work", START, START + 300)
    assert (next_phase["ceremony"], next_phase["seconds_remaining"]) == ("refinement", 1800)

    fractional = ds.phase_at("work", START, START + 299.2)
    assert fractional["seconds_remaining"] == 1  # rounds up, never reports 0 while still in the phase


def test_phase_tables_tile_the_hour_without_gaps_or_overlap():
    for table in (ds.WORK_PHASES, ds.RETRO_PHASES):
        assert table[0][0] == 0 and table[-1][1] == 60
        for earlier, later in zip(table, table[1:]):
            assert earlier[1] == later[0]


@pytest.mark.parametrize("now_offset", [-1, ds.HOUR_SECONDS, ds.HOUR_SECONDS + 5])
def test_phase_at_rejects_times_outside_the_hour(now_offset):
    with pytest.raises(ds.ScheduleError):
        ds.phase_at("work", START, START + now_offset)


def test_phase_at_rejects_an_unknown_kind():
    with pytest.raises(ds.ScheduleError):
        ds.phase_at("lunch", START, START)


# --- snapshot -------------------------------------------------------------------

def test_snapshot_before_during_and_after_the_day():
    slots = ds.hour_slots([2], START)  # retro + 2 work hours = 3 hours

    before = ds.snapshot(slots, START - 90)
    assert before["state"] == "not_started" and before["starts_in_seconds"] == 90
    assert before["current"] is None and before["next"]["hour"] == 1

    during = ds.snapshot(slots, START + 3600 + 600)  # ten minutes into work hour 2
    assert during["state"] == "in_progress"
    assert (during["current"]["block"], during["current"]["hour"], during["current"]["kind"]) == (1, 2, "work")
    assert during["current"]["phase"]["ceremony"] == "refinement"
    assert during["next"]["hour"] == 3 and during["hours_remaining"] == 2

    after = ds.snapshot(slots, START + 3 * 3600)
    assert after == {"state": "finished", "current": None, "next": None}


def test_the_boundary_between_two_hours_belongs_to_the_later_hour():
    slots = ds.hour_slots([2], START)
    snap = ds.snapshot(slots, START + 3600)
    assert snap["current"]["hour"] == 2
    assert snap["current"]["phase"]["ceremony"] == "sprint_planning"


def test_the_last_hour_has_no_next():
    slots = ds.hour_slots([2], START)
    last = ds.snapshot(slots, START + 3 * 3600 - 1)
    assert last["state"] == "in_progress" and last["next"] is None and last["hours_remaining"] == 1


def test_snapshot_needs_hours():
    with pytest.raises(ds.ScheduleError):
        ds.snapshot([], START)
