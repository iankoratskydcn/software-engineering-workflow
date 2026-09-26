"""Hostile RED acceptance contracts for project-scoped flowcharts.

These tests intentionally target the frozen stage-2 contract and are written
against the historical flowchart API shape; production implementation is not
part of this branch.
"""
from __future__ import annotations

import inspect
import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
import sys

sys.path.insert(0, str(ROOT))
import db  # noqa: E402
import cli  # noqa: E402


PROJECTS = ("p_1", "p_2")


def _conn(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    projects = sqlite3.connect(tmp_path / "projects.db")
    projects.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT)")
    projects.executemany(
        "INSERT INTO projects VALUES (?, ?, ?)",
        [("p_1", "demo", "Demo"), ("p_2", "other", "Other")],
    )
    projects.commit()
    projects.close()
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    db.init_db(conn)
    return conn


def _flow(conn, project="p_1"):
    return db.create_flow(conn, project_id=project, name="Original")


def _steps(*steps):
    return list(steps)


def _row_json(conn, flow_id):
    return conn.execute("SELECT steps_json FROM flows WHERE id = ?", (flow_id,)).fetchone()[0]


def test_schema_is_closed_project_scoped_and_sqlite_constrained(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    try:
        assert {row["name"] for row in conn.execute("PRAGMA table_info(flows)")} == {
            "id", "project_id", "name", "steps_json", "created_at", "updated_at",
        }
        sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='flows'"
        ).fetchone()[0]
        assert "UNIQUE(project_id,id)" in sql.replace(" ", "")
        assert "steps_json TEXT NOT NULL" in sql
        assert db.create_flow(conn, project_id="p_1", name="A")["project_id"] == "p_1"
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO flows (id, project_id, name, steps_json, created_at, updated_at) "
                "VALUES ('same', 'p_1', 'A', '[]', 1, 1)"
            )
            conn.execute(
                "INSERT INTO flows (id, project_id, name, steps_json, created_at, updated_at) "
                "VALUES ('same', 'p_2', 'B', '[]', 1, 1)"
            )
    finally:
        conn.close()


