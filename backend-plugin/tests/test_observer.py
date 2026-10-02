"""The Observer: report building (pure) and `decision observer ...` (read-only standups)."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cli  # noqa: E402
import cli_observer_cmds as oc  # noqa: E402
import db  # noqa: E402
import observation_log as obs  # noqa: E402
import observer  # noqa: E402

START = datetime(2026, 10, 2, 9, 0, tzinfo=timezone(timedelta(hours=-7)))


def task(identifier, status, title=None):
    return {"id": identifier, "status": status, "title": title or f"Task {identifier}"}


# --- pure: slots ----------------------------------------------------------------------

@pytest.mark.parametrize("seconds, slot", [(-60, 0), (0, 0), (1199, 0), (1200, 1), (3600, 3), (3600 + 1199, 3), (3600 + 1200, 4)])
def test_standup_slots_are_twenty_minutes_from_the_day_start(seconds, slot):
    assert observer.standup_slot(1000.0, 1000.0 + seconds) == slot


# --- pure: kanban ---------------------------------------------------------------------

def test_parse_tasks_accepts_a_list_or_a_wrapping_dict_and_ignores_junk():
    items = [{"id": 1}, "junk", 3, {"id": 2}]
    assert observer.parse_tasks(items) == [{"id": 1}, {"id": 2}]
    assert observer.parse_tasks({"tasks": items}) == [{"id": 1}, {"id": 2}]
    assert observer.parse_tasks({"items": items}) == [{"id": 1}, {"id": 2}]
    assert observer.parse_tasks({"nope": items}) == [] and observer.parse_tasks(None) == []


def test_summarize_kanban_counts_per_board_and_in_total():
    summary = observer.summarize_kanban([
        {"board": "main", "tasks": [task(1, "running"), task(2, "blocked"), task(3, "done"), task(4, "archived"), task(5, "mystery")]},
        {"board": "side", "tasks": [task(6, "blocked"), task(7, "blocked")]},
    ])
    assert summary["boards"][0] == {
        "board": "main", "counts": {"running": 1, "blocked": 1, "done": 1, "unknown": 1},
        "blocked": [{"id": 2, "title": "Task 2"}],
    }
    assert summary["totals"] == {"running": 1, "blocked": 3, "done": 1, "unknown": 1}


def test_only_the_first_few_blocked_tasks_are_listed_but_all_are_counted():
    boards = [{"board": "b", "tasks": [task(n, "blocked") for n in range(12)]}]
    summary = observer.summarize_kanban(boards)
    assert len(summary["boards"][0]["blocked"]) == observer.MAX_LISTED_BLOCKED
    assert summary["totals"]["blocked"] == 12


def test_kanban_delta_reports_only_changes():
    assert observer.kanban_delta({"done": 3, "running": 1}, None) == {}
    assert observer.kanban_delta({"done": 3, "running": 1}, {"done": 1, "running": 1, "blocked": 2}) == {"blocked": -2, "done": 2}
    assert observer.kanban_delta({}, {}) == {}


# --- pure: attention --------------------------------------------------------------------

def attention(**overrides):
    base = dict(
        kanban={"available": True, "error": None, "boards": [], "totals": {}},
        decisions={"pending": 0, "urgent": 0}, minutes_left=40, hour_kind="work", delta={},
    )
    return observer.attention(**{**base, **overrides})


def test_nothing_needs_attention_when_everything_is_quiet():
    assert attention() == []


def test_attention_lists_blocked_tasks_urgent_and_pending_decisions_in_that_order():
    kanban = {"available": True, "error": None, "totals": {"blocked": 2},
              "boards": [{"board": "b", "blocked": [{"id": 1, "title": "Wire auth"}, {"id": 2, "title": "Fix CI"}]}]}
    assert attention(kanban=kanban, decisions={"pending": 5, "urgent": 2}) == [
        "2 tasks blocked: Wire auth; Fix CI", "2 urgent decisions waiting", "3 decisions pending",
    ]
    assert attention(decisions={"pending": 1, "urgent": 1}) == ["1 urgent decision waiting"]


def test_attention_says_when_kanban_could_not_be_read():
    kanban = {"available": False, "error": "FileNotFoundError: hermes", "boards": [], "totals": {}}
    assert attention(kanban=kanban) == ["Kanban could not be read: FileNotFoundError: hermes"]


def test_wrap_up_warning_only_in_work_hours_and_only_near_the_end():
    assert attention(minutes_left=10) == ["10 minutes left in this hour"]
    assert attention(minutes_left=1) == ["1 minute left in this hour"]
    assert attention(minutes_left=11) == []
    assert attention(minutes_left=5, hour_kind="retro") == []


def test_progress_since_the_last_standup_is_reported_only_when_it_is_good_news():
    assert attention(delta={"done": 2, "review": 1, "blocked": 3}) == [
        "Since the last standup: +2 done", "Since the last standup: +1 review",
    ]
    assert attention(delta={"done": -1}) == []


# --- CLI ------------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def hermes_home(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    monkeypatch.delenv(db._DELEGATED_CHILD_ENV_MARKER, raising=False)


@pytest.fixture
def kanban(monkeypatch):
    state = {"result": {"available": True, "error": None, "boards": [
        {"board": "main", "tasks": [task(1, "running"), task(2, "blocked", "Wire auth"), task(3, "done")]},
    ]}}
    monkeypatch.setattr(oc, "read_kanban", lambda: state["result"])
    return state


def run(capsys, *argv):
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    args = parser.parse_args(list(argv))
    code = 0
    try:
        args.func(args)
    except SystemExit as exit_:
        code = exit_.code
    return code, json.loads(capsys.readouterr().out)


def at(minutes):
    return (START + timedelta(minutes=minutes)).isoformat()


def standup(capsys, minutes, present=True):
    """Ask for a standup `minutes` after the day start. `present` first records the
    human as online at that moment, so the idle expiry does not interfere."""
    if present:
        assert run(capsys, "presence", "on", "--now", at(minutes))[0] == 0
    return run(capsys, "observer", "standup", "--now", at(minutes))


def begin(capsys, hours=5, online=True):
    assert run(capsys, "day", "start", "--hours", str(hours), "--at", at(0))[0] == 0
    if online:
        assert run(capsys, "presence", "on", "--now", at(0))[0] == 0


def standups():
    return obs.read(db.db_path().parent / "observations.jsonl", kind="standup")


def test_skips_when_offline_with_no_day_before_the_start_and_in_retro_hours(capsys, kanban):
    assert standup(capsys, 80, present=False)[1] == {"ok": True, "reported": False, "skipped": "offline"}
    assert standup(capsys, 80)[1]["skipped"] == "no_active_day"

    begin(capsys, hours=12, online=False)
    assert standup(capsys, -30)[1]["skipped"] == "day_not_in_progress"
    assert standup(capsys, 25)[1]["skipped"] == "retro_hour"           # block 1, retro hour
    assert standup(capsys, 6 * 60 + 25)[1]["skipped"] == "retro_hour"  # block 2's retro hour
    assert standups() == []


def test_a_due_standup_reports_the_clock_kanban_decisions_and_attention(capsys, kanban, monkeypatch):
    monkeypatch.setattr(db, "list_pending", lambda conn, **kw: [{"urgency": "high"}, {"urgency": "normal"}, {"urgency": "normal"}])
    begin(capsys)
    run(capsys, "day", "hat", "--hat", "review")

    code, out = standup(capsys, 80)  # 20 minutes into work hour 1
    assert code == 0 and out["reported"] is True
    record = out["standup"]
    assert (record["kind"], record["author"], record["day"], record["block"], record["hour"]) == ("standup", "observer", "2026-10-02", 1, 2)
    report = record["data"]
    assert (report["slot"], report["hour_kind"], report["ceremony"]) == (4, "work", "refinement")
    assert (report["minutes_elapsed"], report["minutes_left"]) == (20, 40)
    assert report["kanban"]["totals"] == {"running": 1, "blocked": 1, "done": 1}
    assert report["decisions"] == {"pending": 3, "urgent": 1}
    assert report["current_hat"] == "review"
    assert report["attention"] == ["1 task blocked: Wire auth", "1 urgent decision waiting", "2 decisions pending"]


def test_a_slot_is_reported_once_and_the_next_slot_reports_progress(capsys, kanban):
    begin(capsys)
    assert standup(capsys, 80)[1]["reported"] is True
    assert standup(capsys, 85)[1] == {"ok": True, "reported": False, "skipped": "already_reported"}
    assert len(standups()) == 1

    kanban["result"]["boards"][0]["tasks"] += [task(4, "done"), task(5, "done")]
    run(capsys, "day", "hat", "--hat", "spec")
    second = standup(capsys, 100)[1]["standup"]["data"]
    assert second["slot"] == 5
    assert second["kanban_delta"] == {"done": 2}
    assert second["since_last"]["by_kind"] == {"hat_switch": 1}
    assert "Since the last standup: +2 done" in second["attention"]


def test_the_standup_record_is_the_only_thing_it_writes(capsys, kanban):
    begin(capsys)

    def database_dump():
        conn = db.connect()
        try:
            return "\n".join(conn.iterdump())
        finally:
            conn.close()

    run(capsys, "presence", "on", "--now", at(80))  # the human is here; that is not the Observer's doing
    before_db, before_records = database_dump(), len(obs.read(db.db_path().parent / "observations.jsonl"))
    assert run(capsys, "observer", "standup", "--now", at(80))[1]["reported"] is True
    assert database_dump() == before_db
    assert len(obs.read(db.db_path().parent / "observations.jsonl")) == before_records + 1


def test_an_unreadable_kanban_is_reported_not_fatal(capsys, kanban):
    kanban["result"] = {"available": False, "error": "FileNotFoundError: hermes", "boards": []}
    begin(capsys)
    report = standup(capsys, 80)[1]["standup"]["data"]
    assert report["kanban"]["available"] is False and report["kanban"]["boards"] == []
    assert report["attention"] == ["Kanban could not be read: FileNotFoundError: hermes"]


def test_an_idle_expiry_found_by_the_observer_is_settled_and_skips(capsys, kanban):
    begin(capsys)
    assert standup(capsys, 130, present=False)[1]["skipped"] == "offline"  # online since minute 0, never touched
    presence_records = obs.read(db.db_path().parent / "observations.jsonl", kind="presence")
    assert [r["data"].get("reason") for r in presence_records] == ["manual", "idle"]


def test_latest_returns_the_newest_standup_of_the_active_day(capsys, kanban):
    assert run(capsys, "observer", "latest") == (0, {"ok": True, "standup": None})
    begin(capsys)
    assert run(capsys, "observer", "latest")[1]["standup"] is None
    standup(capsys, 80)
    standup(capsys, 100)
    assert run(capsys, "observer", "latest")[1]["standup"]["data"]["slot"] == 5


# --- reading Kanban ---------------------------------------------------------------------

class _Completed:
    def __init__(self, payload):
        self.stdout = json.dumps(payload)


def test_read_kanban_lists_boards_then_each_boards_tasks(monkeypatch):
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        if argv[2:4] == ["boards", "list"]:
            return _Completed([{"slug": "main"}, {"slug": "side"}, {"name": "no slug"}])
        return _Completed({"tasks": [{"id": argv[3], "status": "running"}]})

    monkeypatch.setattr(oc.subprocess, "run", fake_run)
    result = oc.read_kanban()

    assert result == {"available": True, "error": None, "boards": [
        {"board": "main", "tasks": [{"id": "main", "status": "running"}]},
        {"board": "side", "tasks": [{"id": "side", "status": "running"}]},
    ]}
    assert calls[0] == ["hermes", "kanban", "boards", "list", "--json"]
    assert calls[1] == ["hermes", "kanban", "--board", "main", "list", "--json"]


@pytest.mark.parametrize("failure", [
    FileNotFoundError("hermes"), subprocess.TimeoutExpired("hermes", 8),
    subprocess.CalledProcessError(1, "hermes"), ValueError("bad json"),
])
def test_read_kanban_turns_any_failure_into_data(monkeypatch, failure):
    def fail(argv, **kwargs):
        raise failure

    monkeypatch.setattr(oc.subprocess, "run", fail)
    result = oc.read_kanban()
    assert result["available"] is False and result["boards"] == [] and result["error"]
