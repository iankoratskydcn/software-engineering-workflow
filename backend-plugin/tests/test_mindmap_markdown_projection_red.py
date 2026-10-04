"""RED contracts for the minimal JSON-authoritative MindMap Markdown slice."""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
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


def _map_with_nodes(tmp_path: Path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    mindmap = db.create_mindmap(
        conn,
        project_id="p_1",
        name="Release plan",
        description="Launch readiness",
    )
    root = db.create_spec_node(
        conn,
        project_id="p_1",
        mindmap_id=mindmap["id"],
        kind="theme",
        title="Product",
        description="Product scope",
    )
    child = db.create_spec_node(
        conn,
        project_id="p_1",
        mindmap_id=mindmap["id"],
        kind="epic",
        title="Launch",
        parent_id=root["id"],
        note="Ship safely",
    )
    return conn, mindmap, root, child


def test_export_is_deterministic_and_contains_map_metadata_and_stable_node_links(
    tmp_path, monkeypatch
):
    conn, mindmap, root, child = _map_with_nodes(tmp_path, monkeypatch)

    first = db.export_mindmap_markdown(
        conn, project_id="p_1", map_id=mindmap["id"]
    )
    second = db.export_mindmap_markdown(
        conn, project_id="p_1", map_id=mindmap["id"]
    )

    assert first == second
    assert f"map_id: {mindmap['id']}" in first
    assert "name: Release plan" in first
    assert "description: Launch readiness" in first
    assert f"spec:node id={root['id']} parent_id=null" in first
    assert f"spec:node id={child['id']} parent_id={root['id']}" in first


def test_import_updates_metadata_and_node_content_without_changing_stable_ids(
    tmp_path, monkeypatch
):
    conn, mindmap, root, child = _map_with_nodes(tmp_path, monkeypatch)
    draft = db.export_mindmap_markdown(
        conn, project_id="p_1", map_id=mindmap["id"]
    )
    draft = (
        draft.replace("name: Release plan", "name: Release readiness")
        .replace("description: Launch readiness", "description: Updated gates")
        .replace("title: Product", "title: Product platform")
        .replace("note: Ship safely", "note: Ship safely with rollback")
    )

    result = db.import_mindmap_markdown(
        conn, project_id="p_1", map_id=mindmap["id"], markdown=draft
    )

    assert result["map_id"] == mindmap["id"]
    assert result["node_ids"] == [root["id"], child["id"]]
    updated_map = db.list_mindmaps(conn, project_id="p_1")[0]
    assert updated_map["name"] == "Release readiness"
    assert updated_map["description"] == "Updated gates"
    tree = db.get_spec_tree(conn, project_id="p_1", mindmap_id=mindmap["id"])
    assert tree["id"] == root["id"]
    assert tree["title"] == "Product platform"
    assert tree["children"][0]["id"] == child["id"]
    assert tree["children"][0]["note"] == "Ship safely with rollback"


def test_import_rejects_duplicate_stable_node_ids_without_mutating_json(
    tmp_path, monkeypatch
):
    conn, mindmap, root, child = _map_with_nodes(tmp_path, monkeypatch)
    before_map = db.list_mindmaps(conn, project_id="p_1")[0]
    before_tree = db.get_spec_tree(conn, project_id="p_1", mindmap_id=mindmap["id"])
    draft = db.export_mindmap_markdown(
        conn, project_id="p_1", map_id=mindmap["id"]
    )
    duplicate = f"\nspec:node id={child['id']} parent_id={root['id']}\ntitle: Duplicate\n"

    with pytest.raises((ValueError, db.BoundaryError), match="duplicate|id"):
        db.import_mindmap_markdown(
            conn,
            project_id="p_1",
            map_id=mindmap["id"],
            markdown=draft + duplicate,
        )

    assert db.list_mindmaps(conn, project_id="p_1")[0] == before_map
    assert db.get_spec_tree(conn, project_id="p_1", mindmap_id=mindmap["id"]) == before_tree


def test_import_rejects_missing_parent_reference_without_mutating_json(
    tmp_path, monkeypatch
):
    conn, mindmap, root, child = _map_with_nodes(tmp_path, monkeypatch)
    before_map = db.list_mindmaps(conn, project_id="p_1")[0]
    before_tree = db.get_spec_tree(conn, project_id="p_1", mindmap_id=mindmap["id"])
    draft = db.export_mindmap_markdown(
        conn, project_id="p_1", map_id=mindmap["id"]
    ).replace(f"parent_id={root['id']}", "parent_id=missing-parent")

    with pytest.raises((ValueError, db.BoundaryError), match="missing|parent|reference"):
        db.import_mindmap_markdown(
            conn,
            project_id="p_1",
            map_id=mindmap["id"],
            markdown=draft,
        )

    assert db.list_mindmaps(conn, project_id="p_1")[0] == before_map
    assert db.get_spec_tree(conn, project_id="p_1", mindmap_id=mindmap["id"]) == before_tree


def test_import_does_not_delete_nodes_missing_from_markdown(tmp_path, monkeypatch):
    conn, mindmap, root, child = _map_with_nodes(tmp_path, monkeypatch)
    draft = db.export_mindmap_markdown(
        conn, project_id="p_1", map_id=mindmap["id"]
    )
    child_start = draft.index(f"spec:node id={child['id']}")
    truncated = draft[:child_start] + "\n<!-- child omitted intentionally: omission is not deletion -->\n"

    db.import_mindmap_markdown(
        conn, project_id="p_1", map_id=mindmap["id"], markdown=truncated
    )

    tree = db.get_spec_tree(conn, project_id="p_1", mindmap_id=mindmap["id"])
    assert [node["id"] for node in tree["children"]] == [child["id"]]