def test_project_scope_covers_add_list_update_set_steps_and_reverse_lookup(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    try:
        own = _flow(conn, "p_1")
        other = _flow(conn, "p_2")
        assert [row["id"] for row in db.list_flows(conn, project_id="p_1")] == [own["id"]]
        assert [row["id"] for row in db.list_flows(conn, project_id="p_2")] == [other["id"]]
        with pytest.raises((ValueError, KeyError, sqlite3.IntegrityError)):
            db.update_flow(conn, own["id"], project_id="p_2", name="leak")
        with pytest.raises((ValueError, KeyError, sqlite3.IntegrityError)):
            db.set_flow_steps(conn, own["id"], project_id="p_2", steps=[])
        assert db.update_flow(conn, own["id"], project_id="p_1", name="Renamed")["name"] == "Renamed"
        assert db.list_flows(conn, project_id="p_2")[0]["name"] == "Original"
        assert inspect.signature(db.update_flow).parameters["project_id"].default is inspect.Parameter.empty
        assert inspect.signature(db.set_flow_steps).parameters["project_id"].default is inspect.Parameter.empty
    finally:
        conn.close()


def test_closed_step_schema_rejects_unknown_keys_wrong_types_duplicates_edges_and_dangling_targets(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    try:
        flow = _flow(conn)
        valid = _steps({"id": "start", "label": "Start", "next": ["done"]}, {"id": "done", "label": "Done", "next": []})
        db.set_flow_steps(conn, flow["id"], project_id="p_1", steps=valid)
        original = _row_json(conn, flow["id"])
        invalid = [
            [{"id": "x", "label": "X", "next": [], "extra": 1}],
            [{"id": "x", "label": "X", "next": "done"}],
            [{"id": "x", "label": "X", "next": [1]}],
            [{"id": "x", "label": "X", "next": ["missing"]}],
            [{"id": "x", "label": "X", "next": ["y", "y"]}, {"id": "y", "label": "Y", "next": []}],
            [{"id": "x", "label": "X", "next": []}, {"id": "x", "label": "Again", "next": []}],
            [{"id": "x", "label": "X", "next": []}],
        ]
        invalid[-1][0]["id"] = "x" * 129
        for bad in invalid:
            with pytest.raises((TypeError, ValueError)):
                db.set_flow_steps(conn, flow["id"], project_id="p_1", steps=bad)
            assert _row_json(conn, flow["id"]) == original
    finally:
        conn.close()


@pytest.mark.parametrize("graph", [
    [],
    [{"id": "a", "label": "A", "next": ["b"]}, {"id": "b", "label": "B", "next": ["a"]}],
    [{"id": "a", "label": "A", "next": []}, {"id": "isolated", "label": "I", "next": []}],
])
def test_empty_cycles_and_disconnected_graphs_are_allowed(tmp_path, monkeypatch, graph):
    conn = _conn(tmp_path, monkeypatch)
    try:
        flow = _flow(conn)
        assert json.loads(db.set_flow_steps(conn, flow["id"], project_id="p_1", steps=graph)["steps_json"]) == graph
    finally:
        conn.close()


def test_step_list_id_label_edge_and_aggregate_bounds_reject_without_mutation(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    try:
        flow = _flow(conn)
        db.set_flow_steps(conn, flow["id"], project_id="p_1", steps=[{"id": "ok", "label": "OK", "next": []}])
        original = _row_json(conn, flow["id"])
        cases = [
            [{"id": str(i), "label": "x", "next": []} for i in range(513)],
            [{"id": "x", "label": "x", "next": [str(i) for i in range(33)]}]
            + [{"id": str(i), "label": str(i), "next": []} for i in range(33)],
            [{"id": "x", "label": "x" * 4097, "next": []}],
        ]
        for bad in cases:
            with pytest.raises((TypeError, ValueError)):
                db.set_flow_steps(conn, flow["id"], project_id="p_1", steps=bad)
            assert _row_json(conn, flow["id"]) == original
    finally:
        conn.close()


def test_raw_oversized_json_is_rejected_before_json_parse(monkeypatch):
    assert hasattr(cli, "_cmd_flow_set_steps")
    raw = "[" + " " * 262144 + "]"
    monkeypatch.setattr(cli.json, "loads", lambda _: pytest.fail("oversized input was parsed"))
    with pytest.raises((TypeError, ValueError, SystemExit), match="(?i)(size|large|bound|json)"):
        cli._cmd_flow_set_steps(SimpleNamespace(
            flow_id="flow_x", project_id="p_1", steps=raw,
        ))


def test_rejected_create_and_set_steps_do_not_mutate_rows(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    try:
        before = conn.execute("SELECT COUNT(*) FROM flows").fetchone()[0]
        with pytest.raises((TypeError, ValueError)):
            db.create_flow(conn, project_id="p_1", name="x" * 4097)
        assert conn.execute("SELECT COUNT(*) FROM flows").fetchone()[0] == before
        flow = _flow(conn)
        original = _row_json(conn, flow["id"])
        with pytest.raises((TypeError, ValueError)):
            db.set_flow_steps(conn, flow["id"], project_id="p_1", steps=[{"id": "x", "label": "X", "next": ["missing"]}])
        assert _row_json(conn, flow["id"]) == original
    finally:
        conn.close()


def test_cli_flow_commands_require_project_and_return_stable_error_envelopes(monkeypatch):
    parser = __import__("argparse").ArgumentParser()
    cli.setup(parser)
    with pytest.raises(SystemExit):
        parser.parse_args(["flow", "list"])
    assert hasattr(cli, "_run_node_command")
    monkeypatch.setattr(cli.db, "connect", lambda: (_ for _ in ()).throw(ValueError("bad input")))
    with pytest.raises(SystemExit) as exc:
        cli._cmd_flow_list(SimpleNamespace(project_id="p_1"))
    assert exc.value.code != 0


def test_cli_error_envelope_is_machine_readable_and_single_json_value(monkeypatch):
    printed = []
    monkeypatch.setattr(cli, "_print", printed.append)

    def fail(*_args, **_kwargs):
        raise ValueError("invalid flow steps")

    class _Conn:
        def close(self):
            pass

    monkeypatch.setattr(cli.db, "connect", lambda: _Conn())
    with pytest.raises(SystemExit):
        cli._run_node_command(fail, "flow", project_id="p_1")
    assert printed == [{
        "ok": False,
        "error": {"code": "invalid_input", "message": "invalid flow steps"},
    }]


@pytest.mark.parametrize("raw", ["[", "{not-json"])
def test_flow_set_steps_malformed_input_uses_one_nested_error_envelope(monkeypatch, raw):
    printed = []
    monkeypatch.setattr(cli, "_print", printed.append)
    with pytest.raises(SystemExit) as exc:
        cli._cmd_flow_set_steps(SimpleNamespace(
            flow_id="flow_x", project_id="p_1", steps=raw,
        ))
    assert exc.value.code == 2
    assert len(printed) == 1
    assert printed[0]["ok"] is False
    assert set(printed[0]["error"]) == {"code", "message"}
    assert printed[0]["error"]["code"] == "invalid_input"
    assert isinstance(printed[0]["error"]["message"], str)


def test_flow_set_steps_oversized_raw_input_envelopes_without_parsing(monkeypatch):
    printed = []
    monkeypatch.setattr(cli, "_print", printed.append)
    monkeypatch.setattr(cli.json, "loads", lambda _raw: pytest.fail("oversized input was parsed"))
    raw = "[" + (" " * (db.JSON_LIMIT + 1)) + "]"
    with pytest.raises(SystemExit) as exc:
        cli._cmd_flow_set_steps(SimpleNamespace(
            flow_id="flow_x", project_id="p_1", steps=raw,
        ))
    assert exc.value.code == 2
    assert len(printed) == 1
    assert printed[0]["ok"] is False
    assert set(printed[0]["error"]) == {"code", "message"}
    assert printed[0]["error"]["code"] == "invalid_input"
    assert isinstance(printed[0]["error"]["message"], str)


def test_flow_migration_matches_contract_and_user_version_is_monotonic(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    try:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 9
        columns = {
            row["name"]: (row["type"], row["notnull"], row["dflt_value"])
            for row in conn.execute("PRAGMA table_info(flows)")
        }
        assert columns["steps_json"] == ("TEXT", 1, "'[]'")
        assert columns["created_at"] == ("INTEGER", 1, None)
        assert columns["updated_at"] == ("INTEGER", 1, None)

        db.init_db(conn)
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 9
        conn.execute("PRAGMA user_version = 12")
        db.init_db(conn)
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 12
    finally:
        conn.close()
