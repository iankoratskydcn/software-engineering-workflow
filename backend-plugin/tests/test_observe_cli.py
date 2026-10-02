"""CLI contracts for `decision observe ...` against a real temp Hermes home."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cli  # noqa: E402
import db  # noqa: E402
import observation_log as obs  # noqa: E402


@pytest.fixture(autouse=True)
def hermes_home(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    monkeypatch.delenv(db._DELEGATED_CHILD_ENV_MARKER, raising=False)
    return tmp_path


def _parser():
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    return parser


def run(capsys, *argv):
    """Run one CLI invocation; return (exit_code, parsed JSON output)."""
    args = _parser().parse_args(["observe", *argv])
    code = 0
    try:
        args.func(args)
    except SystemExit as exit_:
        code = exit_.code
    return code, json.loads(capsys.readouterr().out)


def log_file() -> Path:
    return db.db_path().parent / "observations.jsonl"


def add_note(capsys, n=1):
    code, out = run(capsys, "add", "--kind", "note", "--author", "human", "--data", json.dumps({"n": n}))
    assert code == 0 and out["ok"]
    return out["record"]


def token() -> str:
    return db.issue_actor_token("owner-test")


def checkpoint_count() -> int:
    conn = db.connect()
    try:
        return len(db.list_observation_checkpoints(conn))
    finally:
        conn.close()


# --- shape of the interface --------------------------------------------------

def test_there_is_no_edit_or_delete_verb():
    observe = next(
        action for action in _parser()._subparsers._group_actions[0].choices["observe"]._actions
        if isinstance(action, argparse._SubParsersAction)
    )
    assert set(observe.choices) == {"add", "list", "verify", "checkpoint"}


@pytest.mark.parametrize("flag", ["--ts", "--now", "--timestamp", "--seq", "--prev-hash", "--id"])
def test_add_cannot_set_timestamp_or_chain_fields(flag, capsys):
    with pytest.raises(SystemExit) as exit_:
        _parser().parse_args(["observe", "add", "--kind", "note", "--author", "human", flag, "x"])
    assert exit_.value.code == 2
    capsys.readouterr()


# --- add / list --------------------------------------------------------------

def test_add_then_list_round_trip(capsys):
    first = add_note(capsys, 1)
    code, out = run(
        capsys, "add", "--kind", "estimate_actual", "--author", "scrum_master",
        "--data", '{"estimate": 3}', "--feature-id", "spec_1", "--day", "2026-10-02",
        "--block", "1", "--hour", "2", "--supersedes", first["id"],
    )
    assert code == 0
    second = out["record"]
    assert second["seq"] == 2 and second["prev_hash"] == obs.hash_line(log_file().read_bytes().split(b"\n")[0])
    assert (second["feature_id"], second["day"], second["block"], second["hour"]) == ("spec_1", "2026-10-02", 1, 2)

    code, out = run(capsys, "list")
    assert code == 0 and [r["seq"] for r in out["records"]] == [1, 2]
    assert [r["seq"] for r in run(capsys, "list", "--kind", "note")[1]["records"]] == [1]
    assert [r["seq"] for r in run(capsys, "list", "--limit", "1")[1]["records"]] == [2]
    assert [r["seq"] for r in run(capsys, "list", "--feature-id", "spec_1")[1]["records"]] == [2]
    assert [r["seq"] for r in run(capsys, "list", "--since-seq", "1")[1]["records"]] == [2]


def test_list_on_a_missing_log_is_empty(capsys):
    assert run(capsys, "list") == (0, {"ok": True, "records": []})


@pytest.mark.parametrize("extra", [
    ["--data", "not json"],
    ["--data", "[1, 2]"],
    ["--day", "yesterday"],
    ["--block", "-1"],
    ["--supersedes", "obs_missing"],
])
def test_invalid_add_is_rejected_with_the_standard_envelope(extra, capsys):
    code, out = run(capsys, "add", "--kind", "note", "--author", "human", *extra)
    assert code == 2 and out["ok"] is False and out["error"]["code"] == "invalid_input"
    assert not log_file().exists()


@pytest.mark.parametrize("flag, value", [("--kind", "bogus"), ("--author", "nobody")])
def test_unknown_kind_or_author_is_rejected_by_the_parser(flag, value):
    argv = ["observe", "add", "--kind", "note", "--author", "human"]
    argv[argv.index(flag) + 1] = value
    with pytest.raises(SystemExit) as exit_:
        _parser().parse_args(argv)
    assert exit_.value.code == 2


# --- verify ------------------------------------------------------------------

def test_verify_passes_on_a_clean_log_and_fails_on_tampering(capsys):
    for n in range(1, 5):
        add_note(capsys, n)
    code, out = run(capsys, "verify")
    assert code == 0 and out["ok"] and out["verification"]["records"] == 4

    lines = log_file().read_bytes().split(b"\n")
    lines[1] = lines[1].replace(b'"n":2', b'"n":99')
    log_file().write_bytes(b"\n".join(lines))

    code, out = run(capsys, "verify")
    assert code == 6 and out["ok"] is False and out["error"]["code"] == "integrity_failed"
    assert out["verification"]["problems"][0]["code"] == "broken_chain"


# --- checkpoint --------------------------------------------------------------

def test_checkpoint_records_the_current_head_for_the_token_holder(capsys):
    for n in range(1, 4):
        add_note(capsys, n)
    code, out = run(capsys, "checkpoint", "--actor-token", token())

    assert code == 0 and out["ok"]
    head = obs.verify(log_file())["head"]
    assert (out["checkpoint"]["seq"], out["checkpoint"]["head_hash"]) == (head["seq"], head["hash"])
    assert out["checkpoint"]["confirmed_by"] == "owner-test"
    code, again = run(capsys, "checkpoint", "--actor-token", token())
    assert code == 0 and again["checkpoint"]["id"] == out["checkpoint"]["id"]  # idempotent
    assert checkpoint_count() == 1


def test_checkpoint_needs_a_valid_actor_token(capsys):
    add_note(capsys)
    code, out = run(capsys, "checkpoint", "--actor-token", "not-a-real-token")
    assert code == 7 and out["error"]["code"] == "not_authorized"
    assert checkpoint_count() == 0


def test_checkpoint_is_refused_in_a_delegated_child_process(capsys, monkeypatch):
    add_note(capsys)
    valid = token()
    monkeypatch.setenv(db._DELEGATED_CHILD_ENV_MARKER, "1")
    code, out = run(capsys, "checkpoint", "--actor-token", valid)
    assert code == 7 and out["error"]["code"] == "not_authorized"
    assert checkpoint_count() == 0


def test_checkpoint_refuses_to_bless_a_log_that_already_fails_verification(capsys):
    for n in range(1, 4):
        add_note(capsys, n)
    lines = log_file().read_bytes().split(b"\n")
    lines[0] = lines[0].replace(b'"n":1', b'"n":99')
    log_file().write_bytes(b"\n".join(lines))

    code, out = run(capsys, "checkpoint", "--actor-token", token())
    assert code == 6 and out["error"]["code"] == "integrity_failed"
    assert checkpoint_count() == 0


def test_checkpoint_on_an_empty_log_is_invalid(capsys):
    code, out = run(capsys, "checkpoint", "--actor-token", token())
    assert code == 2 and out["error"]["code"] == "invalid_input"


def test_verify_uses_stored_checkpoints_to_catch_truncation(capsys):
    for n in range(1, 6):
        add_note(capsys, n)
    assert run(capsys, "checkpoint", "--actor-token", token())[0] == 0

    log_file().write_bytes(b"\n".join(log_file().read_bytes().split(b"\n")[:3]) + b"\n")
    code, out = run(capsys, "verify")
    assert code == 6
    assert {p["code"] for p in out["verification"]["problems"]} == {"checkpoint_beyond_log"}


def test_a_log_that_ends_mid_line_is_reported_not_extended(capsys):
    add_note(capsys, 1)
    add_note(capsys, 2)
    log_file().write_bytes(log_file().read_bytes()[:-10])
    code, out = run(capsys, "add", "--kind", "note", "--author", "human")
    assert code == 4 and out["error"]["code"] == "conflict"
