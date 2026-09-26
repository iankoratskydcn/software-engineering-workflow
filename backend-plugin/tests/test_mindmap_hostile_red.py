"""Hostile RED contracts for the first MindMap backend/CLI slice."""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cli  # noqa: E402
import db  # noqa: E402


def _projects(tmp_path: Path) -> None:
    conn = sqlite3.connect(str(tmp_path / "projects.db"))
    conn.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT)")
    conn.executemany(
        "INSERT INTO projects VALUES (?, ?, ?)",
        [("p_1", "demo", "Demo"), ("p_2", "other", "Other")],
    )
    conn.commit()
    conn.close()


def _conn(tmp_path: Path, monkeypatch) -> sqlite3.Connection:
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _projects(tmp_path)
    conn = db.connect()
    conn.row_factory = sqlite3.Row
    return conn


def test_one_root_per_project_rejects_duplicate_without_mutation(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    root = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root")
    before = conn.execute(
        "SELECT id, project_id, kind, parent_id, title, decision_id FROM spec_nodes"
    ).fetchall()

    with pytest.raises((ValueError, db.BoundaryError, sqlite3.IntegrityError)):
        db.create_spec_node(conn, project_id="p_1", kind="theme", title="Duplicate")

    after = conn.execute(
        "SELECT id, project_id, kind, parent_id, title, decision_id FROM spec_nodes"
    ).fetchall()
    assert root["title"] == "Root"
    assert after == before


def test_two_writers_race_to_one_root_and_only_one_commits(tmp_path, monkeypatch):
    _conn(tmp_path, monkeypatch).close()
    barrier = threading.Barrier(2)

    def create(title: str) -> str:
        conn = db.connect()
        try:
            barrier.wait(timeout=5)
            db.create_spec_node(conn, project_id="p_1", kind="theme", title=title)
            return "created"
        except (ValueError, db.BoundaryError, sqlite3.IntegrityError):
            return "rejected"
        finally:
            conn.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(create, ("Writer A", "Writer B")))

    conn = db.connect()
    try:
        count = conn.execute(
            "SELECT COUNT(*) FROM spec_nodes WHERE project_id = ? AND parent_id IS NULL",
            ("p_1",),
        ).fetchone()[0]
    finally:
        conn.close()
    assert sorted(outcomes) == ["created", "rejected"]
    assert count == 1


