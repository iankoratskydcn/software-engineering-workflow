"""Spec nodes: reparent_spec_node (cross-parent moves, schema v17)."""
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


def ordered_titles(conn, project="p_1", parent_id=None):
    rows = conn.execute(
        "SELECT title FROM spec_nodes WHERE project_id = ? AND parent_id IS ? ORDER BY sort_index, created_at, id",
        (project, parent_id),
    ).fetchall()
    return [row["title"] for row in rows]


def ordered_sort_indices(conn, project="p_1", parent_id=None):
    rows = conn.execute(
        "SELECT title, sort_index FROM spec_nodes WHERE project_id = ? AND parent_id IS ? ORDER BY sort_index, created_at, id",
        (project, parent_id),
    ).fetchall()
    return {row["title"]: row["sort_index"] for row in rows}


def test_reparenting_moves_node_and_appends_after_existing_children(conn):
    root = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root")
    epic_a = db.create_spec_node(conn, project_id="p_1", kind="epic", title="Epic A", parent_id=root["id"])
    epic_b = db.create_spec_node(conn, project_id="p_1", kind="epic", title="Epic B", parent_id=root["id"])
    feature_1 = db.create_spec_node(conn, project_id="p_1", kind="feature", title="F1", parent_id=epic_b["id"])
    feature_under_a = db.create_spec_node(conn, project_id="p_1", kind="feature", title="FA", parent_id=epic_a["id"])

    moved = db.reparent_spec_node(conn, feature_under_a["id"], project_id="p_1", new_parent_id=epic_b["id"])

    assert moved["parent_id"] == epic_b["id"]
    assert ordered_titles(conn, parent_id=epic_b["id"]) == ["F1", "FA"]
    assert moved["sort_index"] == feature_1["sort_index"] + 1


def test_old_parents_remaining_children_keep_their_sort_index(conn):
    root = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root")
    epic_a = db.create_spec_node(conn, project_id="p_1", kind="epic", title="Epic A", parent_id=root["id"])
    epic_b = db.create_spec_node(conn, project_id="p_1", kind="epic", title="Epic B", parent_id=root["id"])
    a0 = db.create_spec_node(conn, project_id="p_1", kind="feature", title="A0", parent_id=epic_a["id"])
    a1 = db.create_spec_node(conn, project_id="p_1", kind="feature", title="A1", parent_id=epic_a["id"])
    a2 = db.create_spec_node(conn, project_id="p_1", kind="feature", title="A2", parent_id=epic_a["id"])
    before = ordered_sort_indices(conn, parent_id=epic_a["id"])
    assert before == {"A0": 0, "A1": 1, "A2": 2}

    db.reparent_spec_node(conn, a1["id"], project_id="p_1", new_parent_id=epic_b["id"])

    after = ordered_sort_indices(conn, parent_id=epic_a["id"])
    assert after == {"A0": 0, "A2": 2}, "remaining siblings must keep their original sort_index (no compaction)"


def test_reparenting_to_wrong_level_parent_is_rejected(conn):
    root = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root")
    epic = db.create_spec_node(conn, project_id="p_1", kind="epic", title="Epic", parent_id=root["id"])
    other_epic = db.create_spec_node(conn, project_id="p_1", kind="epic", title="Other epic", parent_id=root["id"])
    feature = db.create_spec_node(conn, project_id="p_1", kind="feature", title="Feature", parent_id=epic["id"])

    with pytest.raises(db.BoundaryError) as error:
        # a feature (level 2) cannot be reparented directly under the root theme (level 0)
        db.reparent_spec_node(conn, feature["id"], project_id="p_1", new_parent_id=root["id"])
    assert error.value.code == "invalid_input"


def test_reparenting_to_a_different_project_is_rejected(conn):
    root_1 = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root 1")
    epic_1 = db.create_spec_node(conn, project_id="p_1", kind="epic", title="Epic 1", parent_id=root_1["id"])
    root_2 = db.create_spec_node(conn, project_id="p_2", kind="theme", title="Root 2")
    epic_2 = db.create_spec_node(conn, project_id="p_2", kind="epic", title="Epic 2", parent_id=root_2["id"])

    with pytest.raises(db.BoundaryError) as error:
        db.reparent_spec_node(conn, epic_1["id"], project_id="p_1", new_parent_id=root_2["id"])
    assert error.value.code in ("not_found", "invalid_input")

    with pytest.raises(db.BoundaryError):
        db.reparent_spec_node(conn, epic_2["id"], project_id="p_2", new_parent_id=root_1["id"])


def test_reparenting_a_node_under_its_own_descendant_is_rejected_as_a_cycle(conn):
    root = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root")
    epic = db.create_spec_node(conn, project_id="p_1", kind="epic", title="Epic", parent_id=root["id"])
    feature = db.create_spec_node(conn, project_id="p_1", kind="feature", title="Feature", parent_id=epic["id"])
    story = db.create_spec_node(conn, project_id="p_1", kind="story", title="Story", parent_id=feature["id"])

    with pytest.raises(db.BoundaryError) as error:
        db.reparent_spec_node(conn, epic["id"], project_id="p_1", new_parent_id=story["id"])
    assert error.value.code == "invalid_input"


