"""Hostile RED contracts for the Architecture backend/CLI surface.

This file is intentionally test-only: current HEAD does not implement the
architecture diagram API. The tests freeze the required project-scoped,
closed-schema, bounded JSON contract before production work begins.
"""
from __future__ import annotations

import argparse
import inspect
import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
import sys

sys.path.insert(0, str(ROOT))
import cli  # noqa: E402
import db  # noqa: E402


MAX_COORDINATE = 100_000


def _conn(tmp_path: Path, monkeypatch) -> sqlite3.Connection:
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


def _nodes():
    return [
        {"id": "api", "label": "API", "x": 10, "y": -20},
        {"id": "db", "label": "Database", "x": 80.5, "y": 40},
    ]


def _edges():
    return [{"source": "api", "target": "db", "label": "reads"}]


def test_architecture_api_requires_project_id_for_every_read_and_write():
    for name in ("add_diagram", "set_diagram", "get_diagram", "list_diagrams"):
        signature = inspect.signature(getattr(db, name))
        assert signature.parameters["project_id"].default is inspect.Parameter.empty


def test_architecture_is_project_scoped_and_reverse_lookup_cannot_cross_projects(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    first = db.add_diagram(conn, project_id="p_1", title="Demo", nodes=_nodes(), edges=_edges())
    second = db.add_diagram(conn, project_id="p_2", title="Other", nodes=_nodes(), edges=_edges())

    assert [row["id"] for row in db.list_diagrams(conn, project_id="p_1")] == [first["id"]]
    assert db.get_diagram(conn, project_id="p_1", diagram_id=first["id"])["project_id"] == "p_1"
    with pytest.raises((ValueError, KeyError, sqlite3.IntegrityError)):
        db.get_diagram(conn, project_id="p_2", diagram_id=first["id"])
    with pytest.raises((ValueError, KeyError, sqlite3.IntegrityError)):
        db.set_diagram(conn, project_id="p_2", diagram_id=first["id"], nodes=_nodes(), edges=_edges())
    assert db.get_diagram(conn, project_id="p_2", diagram_id=second["id"])["project_id"] == "p_2"


def test_architecture_nodes_and_edges_are_closed_and_relationships_are_validated(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    diagram = db.add_diagram(conn, project_id="p_1", title="Demo", nodes=_nodes(), edges=_edges())
    original = db.get_diagram(conn, project_id="p_1", diagram_id=diagram["id"])

    invalid_payloads = [
        ([{"id": "x", "label": "X", "x": 0, "y": 0, "extra": True}], _edges()),
        ([{"id": "x", "label": "X", "x": "0", "y": 0}], []),
        ([{"id": "x", "label": "X", "x": 0, "y": 0}], [{"source": "x", "target": "missing"}]),
        ([{"id": "x", "label": "X", "x": 0, "y": 0}, {"id": "x", "label": "Again", "x": 1, "y": 1}], []),
        ([{"id": "x", "label": "X", "x": 0, "y": 0}], [{"source": "x", "target": "x", "label": "ok", "extra": 1}]),
    ]
    for nodes, edges in invalid_payloads:
        with pytest.raises((TypeError, ValueError)):
            db.set_diagram(conn, project_id="p_1", diagram_id=diagram["id"], nodes=nodes, edges=edges)
        assert db.get_diagram(conn, project_id="p_1", diagram_id=diagram["id"]) == original


def test_architecture_coordinates_are_finite_and_bounded_without_mutation(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    diagram = db.add_diagram(conn, project_id="p_1", title="Demo", nodes=_nodes(), edges=_edges())
    original = db.get_diagram(conn, project_id="p_1", diagram_id=diagram["id"])
    for value in (float("nan"), float("inf"), -MAX_COORDINATE - 1, MAX_COORDINATE + 1):
        with pytest.raises((TypeError, ValueError)):
            db.set_diagram(
                conn,
                project_id="p_1",
                diagram_id=diagram["id"],
                nodes=[{"id": "x", "label": "X", "x": value, "y": 0}],
                edges=[],
            )
        assert db.get_diagram(conn, project_id="p_1", diagram_id=diagram["id"]) == original


def test_architecture_drill_targets_must_exist_in_the_same_project(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    target = db.add_diagram(conn, project_id="p_1", title="Target", nodes=[], edges=[])
    other = db.add_diagram(conn, project_id="p_2", title="Other", nodes=[], edges=[])
    valid = [{"id": "api", "label": "API", "x": 0, "y": 0, "drill_to_diagram_id": target["id"]}]
    result = db.add_diagram(conn, project_id="p_1", title="Root", nodes=valid, edges=[])
    assert json.loads(result["nodes_json"])[0]["drill_to_diagram_id"] == target["id"]
    for bad_target in ("missing", other["id"]):
        with pytest.raises((ValueError, KeyError, sqlite3.IntegrityError)):
            db.set_diagram(
                conn,
                project_id="p_1",
                diagram_id=result["id"],
                nodes=[{**valid[0], "drill_to_diagram_id": bad_target}],
                edges=[],
            )


def test_architecture_aggregate_json_is_bounded_before_persisting(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    before = conn.execute("SELECT COUNT(*) FROM architecture_diagrams").fetchone()[0]
    huge_nodes = [{"id": str(i), "label": "n", "x": 0, "y": 0} for i in range(513)]
    with pytest.raises((TypeError, ValueError)):
        db.add_diagram(conn, project_id="p_1", title="Too many", nodes=huge_nodes, edges=[])
    assert conn.execute("SELECT COUNT(*) FROM architecture_diagrams").fetchone()[0] == before


def test_architecture_cli_requires_project_scope_and_emits_one_stable_error_envelope(monkeypatch):
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    with pytest.raises(SystemExit):
        parser.parse_args(["architecture", "list"])

    printed = []
    monkeypatch.setattr(cli, "_print", printed.append)
    monkeypatch.setattr(cli.db, "connect", lambda: (_ for _ in ()).throw(ValueError("invalid architecture")))
    with pytest.raises(SystemExit) as exc:
        cli._cmd_architecture_list(SimpleNamespace(project_id="p_1"))
    assert exc.value.code == 2
    assert printed == [{
        "ok": False,
        "error": {"code": "invalid_input", "message": "invalid architecture"},
    }]
