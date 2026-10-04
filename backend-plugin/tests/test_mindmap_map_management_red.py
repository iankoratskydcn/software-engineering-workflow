"""Adversarial RED contracts for named, project-scoped MindMap management."""
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


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    return parser


def test_cli_exposes_project_scoped_mindmap_crud_commands():
    parser = _parser()

    create = parser.parse_args(
        [
            "mindmap",
            "create",
            "--project-id",
            "p_1",
            "--name",
            "Release plan",
            "--description",
            "Launch readiness map",
        ]
    )
    listing = parser.parse_args(["mindmap", "list", "--project-id", "p_1"])
    update = parser.parse_args(
        [
            "mindmap",
            "update",
            "--project-id",
            "p_1",
            "--map-id",
            "map_1",
            "--name",
            "Renamed",
            "--description",
            "Updated description",
        ]
    )
    delete = parser.parse_args(
        [
            "mindmap",
            "delete",
            "--project-id",
            "p_1",
            "--map-id",
            "map_1",
        ]
    )

    assert create.func is not None
    assert listing.func is not None
    assert update.func is not None
    assert delete.func is not None


def test_mindmaps_are_named_project_scoped_and_support_description_updates(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)

    first = db.create_mindmap(
        conn, project_id="p_1", name="Release plan", description="Launch readiness"
    )
    second = db.create_mindmap(
        conn, project_id="p_1", name="Incident response", description="On-call map"
    )
    other_project = db.create_mindmap(
        conn, project_id="p_2", name="Other project", description="Other description"
    )

    assert [row["name"] for row in db.list_mindmaps(conn, project_id="p_1")] == [
        "Release plan",
        "Incident response",
    ]
    assert {row["id"] for row in db.list_mindmaps(conn, project_id="p_1")} == {
        first["id"],
        second["id"],
    }
    assert other_project["id"] not in {
        row["id"] for row in db.list_mindmaps(conn, project_id="p_1")
    }

    updated = db.update_mindmap(
        conn,
        project_id="p_1",
        map_id=first["id"],
        name="Release readiness",
        description="Updated launch gates",
    )
    assert updated["id"] == first["id"]
    assert updated["name"] == "Release readiness"
    assert updated["description"] == "Updated launch gates"

    with pytest.raises((db.BoundaryError, ValueError)):
        db.update_mindmap(
            conn,
            project_id="p_2",
            map_id=first["id"],
            name="Cross-project mutation",
        )


def test_delete_returns_confirmation_summary_and_rejects_owned_children(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    mindmap = db.create_mindmap(
        conn, project_id="p_1", name="Product map", description="Product scope"
    )
    root = db.create_spec_node(
        conn,
        project_id="p_1",
        kind="theme",
        title="Product root",
        mindmap_id=mindmap["id"],
    )
    db.create_spec_node(
        conn,
        project_id="p_1",
        kind="epic",
        title="Owned child",
        parent_id=root["id"],
        mindmap_id=mindmap["id"],
    )

    summary = db.get_mindmap_delete_summary(
        conn, project_id="p_1", map_id=mindmap["id"]
    )
    assert summary == {
        "map_id": mindmap["id"],
        "project_id": "p_1",
        "name": "Product map",
        "owned_node_count": 2,
        "can_delete": False,
        "reason": "has_children",
    }

    with pytest.raises((db.BoundaryError, ValueError)):
        db.delete_mindmap(conn, project_id="p_1", map_id=mindmap["id"])

    assert db.get_mindmap_delete_summary(
        conn, project_id="p_1", map_id=mindmap["id"]
    )["owned_node_count"] == 2


def test_delete_is_project_owned_and_empty_map_can_be_deleted(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    mindmap = db.create_mindmap(
        conn, project_id="p_1", name="Empty map", description="Nothing yet"
    )

    result = db.delete_mindmap(conn, project_id="p_1", map_id=mindmap["id"])
    assert result == {"id": mindmap["id"], "project_id": "p_1", "deleted": True}
    assert db.list_mindmaps(conn, project_id="p_1") == []

    with pytest.raises((db.BoundaryError, ValueError)):
        db.delete_mindmap(conn, project_id="p_2", map_id=mindmap["id"])


def test_cli_delete_emits_machine_readable_confirmation_metadata(tmp_path, monkeypatch, capsys):
    conn = _conn(tmp_path, monkeypatch)
    mindmap = db.create_mindmap(
        conn, project_id="p_1", name="Confirm me", description="Delete preview"
    )
    conn.close()

    args = _parser().parse_args(
        [
            "mindmap",
            "delete",
            "--project-id",
            "p_1",
            "--map-id",
            mindmap["id"],
            "--confirm",
        ]
    )
    args.func(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["deleted"] is True
    assert payload["map"]["id"] == mindmap["id"]
    assert payload["map"]["owned_node_count"] == 0