def test_reparenting_a_node_to_itself_is_rejected(conn):
    root = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root")
    epic = db.create_spec_node(conn, project_id="p_1", kind="epic", title="Epic", parent_id=root["id"])

    with pytest.raises(db.BoundaryError) as error:
        db.reparent_spec_node(conn, epic["id"], project_id="p_1", new_parent_id=epic["id"])
    assert error.value.code == "invalid_input"


def test_making_a_second_root_is_rejected(conn):
    root = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root")
    db.create_spec_node(conn, project_id="p_1", kind="epic", title="Epic", parent_id=root["id"])
    # create_spec_node itself enforces one root, so build a second (non-root) theme via raw SQL
    # to reach a state reparent_spec_node must still reject.
    conn.execute(
        "INSERT INTO spec_nodes (id, project_id, kind, parent_id, level, title, status, note, description, rationale, criteria_json, metadata_json, decision_id, sort_index, created_at, updated_at) "
        "VALUES ('sn_fake_theme', 'p_1', 'theme', ?, 0, 'Fake root theme', 'draft', NULL, NULL, NULL, NULL, '{}', NULL, 0, 0, 0)",
        (root["id"],),
    )
    conn.commit()

    with pytest.raises(db.BoundaryError) as error:
        db.reparent_spec_node(conn, "sn_fake_theme", project_id="p_1", new_parent_id=None)
    assert error.value.code == "conflict"


def test_making_a_theme_root_is_allowed_when_project_has_no_root(conn):
    root = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root")
    conn.execute(
        "INSERT INTO spec_nodes (id, project_id, kind, parent_id, level, title, status, note, description, rationale, criteria_json, metadata_json, decision_id, sort_index, created_at, updated_at) "
        "VALUES ('sn_fake_theme', 'p_1', 'theme', ?, 0, 'Fake root theme', 'draft', NULL, NULL, NULL, NULL, '{}', NULL, 0, 0, 0)",
        (root["id"],),
    )
    conn.commit()
    # detach the fake theme from the (soon-to-be-deleted) root, then delete root to reach a
    # project with zero roots — disabling FK enforcement only for this backdoor test setup lets
    # the DELETE go through even though fake_theme still (momentarily) references root's id;
    # the subsequent reparent call writes a fresh, valid parent_id (NULL) for it.
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("DELETE FROM spec_nodes WHERE id = ?", (root["id"],))
    conn.execute("PRAGMA foreign_keys = ON")
    conn.commit()

    moved = db.reparent_spec_node(conn, "sn_fake_theme", project_id="p_1", new_parent_id=None)

    assert moved["parent_id"] is None
    assert moved["level"] == 0


def test_a_corrupted_preexisting_cycle_not_involving_the_node_is_bounded_not_infinite(conn):
    # reparent_spec_node's own validation can never CREATE a cycle (that's what this whole
    # file tests), but it must still not hang forever if the DB already contains a cycle it
    # didn't cause — e.g. a hand-edited row or a bug elsewhere. Force one directly via raw SQL
    # (bypassing reparent_spec_node, which would itself reject it) and confirm the ancestor
    # walk raises instead of looping forever when new_parent_id sits inside that foreign cycle.
    root = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Root")
    target = db.create_spec_node(conn, project_id="p_1", kind="epic", title="Target", parent_id=root["id"])
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute(
        "INSERT INTO spec_nodes (id, project_id, kind, parent_id, level, title, status, note, description, rationale, criteria_json, metadata_json, decision_id, sort_index, created_at, updated_at) "
        "VALUES ('sn_cycle_a', 'p_1', 'epic', 'sn_cycle_b', 1, 'Cycle A', 'draft', NULL, NULL, NULL, NULL, '{}', NULL, 0, 0, 0)"
    )
    conn.execute(
        "INSERT INTO spec_nodes (id, project_id, kind, parent_id, level, title, status, note, description, rationale, criteria_json, metadata_json, decision_id, sort_index, created_at, updated_at) "
        "VALUES ('sn_cycle_b', 'p_1', 'epic', 'sn_cycle_a', 1, 'Cycle B', 'draft', NULL, NULL, NULL, NULL, '{}', NULL, 0, 0, 0)"
    )
    conn.execute("PRAGMA foreign_keys = ON")
    conn.commit()

    with pytest.raises(db.BoundaryError) as error:
        db.reparent_spec_node(conn, target["id"], project_id="p_1", new_parent_id="sn_cycle_a")
    # The seen-set check already catches any repeating chain (this 2-node foreign cycle
    # included) well before the 1000-iteration cap, since it flags ANY revisited id, not just
    # node_id — so this terminates fast with invalid_input. The cap exists as a second line of
    # defense for a chain that grows without ever repeating (not reachable with only 2 extra
    # rows here); this test's job is just to prove the walk terminates at all instead of
    # hanging, which it does either way.
    assert error.value.code == "invalid_input"
