"""Hostile RED contracts for the first MindMap backend/CLI slice."""
from __future__ import annotations

import argparse
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