def test_oversized_title_is_rejected_before_any_mutation(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    oversized = "x" * (db.TEXT_LIMIT + 1)

    with pytest.raises((ValueError, db.BoundaryError)):
        db.create_spec_node(conn, project_id="p_1", kind="theme", title=oversized)

    assert conn.execute("SELECT COUNT(*) FROM spec_nodes").fetchone()[0] == 0


def test_spec_tree_rejects_cross_project_parent_cycle_and_orphan(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    root = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root")
    other = db.create_spec_node(conn, project_id="p_2", kind="theme", title="Other")

    with pytest.raises((ValueError, db.BoundaryError), match="project"):
        db.create_spec_node(
            conn, project_id="p_1", kind="epic", title="Cross", parent_id=other["id"]
        )

    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute(
        "INSERT INTO spec_nodes "
        "(id, project_id, kind, parent_id, title, status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("orphan", "p_1", "theme", "missing", "Orphan", "draft", 0, 0),
    )
    conn.commit()
    with pytest.raises(ValueError, match="orphan"):
        db.get_spec_tree(conn, project_id="p_1")

    conn.execute("DELETE FROM spec_nodes WHERE id = ?", ("orphan",))
    conn.execute(
        "INSERT INTO spec_nodes "
        "(id, project_id, kind, parent_id, title, status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("a", "p_1", "theme", "b", "A", "draft", 0, 0),
    )
    conn.execute(
        "INSERT INTO spec_nodes "
        "(id, project_id, kind, parent_id, title, status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("b", "p_1", "epic", "a", "B", "draft", 0, 0),
    )
    conn.commit()
    with pytest.raises(ValueError, match="cycle"):
        db.get_spec_tree(conn, project_id="p_1")
    assert root["id"]


def test_tree_preserves_decision_link_across_node_update(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    decision = db.push_decision(
        conn, project_id="p_1", question="Choose?", choices=["A", "B"]
    )
    root = db.create_spec_node(
        conn,
        project_id="p_1",
        kind="theme",
        title="Root",
        decision_id=decision["id"],
    )
    db.update_spec_node(conn, root["id"], title="Renamed")
    tree = db.get_spec_tree(conn, project_id="p_1")
    assert tree["decision_id"] == decision["id"]


def test_cli_exposes_spec_tree_and_add_node_surface():
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    tree_args = parser.parse_args(["spec", "tree", "--project-id", "p_1"])
    add_args = parser.parse_args(
        [
            "spec",
            "add-node",
            "--kind",
            "theme",
            "--title",
            "Root",
            "--project-id",
            "p_1",
        ]
    )
    assert tree_args.func is not None
    assert add_args.func is not None


@pytest.mark.parametrize(
    "operation",
    ["create", "update", "archive", "link"],
)
def test_post_v12_legacy_hierarchy_writes_are_rejected(tmp_path, monkeypatch, operation):
    conn = _conn(tmp_path, monkeypatch)
    root = db.create_node(conn, project_id="p_1", parent_id=None, level=0, title="Root")
    parent = root
    for level in range(1, 5):
        parent = db.create_node(
            conn, project_id="p_1", parent_id=parent["id"], level=level, title=f"Level {level}"
        )
    story = parent
    before = conn.execute("SELECT * FROM hierarchy_nodes ORDER BY id").fetchall()

    with pytest.raises((ValueError, db.BoundaryError, sqlite3.IntegrityError)):
        if operation == "create":
            db.create_node(conn, project_id="p_2", parent_id=None, level=0, title="Other")
        elif operation == "update":
            db.update_node(conn, story["id"], title="Mutated")
        elif operation == "archive":
            db.archive_node(conn, story["id"])
        else:
            db.link_node_to_kanban(conn, story["id"], "task-1")

    assert conn.execute("SELECT * FROM hierarchy_nodes ORDER BY id").fetchall() == before


def test_raw_cross_project_parent_reference_is_rejected_by_sqlite(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    p1 = db.create_spec_node(conn, project_id="p_1", kind="theme", title="P1")
    p2 = db.create_spec_node(conn, project_id="p_2", kind="theme", title="P2")

    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO spec_nodes "
            "(id, project_id, kind, parent_id, level, title, status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("cross-parent", "p_1", "epic", p2["id"], 1, "Cross", "draft", 0, 0),
        )

    assert conn.execute("SELECT id FROM spec_nodes WHERE id = 'cross-parent'").fetchone() is None
    assert p1["id"] != p2["id"]


def test_raw_cross_project_decision_reference_is_rejected_by_sqlite(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    decision = db.push_decision(conn, project_id="p_2", question="Q", choices=["A", "B"])

    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO spec_nodes "
            "(id, project_id, kind, level, title, status, decision_id, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("cross-decision", "p_1", "theme", 0, "Cross", "draft", decision["id"], 0, 0),
        )

    assert conn.execute("SELECT id FROM spec_nodes WHERE id = 'cross-decision'").fetchone() is None


def test_invalid_v12_migration_leaves_schema_rows_and_version_unchanged(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    conn.execute("DROP TABLE spec_nodes")
    conn.execute(
        """CREATE TABLE spec_nodes (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
            parent_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL,
            created_at REAL NOT NULL, updated_at REAL NOT NULL
        )"""
    )
    conn.execute("PRAGMA user_version = 6")
    conn.execute(
        "INSERT INTO hierarchy_nodes "
        "(id, project_id, parent_id, level, title, created_at, updated_at) "
        "VALUES ('orphan', 'p_1', 'missing', 1, 'Orphan', 0, 0)"
    )
    conn.commit()
    before = (
        conn.execute("SELECT sql FROM sqlite_master WHERE name = 'spec_nodes'").fetchone()[0],
        conn.execute("SELECT * FROM hierarchy_nodes ORDER BY id").fetchall(),
        conn.execute("PRAGMA user_version").fetchone()[0],
    )

    with pytest.raises((ValueError, db.BoundaryError, sqlite3.IntegrityError)):
        db.init_db(conn)

    after = (
        conn.execute("SELECT sql FROM sqlite_master WHERE name = 'spec_nodes'").fetchone()[0],
        conn.execute("SELECT * FROM hierarchy_nodes ORDER BY id").fetchall(),
        conn.execute("PRAGMA user_version").fetchone()[0],
    )
    assert after == before


@pytest.mark.parametrize(
    "argv",
    [
        ["spec", "list"],
        ["spec", "update-node", "--id", "n_1"],
        ["spec", "set-criteria", "--id", "n_1", "--criteria-json", "[]"],
        ["spec", "link-decision", "--id", "n_1", "--decision-id", "d_1"],
        ["spec", "delete-node", "--id", "n_1"],
    ],
)
def test_spec_mutating_and_listing_commands_require_project_scope(argv):
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    with pytest.raises(SystemExit):
        parser.parse_args(argv)


def test_spec_cli_success_and_failure_use_stable_envelopes(tmp_path, monkeypatch, capsys):
    conn = _conn(tmp_path, monkeypatch)
    node = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root")
    conn.close()
    parser = argparse.ArgumentParser()
    cli.setup(parser)

    args = parser.parse_args(["spec", "list", "--project-id", "p_1"])
    args.func(args)
    success = json.loads(capsys.readouterr().out)
    assert success["ok"] is True
    assert isinstance(success["nodes"], list)

    args = parser.parse_args(
        ["spec", "update-node", "--project-id", "p_1", "--id", "missing", "--title", "x"]
    )
    with pytest.raises(SystemExit) as exc:
        args.func(args)
    failure = json.loads(capsys.readouterr().out)
    assert exc.value.code == 3
    assert failure == {
        "ok": False,
        "error": {"code": "not_found", "message": "resource not found"},
    }
    assert node["project_id"] == "p_1"


def test_spec_rejects_kind_level_and_parent_level_mismatch(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    root = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root")

    with pytest.raises((ValueError, db.BoundaryError), match="level|kind|parent"):
        db.create_spec_node(
            conn, project_id="p_1", kind="story", title="Too Deep", parent_id=root["id"], level=1
        )


def test_spec_cli_rejects_oversized_title_and_criteria_without_mutation(tmp_path, monkeypatch, capsys):
    conn = _conn(tmp_path, monkeypatch)
    node = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root")
    conn.close()
    parser = argparse.ArgumentParser()
    cli.setup(parser)

    oversized_title = "x" * (db.TEXT_LIMIT + 1)
    args = parser.parse_args(
        ["spec", "update-node", "--project-id", "p_1", "--id", node["id"], "--title", oversized_title]
    )
    with pytest.raises(SystemExit):
        args.func(args)
    json.loads(capsys.readouterr().out)

    oversized_criteria = json.dumps(["x" * (db.TEXT_LIMIT + 1)])
    args = parser.parse_args(
        [
            "spec", "set-criteria", "--project-id", "p_1", "--id", node["id"],
            "--criteria-json", oversized_criteria,
        ]
    )
    with pytest.raises(SystemExit):
        args.func(args)
    json.loads(capsys.readouterr().out)

    conn = db.connect()
    try:
        row = conn.execute("SELECT title, criteria_json FROM spec_nodes WHERE id = ?", (node["id"],)).fetchone()
        assert row["title"] == "Root"
        assert row["criteria_json"] is None
    finally:
        conn.close()
