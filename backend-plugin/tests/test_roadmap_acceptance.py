"""Hostile RED slice for the stage-2 roadmap contract.

These tests target required behavior that is absent or defective at canonical
HEAD. They intentionally add no production implementation.
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import cli  # noqa: E402
import db  # noqa: E402


ROADMAP_TABLES = {"roadmap_lanes", "roadmap_items"}


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


def _lane(conn, project_id="p_1"):
    return db.create_roadmap_lane(conn, project_id=project_id, title="Now")


def test_roadmap_schema_is_created_and_project_scoped(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    try:
        assert ROADMAP_TABLES <= {
            row["name"]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        lane = _lane(conn)
        assert lane["project_id"] == "p_1"
        item = db.create_roadmap_item(
            conn, project_id="p_1", lane_id=lane["id"], title="Ship roadmap"
        )
        assert item["project_id"] == "p_1"
        assert db.list_roadmap_items(conn, project_id="p_2") == []
    finally:
        conn.close()


def test_roadmap_rejects_cross_project_lane_and_update_without_mutation(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    try:
        own_lane = _lane(conn, "p_1")
        other_lane = _lane(conn, "p_2")
        with pytest.raises((ValueError, KeyError, sqlite3.IntegrityError)):
            db.create_roadmap_item(
                conn, project_id="p_1", lane_id=other_lane["id"], title="Leak"
            )
        item = db.create_roadmap_item(
            conn, project_id="p_1", lane_id=own_lane["id"], title="Keep"
        )
        before = dict(db.get_roadmap_item(conn, project_id="p_1", item_id=item["id"]))
        with pytest.raises((ValueError, KeyError, sqlite3.IntegrityError)):
            db.update_roadmap_item(
                conn,
                project_id="p_2",
                item_id=item["id"],
                title="Cross-project overwrite",
                expected_updated_at=before["updated_at"],
            )
        after = dict(db.get_roadmap_item(conn, project_id="p_1", item_id=item["id"]))
        assert after == before
    finally:
        conn.close()


def test_roadmap_rejects_oversized_links_before_insert_and_preserves_rows(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    try:
        lane = _lane(conn)
        before = conn.execute("SELECT COUNT(*) FROM roadmap_items").fetchone()[0]
        oversized_links = ["link-" + str(i) for i in range(db.LIST_LIMIT + 1)]
        with pytest.raises((TypeError, ValueError)):
            db.create_roadmap_item(
                conn,
                project_id="p_1",
                lane_id=lane["id"],
                title="Reject links",
                links=oversized_links,
            )
        assert conn.execute("SELECT COUNT(*) FROM roadmap_items").fetchone()[0] == before

        oversized_json_link = ["x" * db.LIST_VALUE_LIMIT]
        with pytest.raises((TypeError, ValueError)):
            db.create_roadmap_item(
                conn,
                project_id="p_1",
                lane_id=lane["id"],
                title="Reject value",
                links=oversized_json_link,
            )
        assert conn.execute("SELECT COUNT(*) FROM roadmap_items").fetchone()[0] == before
    finally:
        conn.close()


def test_roadmap_rejects_stale_update_without_mutation(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    try:
        lane = _lane(conn)
        item = db.create_roadmap_item(
            conn, project_id="p_1", lane_id=lane["id"], title="Original"
        )
        before = dict(db.get_roadmap_item(conn, project_id="p_1", item_id=item["id"]))
        with pytest.raises((ValueError, RuntimeError)):
            db.update_roadmap_item(
                conn,
                project_id="p_1",
                item_id=item["id"],
                title="Stale overwrite",
                expected_updated_at=before["updated_at"] - 1,
            )
        after = dict(db.get_roadmap_item(conn, project_id="p_1", item_id=item["id"]))
        assert after == before
    finally:
        conn.close()


def test_roadmap_cli_exposes_project_scoped_commands_and_single_error_envelope(monkeypatch):
    parser = __import__("argparse").ArgumentParser()
    cli.setup(parser)
    parsed = parser.parse_args(["roadmap", "list", "--project-id", "p_1"])
    assert parsed.project_id == "p_1"

    printed = []
    monkeypatch.setattr(cli, "_print", printed.append)
    with pytest.raises(SystemExit) as exc:
        cli._cmd_roadmap_list(SimpleNamespace(project_id="p_1"))
    assert exc.value.code != 0
    assert len(printed) == 1
    assert printed[0]["ok"] is False
    assert set(printed[0]["error"]) == {"code", "message"}


def test_roadmap_payloads_are_canonical_json_arrays(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    try:
        lane = _lane(conn)
        item = db.create_roadmap_item(
            conn,
            project_id="p_1",
            lane_id=lane["id"],
            title="Canonical payload",
            depends_on=["item_a"],
            links=["spec:abc"],
        )
        row = conn.execute(
            "SELECT depends_on_json, links_json FROM roadmap_items WHERE id = ?",
            (item["id"],),
        ).fetchone()
        assert json.loads(row["depends_on_json"]) == ["item_a"]
        assert json.loads(row["links_json"]) == ["spec:abc"]
    finally:
        conn.close()
