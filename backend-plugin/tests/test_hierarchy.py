"""Hierarchy persistence contracts for mindmap wave 1."""
from __future__ import annotations

import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402


def _projects(tmp_path: Path) -> None:
    conn = sqlite3.connect(str(tmp_path / "projects.db"))
    conn.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT)")
    conn.execute("INSERT INTO projects VALUES ('p_1', 'demo', 'Demo Project')")
    conn.commit()
    conn.close()


def _conn(tmp_path: Path, monkeypatch) -> sqlite3.Connection:
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    _projects(tmp_path)
    conn = sqlite3.connect(str(tmp_path / "queue.db"))
    conn.row_factory = sqlite3.Row
    db.init_db(conn)
    return conn


def _seed_legacy_hierarchy(conn: sqlite3.Connection, *, include_tasks: bool = False) -> dict[str, str]:
    """Seed pre-v12 hierarchy rows without routing writes through v12 authority."""
    rows = [
        ("n_root", "p_1", None, 0, "Demo", 0, None),
        ("n_theme", "p_1", "n_root", 1, "Theme", 0, None),
        ("n_epic", "p_1", "n_theme", 2, "Epic", 0, None),
        ("n_feature", "p_1", "n_epic", 3, "Feature", 0, None),
    ]
    if include_tasks:
        rows.extend([
            ("n_done", "p_1", "n_feature", 4, "Done", 0, "t_done"),
            ("n_open", "p_1", "n_feature", 4, "Open", 1, "t_open"),
        ])
    conn.executemany(
        "INSERT INTO hierarchy_nodes "
        "(id, project_id, parent_id, level, title, sort_order, kanban_task_id, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)",
        rows,
    )
    conn.commit()
    conn.execute("PRAGMA user_version = 6")
    return {"root": "n_root", "theme": "n_theme", "feature": "n_feature"}


def test_v7_migration_is_idempotent_and_has_root_index(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    db.init_db(conn)
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(hierarchy_nodes)")}
    assert {"id", "project_id", "parent_id", "level", "title", "sort_order", "kanban_task_id", "created_at", "updated_at", "archived"} <= columns
    indexes = {row["name"] for row in conn.execute("PRAGMA index_list(hierarchy_nodes)")}
    assert "idx_hierarchy_one_root_per_project" in indexes


def test_legacy_rows_preserve_project_parent_levels_and_single_root(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    ids = _seed_legacy_hierarchy(conn)
    root = conn.execute("SELECT * FROM hierarchy_nodes WHERE id = ?", (ids["root"],)).fetchone()
    assert root["level"] == 0 and root["parent_id"] is None
    assert db.list_nodes(conn, project_id="p_1", parent_id=ids["root"])[0]["id"] == ids["theme"]
    assert conn.execute(
        "SELECT COUNT(*) FROM hierarchy_nodes WHERE project_id = ? AND level = 0", ("p_1",)
    ).fetchone()[0] == 1


def test_get_subtree_rolls_up_story_kanban_status(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    kanban = sqlite3.connect(str(tmp_path / "kanban.db"))
    kanban.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL)")
    kanban.executemany("INSERT INTO tasks VALUES (?, ?)", [("t_done", "done"), ("t_open", "running")])
    kanban.commit()
    kanban.close()
    _seed_legacy_hierarchy(conn, include_tasks=True)
    tree = db.get_subtree(conn, "p_1")
    assert tree["done_count"] == 1 and tree["total_count"] == 2
    assert tree["children"][0]["done_count"] == 1
    assert len(tree["children"][0]["children"][0]["children"][0]["children"]) == 2


def test_legacy_rows_preserve_mutable_fields_and_links(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    ids = _seed_legacy_hierarchy(conn)
    row = conn.execute("SELECT * FROM hierarchy_nodes WHERE id = ?", (ids["theme"],)).fetchone()
    assert row["level"] == 1 and row["parent_id"] == ids["root"]
    assert conn.execute("SELECT archived FROM hierarchy_nodes WHERE id = ?", (ids["theme"],)).fetchone()[0] == 0


def test_legacy_rows_preserve_kanban_task_links(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    _seed_legacy_hierarchy(conn, include_tasks=True)
    assert conn.execute(
        "SELECT COUNT(*) FROM hierarchy_nodes WHERE kanban_task_id IS NOT NULL"
    ).fetchone()[0] == 2
