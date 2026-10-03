"""Spec nodes: sibling ordering and move_spec_node (schema v17)."""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    projects = sqlite3.connect(tmp_path / "projects.db")
    projects.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0)")
    projects.executemany("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", [("p_1", "demo", "Demo"), ("p_2", "other", "Other")])
    projects.commit()
    projects.close()
    connection = db.connect()
    yield connection
    connection.close()


def make_siblings(conn, project="p_1", count=3, parent_id=None, kind="epic"):
    if parent_id is None:
        root = db.create_spec_node(conn, project_id=project, kind="theme", title="Root")
        parent_id = root["id"]
    return [
        db.create_spec_node(conn, project_id=project, kind=kind, title=f"Sibling {i}", parent_id=parent_id)
        for i in range(count)
    ]


def ordered_titles(conn, project="p_1", parent_id=None):
    rows = conn.execute(
        "SELECT title FROM spec_nodes WHERE project_id = ? AND parent_id IS ? ORDER BY sort_index, created_at, id",
        (project, parent_id),
    ).fetchall()
    return [row["title"] for row in rows]


def test_new_siblings_get_increasing_sort_index_in_creation_order(conn):
    siblings = make_siblings(conn)
    parent_id = siblings[0]["parent_id"]
    assert [s["sort_index"] for s in siblings] == [0, 1, 2]
    assert ordered_titles(conn, parent_id=parent_id) == ["Sibling 0", "Sibling 1", "Sibling 2"]


def test_move_up_swaps_with_the_previous_sibling(conn):
    siblings = make_siblings(conn)
    parent_id = siblings[0]["parent_id"]
    db.move_spec_node(conn, siblings[1]["id"], project_id="p_1", direction="up")
    assert ordered_titles(conn, parent_id=parent_id) == ["Sibling 1", "Sibling 0", "Sibling 2"]


def test_move_down_swaps_with_the_next_sibling(conn):
    siblings = make_siblings(conn)
    parent_id = siblings[0]["parent_id"]
    db.move_spec_node(conn, siblings[1]["id"], project_id="p_1", direction="down")
    assert ordered_titles(conn, parent_id=parent_id) == ["Sibling 0", "Sibling 2", "Sibling 1"]


def test_moving_the_first_sibling_up_is_a_no_op(conn):
    siblings = make_siblings(conn)
    parent_id = siblings[0]["parent_id"]
    db.move_spec_node(conn, siblings[0]["id"], project_id="p_1", direction="up")
    assert ordered_titles(conn, parent_id=parent_id) == ["Sibling 0", "Sibling 1", "Sibling 2"]


def test_moving_the_last_sibling_down_is_a_no_op(conn):
    siblings = make_siblings(conn)
    parent_id = siblings[0]["parent_id"]
    db.move_spec_node(conn, siblings[-1]["id"], project_id="p_1", direction="down")
    assert ordered_titles(conn, parent_id=parent_id) == ["Sibling 0", "Sibling 1", "Sibling 2"]


def test_move_does_not_touch_siblings_under_a_different_parent(conn):
    root = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root")
    group_a = db.create_spec_node(conn, project_id="p_1", kind="epic", title="Group A", parent_id=root["id"])
    group_b = db.create_spec_node(conn, project_id="p_1", kind="epic", title="Group B", parent_id=root["id"])
    a1 = db.create_spec_node(conn, project_id="p_1", kind="feature", title="A1", parent_id=group_a["id"])
    a2 = db.create_spec_node(conn, project_id="p_1", kind="feature", title="A2", parent_id=group_a["id"])
    db.create_spec_node(conn, project_id="p_1", kind="feature", title="B1", parent_id=group_b["id"])

    db.move_spec_node(conn, a2["id"], project_id="p_1", direction="up")

    assert ordered_titles(conn, parent_id=group_a["id"]) == ["A2", "A1"]
    assert ordered_titles(conn, parent_id=group_b["id"]) == ["B1"]


def test_invalid_direction_is_rejected(conn):
    siblings = make_siblings(conn)
    with pytest.raises(db.BoundaryError) as error:
        db.move_spec_node(conn, siblings[0]["id"], project_id="p_1", direction="sideways")
    assert error.value.code == "invalid_input"


def test_moving_a_node_from_the_wrong_project_is_rejected(conn):
    siblings = make_siblings(conn, project="p_1")
    with pytest.raises(db.BoundaryError) as error:
        db.move_spec_node(conn, siblings[0]["id"], project_id="p_2", direction="up")
    assert error.value.code == "not_found"


def test_moving_an_unknown_node_is_rejected(conn):
    with pytest.raises(db.BoundaryError) as error:
        db.move_spec_node(conn, "sn_does_not_exist", project_id="p_1", direction="up")
    assert error.value.code == "not_found"


def test_v16_database_upgrades_existing_nodes_with_a_stable_sort_order(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    projects = sqlite3.connect(tmp_path / "projects.db")
    projects.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0)")
    projects.execute("INSERT INTO projects (id, slug, name) VALUES ('p_1', 'demo', 'Demo')")
    projects.commit()
    projects.close()

    conn = db.connect()
    root = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root")
    first = db.create_spec_node(conn, project_id="p_1", kind="epic", title="First", parent_id=root["id"])
    second = db.create_spec_node(conn, project_id="p_1", kind="epic", title="Second", parent_id=root["id"])

    # Simulate a pre-v17 database: drop the column and roll the version back.
    conn.execute("CREATE TABLE spec_nodes_old AS SELECT * FROM spec_nodes")
    conn.execute("DROP TABLE spec_nodes")
    conn.execute("ALTER TABLE spec_nodes_old RENAME TO spec_nodes")
    columns = [row[1] for row in conn.execute("PRAGMA table_info(spec_nodes)") if row[1] != "sort_index"]
    conn.execute(f"CREATE TABLE spec_nodes_new ({', '.join(columns)})")
    conn.execute(f"INSERT INTO spec_nodes_new ({', '.join(columns)}) SELECT {', '.join(columns)} FROM spec_nodes")
    conn.execute("DROP TABLE spec_nodes")
    conn.execute("ALTER TABLE spec_nodes_new RENAME TO spec_nodes")
    conn.execute("PRAGMA user_version = 16")
    conn.commit()

    db.init_db(conn)

    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.LATEST_SCHEMA_VERSION
    assert ordered_titles(conn, parent_id=root["id"]) == ["First", "Second"]
    conn.close()
