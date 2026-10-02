"""The online switch: pure rules and the `decision presence ...` CLI."""
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
import presence  # noqa: E402

T = datetime(2026, 10, 2, 9, 0, tzinfo=timezone(timedelta(hours=-7)))
T0 = T.timestamp()


# --- pure rules ------------------------------------------------------------------

def test_a_never_used_switch_is_offline():
    assert presence.evaluate(None, T0) == {
        "online": False, "since": None, "last_seen": None, "expired": False, "expired_at": None,
    }
    assert presence.evaluate({"online": False, "since": None, "last_seen": T0}, T0)["expired"] is False


def test_the_switch_expires_after_exactly_one_hour_without_interaction():
    state = presence.turned_on(T0)
    assert presence.evaluate(state, T0 + presence.IDLE_SECONDS - 1)["online"] is True
    expired = presence.evaluate(state, T0 + presence.IDLE_SECONDS)
    assert expired["online"] is False and expired["expired"] is True
    assert expired["expired_at"] == T0 + presence.IDLE_SECONDS


def test_a_heartbeat_moves_the_expiry_and_never_backwards():
    state = presence.touched(presence.turned_on(T0), T0 + 3000)
    assert presence.evaluate(state, T0 + 3000 + 3599)["online"] is True
    assert presence.touched(state, T0)["last_seen"] == T0 + 3000


def test_turning_off_clears_since_but_remembers_the_last_interaction():
    off = presence.turned_off(presence.touched(presence.turned_on(T0), T0 + 600))
    assert off == {"online": False, "since": None, "last_seen": T0 + 600}


# --- CLI ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def hermes_home(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    monkeypatch.delenv(db._DELEGATED_CHILD_ENV_MARKER, raising=False)


def run(capsys, verb, minutes=0):
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    args = parser.parse_args(["presence", verb, "--now", (T + timedelta(minutes=minutes)).isoformat()])
    args.func(args)
    out = json.loads(capsys.readouterr().out)
    assert out["ok"]
    return out["presence"]


def records():
    return obs.read(db.db_path().parent / "observations.jsonl", kind="presence")


def test_status_starts_offline_and_writes_nothing(capsys):
    assert run(capsys, "status")["online"] is False
    assert records() == []


def test_on_and_off_are_logged_once_each(capsys):
    on = run(capsys, "on")
    assert on["online"] and on["changed"] and on["since"] == "2026-10-02T16:00:00Z"
    assert run(capsys, "on", minutes=5)["changed"] is False  # already on: no second record
    off = run(capsys, "off", minutes=10)
    assert off["online"] is False and off["changed"] is True
    assert run(capsys, "off", minutes=11)["changed"] is False

    assert [(r["author"], r["data"]) for r in records()] == [
        ("human", {"state": "on", "reason": "manual"}),
        ("human", {"state": "off", "reason": "manual"}),
    ]


def test_touch_never_turns_the_switch_on_and_never_logs(capsys):
    assert run(capsys, "touch")["online"] is False
    run(capsys, "on")
    touched = run(capsys, "touch", minutes=50)
    assert touched["online"] and touched["last_seen"] == "2026-10-02T16:50:00Z"
    assert len(records()) == 1  # only the "on"


def test_a_heartbeat_keeps_you_online_past_an_hour_from_the_start(capsys):
    run(capsys, "on")
    run(capsys, "touch", minutes=50)
    assert run(capsys, "status", minutes=100)["online"] is True   # 50 minutes after the heartbeat
    assert run(capsys, "status", minutes=111)["online"] is False  # an hour after it


def test_idle_expiry_is_settled_once_and_logged_with_when_it_expired(capsys):
    run(capsys, "on")

    expired = run(capsys, "status", minutes=61)
    assert expired["online"] is False and expired["auto_off"] is True
    assert run(capsys, "status", minutes=62)["auto_off"] is False  # already settled

    assert [(r["author"], r["data"]) for r in records()] == [
        ("human", {"state": "on", "reason": "manual"}),
        ("system", {"state": "off", "reason": "idle", "expired_at": "2026-10-02T17:00:00Z"}),
    ]


def test_expiry_is_settled_by_any_command_not_only_status(capsys):
    run(capsys, "on")
    assert run(capsys, "touch", minutes=90)["auto_off"] is True
    run(capsys, "on")  # a stale heartbeat did not revive it; this is a fresh on
    run(capsys, "on", minutes=200)
    assert [r["data"]["state"] for r in records()] == ["on", "off", "on", "off", "on"]


def test_off_after_an_unnoticed_expiry_reports_it_without_a_second_off(capsys):
    run(capsys, "on")
    off = run(capsys, "off", minutes=120)
    assert off["online"] is False and off["auto_off"] is True and off["changed"] is False
    assert [r["data"].get("reason") for r in records()] == ["manual", "idle"]


def test_an_unreadable_stored_value_means_offline_never_stuck_on(capsys):
    conn = db.connect()
    try:
        db.set_setting(conn, "presence", "{not json")
    finally:
        conn.close()
    assert run(capsys, "status")["online"] is False
    assert run(capsys, "on")["online"] is True


def test_a_failing_log_write_warns_but_the_switch_still_changes(capsys, monkeypatch):
    def broken(*args, **kwargs):
        raise obs.LogBusy("observation log is busy")

    monkeypatch.setattr(obs, "append", broken)
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    args = parser.parse_args(["presence", "on", "--now", T.isoformat()])
    args.func(args)
    out = json.loads(capsys.readouterr().out)

    assert out["presence"]["online"] is True
    assert out["warnings"] == ["observation log write failed: observation log is busy"]
    assert run(capsys, "status")["online"] is True
