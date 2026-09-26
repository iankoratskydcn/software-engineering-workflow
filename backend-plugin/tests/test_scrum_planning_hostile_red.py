"""Hostile RED contracts for the first Scrum Planning slice (v13)."""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cli  # noqa: E402
import db  # noqa: E402


STATUS_VALUES = ("backlog", "ready", "in_progress", "done", "cancelled")
ESTIMATE_VALUES = (1, 2, 3, 5, 8, 13)


def _projects(tmp_path: Path) -> None:
    conn = sqlite3.connect(tmp_path / "projects.db")
    conn.execute(
        "CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0)"
    )
    conn.executemany(
        "INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)",
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


def _spec_root(conn: sqlite3.Connection, project_id: str = "p_1") -> dict:
    return db.create_spec_node(conn, project_id=project_id, kind="theme", title="Product")


def test_v13_creates_planning_items_after_v12_with_canonical_constraints(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 13

    columns = {row["name"] for row in conn.execute("PRAGMA table_info(planning_items)")}
    assert {
        "id", "project_id", "spec_node_id", "title", "status", "estimate",
        "sprint", "created_at", "updated_at",
    } <= columns
    table_sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'planning_items'"
    ).fetchone()[0].lower()
    assert "sprint integer not null" in " ".join(table_sql.split())
    assert table_sql.rstrip().endswith("strict")

    root = _spec_root(conn)
    conn.execute(
        "INSERT INTO planning_items "
        "(id, project_id, spec_node_id, title, status, estimate, sprint, created_at, updated_at) "
        "VALUES ('pi_1', 'p_1', ?, 'Ship it', 'backlog', 5, 1, 0, 0)",
        (root["id"],),
    )
    conn.commit()

    for status in ("unknown", "resolved"):
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO planning_items "
                "(id, project_id, spec_node_id, title, status, estimate, sprint, created_at, updated_at) "
                "VALUES (?, 'p_1', ?, 'Bad status', ?, 5, 1, 0, 0)",
                (f"bad-status-{status}", root["id"], status),
            )
    for estimate in (0, 14):
        with pytest.raises((sqlite3.IntegrityError, sqlite3.OperationalError)):
            conn.execute(
                "INSERT INTO planning_items "
                "(id, project_id, spec_node_id, title, status, estimate, sprint, created_at, updated_at) "
                "VALUES (?, 'p_1', ?, 'Bad estimate', 'backlog', ?, 1, 0, 0)",
                (f"bad-estimate-{estimate}", root["id"], estimate),
            )


def test_raw_planning_item_composite_foreign_key_rejects_cross_project_spec_node(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    p1_root = _spec_root(conn, "p_1")
    p2_root = _spec_root(conn, "p_2")

    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO planning_items "
            "(id, project_id, spec_node_id, title, status, estimate, sprint, created_at, updated_at) "
            "VALUES ('cross', 'p_1', ?, 'Cross project', 'backlog', 3, 1, 0, 0)",
            (p2_root["id"],),
        )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO planning_items "
            "(id, project_id, spec_node_id, title, status, estimate, sprint, created_at, updated_at) "
            "VALUES ('orphan', 'p_1', 'missing-node', 'Orphan', 'backlog', 3, 1, 0, 0)"
        )
    assert p1_root["project_id"] != p2_root["project_id"]


def test_v13_migration_is_atomic_when_preexisting_planning_schema_is_hostile(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    conn.execute("DROP TABLE planning_items")
    conn.execute("PRAGMA user_version = 12")
    conn.execute(
        "CREATE TABLE planning_items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, "
        "spec_node_id TEXT NOT NULL, status TEXT NOT NULL)"
    )
    conn.execute("INSERT INTO planning_items VALUES ('legacy', 'p_1', 'missing', 'corrupt')")
    conn.commit()
    before = (
        conn.execute("SELECT sql FROM sqlite_master WHERE name = 'planning_items'").fetchone()[0],
        conn.execute("SELECT * FROM planning_items").fetchall(),
        conn.execute("PRAGMA user_version").fetchone()[0],
    )

    with pytest.raises((ValueError, db.BoundaryError, sqlite3.IntegrityError)):
        db.init_db(conn)

    after = (
        conn.execute("SELECT sql FROM sqlite_master WHERE name = 'planning_items'").fetchone()[0],
        conn.execute("SELECT * FROM planning_items").fetchall(),
        conn.execute("PRAGMA user_version").fetchone()[0],
    )
    assert after == before


def test_planning_item_api_is_project_scoped_and_rejects_cross_project_spec_node(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    p1_root = _spec_root(conn, "p_1")
    p2_root = _spec_root(conn, "p_2")

    item = db.create_planning_item(
        conn,
        project_id="p_1",
        spec_node_id=p1_root["id"],
        title="Scoped item",
        status="backlog",
        estimate=3,
        sprint=1,
    )
    assert item["project_id"] == "p_1"
    assert db.list_planning_items(conn, project_id="p_1") == [item]
    assert db.list_planning_items(conn, project_id="p_2") == []

    with pytest.raises((ValueError, db.BoundaryError, sqlite3.IntegrityError)):
        db.create_planning_item(
            conn,
            project_id="p_1",
            spec_node_id=p2_root["id"],
            title="Cross-project item",
            status="backlog",
            estimate=3,
            sprint=1,
        )


def test_scrum_planning_cli_and_ui_surface_are_project_scoped():
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    args = parser.parse_args(
        [
            "scrum", "plan", "add", "--project-id", "p_1",
            "--spec-node-id", "sn_1", "--title", "Ship it",
            "--status", "backlog", "--estimate", "3", "--sprint", "1",
        ]
    )
    assert args.func is not None
    assert args.project_id == "p_1"

    source = Path(__file__).resolve().parents[2].joinpath("plugin.js").read_text()
    assert "Scrum Planning" in source
    assert "planning_items" in source
    assert json.dumps(list(STATUS_VALUES))[1:-1] in source
    assert json.dumps(list(ESTIMATE_VALUES))[1:-1] in source
