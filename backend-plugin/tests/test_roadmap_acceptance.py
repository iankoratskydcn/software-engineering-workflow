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


def _snapshot_db(conn):
    schema = tuple(
        tuple(row)
        for row in conn.execute(
            "SELECT type, name, sql FROM sqlite_master "
            "WHERE sql IS NOT NULL ORDER BY type, name"
        )
    )
    return (
        schema,
        "\n".join(conn.iterdump()),
        conn.execute("PRAGMA user_version").fetchone()[0],
    )


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
        dependency = db.create_roadmap_item(
            conn,
            project_id="p_1",
            lane_id=lane["id"],
            title="Dependency target",
        )
        item = db.create_roadmap_item(
            conn,
            project_id="p_1",
            lane_id=lane["id"],
            title="Canonical payload",
            depends_on=[dependency["id"]],
            links=["spec:abc"],
        )
        row = conn.execute(
            "SELECT depends_on_json, links_json FROM roadmap_items WHERE id = ?",
            (item["id"],),
        ).fetchone()
        assert json.loads(row["depends_on_json"]) == [dependency["id"]]
        assert json.loads(row["links_json"]) == ["spec:abc"]
    finally:
        conn.close()


def test_v11_migration_failure_rolls_back_every_schema_and_version_change(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    try:
        conn.execute("DROP TABLE roadmap_items")
        conn.execute("DROP TABLE roadmap_lanes")
        conn.execute("PRAGMA user_version = 10")
        conn.execute("CREATE TABLE roadmap_items (id TEXT PRIMARY KEY)")
        conn.commit()
        before = _snapshot_db(conn)

        with pytest.raises(sqlite3.OperationalError):
            db.init_db(conn)

        assert _snapshot_db(conn) == before
    finally:
        conn.close()


def test_v11_migration_rejects_malformed_complete_table_set_without_mutation(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    try:
        conn.execute("DROP TABLE roadmap_items")
        conn.execute("DROP TABLE roadmap_lanes")
        conn.execute(
            "CREATE TABLE roadmap_lanes ("
            "id TEXT PRIMARY KEY, project_id TEXT, sort_order INTEGER)"
        )
        conn.execute(
            "CREATE TABLE roadmap_items ("
            "id TEXT PRIMARY KEY, project_id TEXT, lane_id TEXT, sort_order INTEGER)"
        )
        conn.execute("PRAGMA user_version = 11")
        conn.commit()
        before = _snapshot_db(conn)

        with pytest.raises((db.BoundaryError, ValueError)):
            db.init_db(conn)

        assert _snapshot_db(conn) == before
    finally:
        conn.close()


def test_roadmap_rejects_missing_dependency_targets_before_insert_and_update(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    try:
        lane = _lane(conn)
        before = _snapshot_db(conn)
        with pytest.raises((TypeError, ValueError, sqlite3.IntegrityError)):
            db.create_roadmap_item(
                conn,
                project_id="p_1",
                lane_id=lane["id"],
                title="Missing dependency",
                depends_on=["rmi_missing"],
            )
        assert _snapshot_db(conn) == before

        item = db.create_roadmap_item(
            conn, project_id="p_1", lane_id=lane["id"], title="Keep"
        )
        before = _snapshot_db(conn)
        with pytest.raises((TypeError, ValueError, sqlite3.IntegrityError)):
            db.update_roadmap_item(
                conn,
                project_id="p_1",
                item_id=item["id"],
                depends_on=["rmi_missing"],
                expected_updated_at=item["updated_at"],
            )
        assert _snapshot_db(conn) == before
    finally:
        conn.close()


def test_roadmap_rejects_arbitrary_missing_dependency_targets_before_insert_and_update(tmp_path, monkeypatch):
    conn = _conn(tmp_path, monkeypatch)
    try:
        lane = _lane(conn)
        missing_target = "dependency-that-does-not-exist"
        before = _snapshot_db(conn)
        with pytest.raises((TypeError, ValueError, sqlite3.IntegrityError)):
            db.create_roadmap_item(
                conn,
                project_id="p_1",
                lane_id=lane["id"],
                title="Missing arbitrary dependency",
                depends_on=[missing_target],
            )
        assert _snapshot_db(conn) == before

        item = db.create_roadmap_item(
            conn, project_id="p_1", lane_id=lane["id"], title="Keep"
        )
        before = _snapshot_db(conn)
        with pytest.raises((TypeError, ValueError, sqlite3.IntegrityError)):
            db.update_roadmap_item(
                conn,
                project_id="p_1",
                item_id=item["id"],
                depends_on=[missing_target],
                expected_updated_at=item["updated_at"],
            )
        assert _snapshot_db(conn) == before
    finally:
        conn.close()


@pytest.mark.parametrize("column", ["depends_on_json", "links_json"])
def test_v11_preflight_rejects_malformed_existing_roadmap_json_without_mutation(
    tmp_path, monkeypatch, column
):
    conn = _conn(tmp_path, monkeypatch)
    try:
        lane = _lane(conn)
        item = db.create_roadmap_item(
            conn, project_id="p_1", lane_id=lane["id"], title="Malformed payload"
        )
        conn.execute(
            f"UPDATE roadmap_items SET {column} = ? WHERE id = ?",
            ("{not-json", item["id"]),
        )
        conn.commit()
        before = _snapshot_db(conn)

        with pytest.raises((db.BoundaryError, ValueError)):
            db.init_db(conn)

        assert _snapshot_db(conn) == before
    finally:
        conn.close()


def test_v11_preflight_rejects_roadmap_items_without_status_check_without_mutation(
    tmp_path, monkeypatch
):
    conn = _conn(tmp_path, monkeypatch)
    try:
        conn.execute("DROP TABLE roadmap_items")
        conn.execute(
            "CREATE TABLE roadmap_items ("
            "id TEXT PRIMARY KEY, project_id TEXT NOT NULL, lane_id TEXT NOT NULL, "
            "title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'planned', "
            "sort_order INTEGER NOT NULL DEFAULT 0, depends_on_json TEXT NOT NULL DEFAULT '[]', "
            "links_json TEXT NOT NULL DEFAULT '[]', created_at REAL NOT NULL, updated_at REAL NOT NULL, "
            "UNIQUE(project_id, id), "
            "FOREIGN KEY(project_id, lane_id) REFERENCES roadmap_lanes(project_id, id) "
            "ON DELETE RESTRICT ON UPDATE RESTRICT"
            ")"
        )
        conn.execute(
            "CREATE INDEX idx_roadmap_items_project "
            "ON roadmap_items(project_id, lane_id, sort_order, id)"
        )
        conn.commit()
        before = _snapshot_db(conn)

        with pytest.raises((db.BoundaryError, ValueError)):
            db.init_db(conn)

        assert _snapshot_db(conn) == before
    finally:
        conn.close()
