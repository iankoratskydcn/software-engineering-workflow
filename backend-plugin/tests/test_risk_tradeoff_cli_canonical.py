"""Hostile CLI contracts for project-scoped Risk & Tradeoffs."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cli  # noqa: E402


class Conn:
    def close(self):
        pass


def parser():
    p = argparse.ArgumentParser()
    cli.setup(p)
    return p


def test_every_mutating_and_reading_risk_tradeoff_verb_requires_project_scope():
    commands = [
        ["risk", "add", "--title", "R"],
        ["risk", "list"],
        ["risk", "update-status", "r1", "--status", "closed"],
        ["tradeoff", "add", "--kind", "scale", "--title", "T", "--choice", "A"],
        ["tradeoff", "list"],
        ["tradeoff", "set-prioritized-side", "t1", "--side", "b"],
    ]
    for argv in commands:
        with pytest.raises(SystemExit):
            parser().parse_args(argv)


def test_cli_passes_canonical_fields_and_project_scope_to_db(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(cli.db, "connect", lambda: Conn())
    cases = [
        (
            ["risk", "add", "--project-id", "p1", "--title", "R", "--description", "D", "--breaks-when", "B", "--status", "accepted", "--decision-id", "d1"],
            "add_risk", {"project_id": "p1", "title": "R", "description": "D", "breaks_when": "B", "status": "accepted", "decision_id": "d1"}, "risk",
        ),
        (
            ["risk", "list", "--project-id", "p1"],
            "list_risks", {"project_id": "p1"}, "risks",
        ),
        (
            ["risk", "update-status", "--project-id", "p1", "r1", "--status", "closed"],
            "update_risk_status", {"project_id": "p1", "risk_id": "r1", "status": "closed"}, "risk",
        ),
        (
            ["tradeoff", "add", "--project-id", "p1", "--kind", "duel", "--title", "T", "--choice", "A", "--alt-label", "B", "--cost", "C", "--gain", "G", "--decision-id", "d1"],
            "add_tradeoff", {"project_id": "p1", "kind": "duel", "title": "T", "choice": "A", "alt_label": "B", "cost": "C", "gain": "G", "decision_id": "d1"}, "tradeoff",
        ),
        (
            ["tradeoff", "list", "--project-id", "p1"],
            "list_tradeoffs", {"project_id": "p1"}, "tradeoffs",
        ),
        (
            ["tradeoff", "set-prioritized-side", "--project-id", "p1", "t1", "--side", "b"],
            "set_prioritized_side", {"project_id": "p1", "tradeoff_id": "t1", "side": "b"}, "tradeoff",
        ),
    ]
    for argv, name, expected, key in cases:
        calls.clear()
        result = [] if key.endswith("s") else {"id": "x"}
        monkeypatch.setattr(cli.db, name, lambda conn, _result=result, **kwargs: calls.append(kwargs) or _result)
        args = parser().parse_args(argv)
        args.func(args)
        payload = json.loads(capsys.readouterr().out)
        assert payload["ok"] is True
        assert payload[key] == result
        assert calls == [expected]


def test_risk_cli_connection_failure_uses_stable_nested_json_error_envelope(monkeypatch, capsys):
    def fail_connect():
        raise cli.db.BoundaryError("constraint", "migration refused")

    monkeypatch.setattr(cli.db, "connect", fail_connect)
    args = parser().parse_args(["risk", "list", "--project-id", "p1"])
    with pytest.raises(SystemExit) as exc_info:
        args.func(args)
    assert exc_info.value.code == 6
    captured = capsys.readouterr()
    assert captured.out.splitlines() == [
        json.dumps({
            "ok": False,
            "error": {"code": "constraint", "message": "request violates a data constraint"},
        })
    ]
    assert captured.err == ""


def test_cli_errors_are_one_stable_json_envelope(monkeypatch, capsys):
    monkeypatch.setattr(cli.db, "connect", lambda: Conn())

    def reject(conn, **kwargs):
        raise cli.db.BoundaryError("invalid_input", "title is required")

    monkeypatch.setattr(cli.db, "add_risk", reject)
    args = parser().parse_args(["risk", "add", "--project-id", "p1", "--title", ""])
    with pytest.raises(SystemExit) as exc_info:
        args.func(args)
    assert exc_info.value.code == 2
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload == {"ok": False, "error": {"code": "invalid_input", "message": "title is required"}}
