"""CLI contracts for `decision day ...` against a real temp Hermes home."""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cli  # noqa: E402
import db  # noqa: E402
import observation_log as obs  # noqa: E402

PACIFIC = timezone(timedelta(hours=-7))
START = datetime(2026, 10, 2, 9, 0, tzinfo=PACIFIC)
START_ARG = START.isoformat()


@pytest.fixture(autouse=True)
def hermes_home(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    monkeypatch.delenv(db._DELEGATED_CHILD_ENV_MARKER, raising=False)


def run(capsys, *argv):
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    args = parser.parse_args(["day", *argv])
    code = 0
    try:
        args.func(args)
    except SystemExit as exit_:
        code = exit_.code
    return code, json.loads(capsys.readouterr().out)


def at(minutes: float) -> str:
    return (START + timedelta(minutes=minutes)).isoformat()


def log_records(kind=None):
    return obs.read(db.db_path().parent / "observations.jsonl", kind=kind)


def start_day(capsys, hours=5, when=START_ARG):
    code, out = run(capsys, "start", "--hours", str(hours), "--at", when)
    assert code == 0 and out["ok"], out
    return out["day"]


# --- plan (preview only) ---------------------------------------------------------

def test_plan_previews_the_layout_and_saves_nothing(capsys):
    code, out = run(capsys, "plan", "--hours", "12", "--at", START_ARG)
    plan = out["plan"]

    assert code == 0 and plan["layout"] == "1+5, 1+5" and plan["blocks"] == 2 and len(plan["hours"]) == 12
    assert plan["hours"][0] == {
        "block": 1, "hour": 1, "kind": "retro",
        "start_ts": START.timestamp(), "end_ts": START.timestamp() + 3600,
        "start": "2026-10-02T16:00:00Z", "end": "2026-10-02T17:00:00Z",
    }
    assert run(capsys, "status") == (0, {"ok": True, "active": False})
    assert log_records() == []


@pytest.mark.parametrize("hours, layout", [(3, "1+2"), (5, "1+4"), (7, "1+6"), (13, "1+6, 1+5")])
def test_plan_layouts_through_the_cli(capsys, hours, layout):
    assert run(capsys, "plan", "--hours", str(hours))[1]["plan"]["layout"] == layout


@pytest.mark.parametrize("argv", [["--hours", "2"], ["--hours", "25"], ["--hours", "5", "--at", "tomorrow"]])
def test_plan_rejects_bad_input(capsys, argv):
    code, out = run(capsys, "plan", *argv)
    assert code == 2 and out["ok"] is False and out["error"]["code"] == "invalid_input"


def test_hours_must_be_a_number():
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    with pytest.raises(SystemExit) as exit_:
        parser.parse_args(["day", "plan", "--hours", "five"])
    assert exit_.value.code == 2


# --- start / status / end --------------------------------------------------------

def test_start_creates_the_day_and_logs_it(capsys):
    day = start_day(capsys, hours=12)

    assert day["status"] == "active" and day["layout"] == "1+5, 1+5" and day["hours_available"] == 12
    assert day["date"] == "2026-10-02" and len(day["hours"]) == 12
    (record,) = log_records("plan")
    assert record["author"] == "human" and record["day"] == "2026-10-02"
    assert record["data"] == {
        "event": "day_started", "hours_available": 12, "work_hours_per_block": [5, 5],
        "start": "2026-10-02T16:00:00Z",
    }


def test_a_second_start_conflicts_until_the_day_ends(capsys):
    start_day(capsys)
    code, out = run(capsys, "start", "--hours", "3")
    assert code == 4 and out["error"]["code"] == "conflict"

    code, ended = run(capsys, "end")
    assert code == 0 and ended["day"]["status"] == "ended"
    assert [r["data"]["event"] for r in log_records("plan")] == ["day_started", "day_ended"]
    start_day(capsys, hours=3)


def test_end_with_no_active_day_is_not_found(capsys):
    code, out = run(capsys, "end")
    assert code == 3 and out["error"]["code"] == "not_found"


def test_status_with_no_day_is_inactive(capsys):
    assert run(capsys, "status") == (0, {"ok": True, "active": False})


def test_status_mid_hour_reports_the_ceremony_and_countdown(capsys):
    start_day(capsys, hours=5)

    # 70 minutes in: work hour 2 of block 1 (hour index 2), ten minutes past its start
    code, out = run(capsys, "status", "--now", at(70))
    assert code == 0 and out["active"] and out["state"] == "in_progress"
    current = out["current"]
    assert (current["block"], current["hour"], current["kind"]) == (1, 2, "work")
    assert current["phase"]["ceremony"] == "refinement"
    assert current["phase"]["suggested_hat"] == "spec"
    assert current["phase"]["seconds_remaining"] == 25 * 60
    assert current["phase"]["phase_end"] == "2026-10-02T17:35:00Z"
    assert out["next"]["hour"] == 3 and out["hours_remaining"] == 4
    assert out["current_hat"] is None and out["now"] == "2026-10-02T17:10:00Z"


def test_status_first_hour_is_the_retro_hour(capsys):
    start_day(capsys, hours=5)
    phase = run(capsys, "status", "--now", at(5))[1]["current"]
    assert phase["kind"] == "retro" and phase["phase"]["ceremony"] == "retro_review"


def test_status_before_and_after_the_day(capsys):
    start_day(capsys, hours=3)

    before = run(capsys, "status", "--now", at(-30))[1]
    assert before["state"] == "not_started" and before["starts_in_seconds"] == 1800
    assert before["current"] is None and before["next"]["hour"] == 1

    after = run(capsys, "status", "--now", at(3 * 60))[1]
    assert after["state"] == "finished" and after["current"] is None and after["next"] is None


# --- hat ---------------------------------------------------------------------------

def test_hat_is_logged_with_its_day_block_and_hour_and_shows_in_status(capsys):
    now = datetime.now().astimezone()
    start_day(capsys, hours=5, when=now.isoformat())  # in progress right now: block 1, retro hour

    code, out = run(capsys, "hat", "--hat", "spec")
    assert code == 0 and out["hat"] == "spec"
    (record,) = log_records("hat_switch")
    assert record["data"] == {"hat": "spec"} and record["author"] == "human"
    assert (record["day"], record["block"], record["hour"]) == (now.date().isoformat(), 1, 1)

    assert run(capsys, "status")[1]["current_hat"] == "spec"
    run(capsys, "hat", "--hat", "review")
    assert run(capsys, "status")[1]["current_hat"] == "review"


def test_hat_outside_the_scheduled_hours_has_no_block_or_hour(capsys):
    start_day(capsys, hours=3, when="2020-01-01T09:00:00-07:00")  # long finished, whatever today is
    code, out = run(capsys, "hat", "--hat", "retro")
    assert code == 0
    (record,) = log_records("hat_switch")
    assert record["day"] == "2020-01-01"
    assert (record["block"], record["hour"]) == (None, None)


def test_hat_needs_an_active_day(capsys):
    code, out = run(capsys, "hat", "--hat", "spec")
    assert code == 3 and out["error"]["code"] == "not_found"
    assert log_records() == []


def test_hat_choices_are_limited():
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    with pytest.raises(SystemExit) as exit_:
        parser.parse_args(["day", "hat", "--hat", "napping"])
    assert exit_.value.code == 2


# --- the log is not allowed to undo the day --------------------------------------

def test_a_failing_log_write_does_not_undo_start_or_end(capsys, monkeypatch):
    def broken(*args, **kwargs):
        raise obs.LogBusy("observation log is busy")

    monkeypatch.setattr(obs, "append", broken)
    code, out = run(capsys, "start", "--hours", "3", "--at", START_ARG)
    assert code == 0 and out["day"]["status"] == "active"
    assert out["warnings"] == ["observation log write failed: observation log is busy"]

    code, out = run(capsys, "end")
    assert code == 0 and "warnings" in out
    assert run(capsys, "status") == (0, {"ok": True, "active": False})
