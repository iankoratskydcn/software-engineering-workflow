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


def test_v7_migration_is_idempotent_and_has_root_index(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    db.init_db(conn)
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(hierarchy_nodes)")}
    assert {"id", "project_id", "parent_id", "level", "title", "sort_order", "kanban_task_id", "created_at", "updated_at", "archived"} <= columns
    indexes = {row["name"] for row in conn.execute("PRAGMA index_list(hierarchy_nodes)")}
    assert "idx_hierarchy_one_root_per_project" in indexes


def test_create_nodes_enforces_project_parent_levels_and_single_root(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    root = db.create_node(conn, project_id="p_1", parent_id=None, level=0, title="Demo Project")
    assert root["level"] == 0 and root["parent_id"] is None
    try:
        db.create_node(conn, project_id="p_1", parent_id=None, level=0, title="Duplicate")
        assert False, "expected duplicate root rejection"
    except ValueError as exc:
        assert "root" in str(exc).lower()
    theme = db.create_node(conn, project_id="p_1", parent_id=root["id"], level=1, title="Theme")
    try:
        db.create_node(conn, project_id="p_1", parent_id=root["id"], level=2, title="Bad")
        assert False, "expected parent level rejection"
    except ValueError as exc:
        assert "parent" in str(exc).lower()
    assert db.list_nodes(conn, project_id="p_1", parent_id=root["id"])[0]["id"] == theme["id"]


def test_get_subtree_rolls_up_story_kanban_status(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    kanban = sqlite3.connect(str(tmp_path / "kanban.db"))
    kanban.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL)")
    kanban.executemany("INSERT INTO tasks VALUES (?, ?)", [("t_done", "done"), ("t_open", "running")])
    kanban.commit()
    kanban.close()
    root = db.create_node(conn, project_id="p_1", parent_id=None, level=0, title="Demo")
    theme = db.create_node(conn, project_id="p_1", parent_id=root["id"], level=1, title="Theme")
    epic = db.create_node(conn, project_id="p_1", parent_id=theme["id"], level=2, title="Epic")
    feature = db.create_node(conn, project_id="p_1", parent_id=epic["id"], level=3, title="Feature")
    db.create_node(conn, project_id="p_1", parent_id=feature["id"], level=4, title="Done", kanban_task_id="t_done")
    db.create_node(conn, project_id="p_1", parent_id=feature["id"], level=4, title="Open", kanban_task_id="t_open")
    tree = db.get_subtree(conn, "p_1")
    assert tree["done_count"] == 1 and tree["total_count"] == 2
    assert tree["children"][0]["done_count"] == 1
    assert len(tree["children"][0]["children"][0]["children"][0]["children"]) == 2


def test_update_archive_and_link_contracts(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    root = db.create_node(conn, project_id="p_1", parent_id=None, level=0, title="Demo")
    story = db.create_node(conn, project_id="p_1", parent_id=root["id"], level=1, title="Theme")
    updated = db.update_node(conn, story["id"], title="Renamed", sort_order=3)
    assert updated["title"] == "Renamed" and updated["sort_order"] == 3
    try:
        db.update_node(conn, story["id"], level=2)
        assert False, "expected immutable field rejection"
    except ValueError:
        pass
    try:
        db.link_node_to_kanban(conn, story["id"], "t_1")
        assert False, "expected non-story/task rejection"
    except ValueError:
        pass
    task = db.create_node(conn, project_id="p_1", parent_id=story["id"], level=2, title="Epic")
    db.archive_node(conn, task["id"])
    assert conn.execute("SELECT archived FROM hierarchy_nodes WHERE id = ?", (task["id"],)).fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM hierarchy_nodes WHERE id = ?", (task["id"],)).fetchone()[0] == 1


def test_link_rejects_duplicate_kanban_task_id(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    root = db.create_node(conn, project_id="p_1", parent_id=None, level=0, title="Demo")
    story = db.create_node(conn, project_id="p_1", parent_id=root["id"], level=1, title="Theme")
    feature = db.create_node(conn, project_id="p_1", parent_id=story["id"], level=2, title="Epic")
    first = db.create_node(conn, project_id="p_1", parent_id=feature["id"], level=3, title="Feature")
    second = db.create_node(conn, project_id="p_1", parent_id=first["id"], level=4, title="Story")
    third = db.create_node(conn, project_id="p_1", parent_id=first["id"], level=4, title="Story 2")
    db.link_node_to_kanban(conn, second["id"], "t_1")
    try:
        db.link_node_to_kanban(conn, third["id"], "t_1")
        assert False, "expected duplicate link rejection"
    except ValueError as exc:
        assert "already" in str(exc).lower()
