"""Hostile canonical contracts for Risk & Tradeoffs remediation."""

from __future__ import annotations

import importlib.util
import inspect
import json
import sqlite3
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("decision_hud_db_risk_contract", ROOT / "db.py")
db = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(db)


def setup_conn(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(
        db,
        "_resolve_project",
        lambda project_id: {"id": project_id, "slug": project_id, "name": project_id},
    )
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    db.init_db(conn)
    return conn


def insert_decision(conn, decision_id: str, project_id: str) -> None:
    conn.execute(
        "INSERT INTO decisions (id, project_id, question, choices_json, urgency, created_at) "
        "VALUES (?, ?, ?, ?, 'normal', 1)",
        (decision_id, project_id, "Question", json.dumps(["a", "b"])),
    )
    conn.commit()


def test_canonical_schema_has_closed_fields_constraints_and_v12(monkeypatch, tmp_path):
    conn = setup_conn(monkeypatch, tmp_path)
    try:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 12
        risk_columns = {row["name"] for row in conn.execute("PRAGMA table_info(risks)")}
        assert risk_columns == {
            "id", "project_id", "decision_id", "title", "description", "breaks_when",
            "status", "created_at", "updated_at",
        }
        tradeoff_columns = {row["name"] for row in conn.execute("PRAGMA table_info(tradeoffs)")}
        assert tradeoff_columns == {
            "id", "project_id", "decision_id", "kind", "title", "choice", "alt_label",
            "cost", "gain", "prioritized_side", "created_at", "updated_at",
        }
        risk_sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='risks'"
        ).fetchone()[0]
        tradeoff_sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='tradeoffs'"
        ).fetchone()[0]
        assert "status IN ('open','mitigated','accepted','closed')" in risk_sql
        assert "kind IN ('scale','duel','anchor')" in tradeoff_sql
        assert "prioritized_side IS NULL OR prioritized_side IN ('a','b')" in tradeoff_sql
        assert "FOREIGN KEY(project_id,decision_id)" in risk_sql
        assert "FOREIGN KEY(project_id,decision_id)" in tradeoff_sql
    finally:
        conn.close()


def test_tradeoff_kind_is_required_and_canonical_fields_round_trip(monkeypatch, tmp_path):
    conn = setup_conn(monkeypatch, tmp_path)
    try:
        signature = inspect.signature(db.add_tradeoff)
        assert signature.parameters["kind"].default is inspect.Parameter.empty
        with pytest.raises(TypeError):
            db.add_tradeoff(conn, project_id="p1", title="T", choice="A")

        tradeoff = db.add_tradeoff(
            conn,
            project_id="p1",
            kind="duel",
            title="Speed versus safety",
            choice="Speed",
            alt_label="Safety",
            cost="migration risk",
            gain="faster delivery",
        )
        assert tradeoff["kind"] == "duel"
        assert tradeoff["choice"] == "Speed"
        assert tradeoff["alt_label"] == "Safety"
        assert tradeoff["cost"] == "migration risk"
        assert tradeoff["gain"] == "faster delivery"
        assert tradeoff["prioritized_side"] is None
    finally:
        conn.close()


@pytest.mark.parametrize("kind", ["", "bogus", None, 1, True])
def test_tradeoff_kind_rejects_missing_invalid_and_non_string_values(monkeypatch, tmp_path, kind):
    conn = setup_conn(monkeypatch, tmp_path)
    try:
        before = conn.execute("SELECT COUNT(*) FROM tradeoffs").fetchone()[0]
        with pytest.raises((TypeError, ValueError)):
            db.add_tradeoff(conn, project_id="p1", kind=kind, title="T", choice="A")
        assert conn.execute("SELECT COUNT(*) FROM tradeoffs").fetchone()[0] == before
    finally:
        conn.close()


@pytest.mark.parametrize(
    "factory, field, value",
    [
        ("risk", "title", 7),
        ("risk", "description", 7),
        ("risk", "breaks_when", 7),
        ("tradeoff", "title", 7),
        ("tradeoff", "choice", 7),
        ("tradeoff", "alt_label", 7),
        ("tradeoff", "cost", 7),
        ("tradeoff", "gain", 7),
    ],
)
def test_all_risk_tradeoff_text_fields_reject_non_strings_before_mutation(
    monkeypatch, tmp_path, factory, field, value
):
    conn = setup_conn(monkeypatch, tmp_path)
    try:
        kwargs = {field: value}
        if factory == "risk":
            kwargs.update(title="T", description=None, breaks_when=None)
            kwargs[field] = value
            operation = db.add_risk
        else:
            kwargs.update(kind="scale", title="T", choice="A")
            kwargs[field] = value
            operation = db.add_tradeoff
        with pytest.raises((TypeError, ValueError)):
            operation(conn, project_id="p1", **kwargs)
        table = "risks" if factory == "risk" else "tradeoffs"
        assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    finally:
        conn.close()


@pytest.mark.parametrize("operation, kwargs", [
    ("risk", {"title": "x" * 4097}),
    ("risk", {"description": "x" * 4097}),
    ("risk", {"breaks_when": "x" * 4097}),
    ("tradeoff", {"title": "x" * 4097}),
    ("tradeoff", {"choice": "x" * 4097}),
    ("tradeoff", {"alt_label": "x" * 4097}),
    ("tradeoff", {"cost": "x" * 4097}),
    ("tradeoff", {"gain": "x" * 4097}),
])
def test_all_risk_tradeoff_text_fields_are_bounded_and_failed_add_preserves_rows(
    monkeypatch, tmp_path, operation, kwargs
):
    conn = setup_conn(monkeypatch, tmp_path)
    try:
        if operation == "risk":
            base = {"title": "T"}
            add = db.add_risk
            table = "risks"
        else:
            base = {"kind": "scale", "title": "T", "choice": "A"}
            add = db.add_tradeoff
            table = "tradeoffs"
        base.update(kwargs)
        before = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        with pytest.raises((TypeError, ValueError)):
            add(conn, project_id="p1", **base)
        assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == before
    finally:
        conn.close()


def test_project_scope_applies_to_add_list_update_status_side_and_links(monkeypatch, tmp_path):
    conn = setup_conn(monkeypatch, tmp_path)
    try:
        insert_decision(conn, "d1", "p1")
        insert_decision(conn, "d2", "p2")
        risk = db.add_risk(conn, project_id="p1", title="R", decision_id="d1")
        tradeoff = db.add_tradeoff(conn, project_id="p1", kind="scale", title="T", choice="A", decision_id="d1")
        assert db.list_risks(conn, project_id="p2") == []
        assert db.list_tradeoffs(conn, project_id="p2") == []
        with pytest.raises((TypeError, ValueError)):
            db.update_risk_status(conn, project_id="p2", risk_id=risk["id"], status="closed")
        with pytest.raises((TypeError, ValueError)):
            db.set_prioritized_side(conn, project_id="p2", tradeoff_id=tradeoff["id"], side="b")
        assert db.list_risks(conn, project_id="p1")[0]["status"] == "open"
        assert db.list_tradeoffs(conn, project_id="p1")[0]["prioritized_side"] is None
        for factory, kwargs in [
            (db.add_risk, {"title": "orphan", "decision_id": "missing"}),
            (db.add_risk, {"title": "cross", "decision_id": "d2"}),
            (db.add_tradeoff, {"kind": "scale", "title": "orphan", "choice": "A", "decision_id": "missing"}),
            (db.add_tradeoff, {"kind": "scale", "title": "cross", "choice": "A", "decision_id": "d2"}),
        ]:
            with pytest.raises((TypeError, ValueError, sqlite3.IntegrityError)):
                factory(conn, project_id="p1", **kwargs)
        assert len(db.list_risks(conn, project_id="p1")) == 1
        assert len(db.list_tradeoffs(conn, project_id="p1")) == 1
    finally:
        conn.close()


def test_raw_sqlite_constraints_reject_invalid_status_kind_and_side(monkeypatch, tmp_path):
    conn = setup_conn(monkeypatch, tmp_path)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO risks (id, project_id, title, status, created_at, updated_at) VALUES ('r', 'p1', 'R', 'bad', 1, 1)"
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO tradeoffs (id, project_id, kind, title, choice, created_at, updated_at) VALUES ('t', 'p1', 'bad', 'T', 'A', 1, 1)"
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO tradeoffs (id, project_id, kind, title, choice, prioritized_side, created_at, updated_at) VALUES ('t2', 'p1', 'scale', 'T', 'A', 'x', 1, 1)"
            )
        conn.rollback()
    finally:
        conn.close()


def test_preexisting_v7_unconstrained_risk_tradeoff_schema_is_rebuilt_or_refused_without_mutation(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        PRAGMA foreign_keys = ON;
        PRAGMA user_version = 7;
        CREATE TABLE decisions (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, question TEXT NOT NULL,
            choices_json TEXT NOT NULL, urgency TEXT NOT NULL DEFAULT 'normal',
            created_at REAL NOT NULL, resolved_choice TEXT, resolved_at REAL
        );
        CREATE TABLE risks (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, decision_id TEXT,
            title TEXT NOT NULL, description TEXT, breaks_when TEXT,
            status TEXT NOT NULL DEFAULT 'open', created_at REAL NOT NULL, updated_at REAL NOT NULL
        );
        CREATE TABLE tradeoffs (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, decision_id TEXT,
            kind TEXT, title TEXT NOT NULL, choice TEXT NOT NULL, alt_label TEXT,
            cost TEXT, gain TEXT, prioritized_side TEXT,
            created_at REAL NOT NULL, updated_at REAL NOT NULL
        );
        INSERT INTO risks VALUES ('r1', 'p1', NULL, 'Legacy risk', NULL, NULL, 'open', 1, 1);
        INSERT INTO tradeoffs VALUES ('t1', 'p1', NULL, 'scale', 'Legacy tradeoff', 'A', NULL, NULL, NULL, NULL, 1, 1);
        """
    )
    before_dump = "\\n".join(conn.iterdump())
    try:
        try:
            db.init_db(conn)
        except Exception as exc:
            assert conn.execute("PRAGMA user_version").fetchone()[0] < 9
            assert "risk" in str(exc).lower() or "tradeoff" in str(exc).lower() or "constraint" in str(exc).lower()
            assert "\\n".join(conn.iterdump()) == before_dump
        else:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == 12
            for table, check in (
                ("risks", "status IN ('open','mitigated','accepted','closed')"),
                ("tradeoffs", "kind IN ('scale','duel','anchor')"),
            ):
                sql = conn.execute(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
                ).fetchone()[0]
                assert check in sql
                assert "FOREIGN KEY(project_id,decision_id)" in sql
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO risks (id, project_id, title, status, created_at, updated_at) "
                    "VALUES ('bad-risk', 'p1', 'Bad', 'invalid', 2, 2)"
                )
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO tradeoffs (id, project_id, kind, title, choice, created_at, updated_at) "
                    "VALUES ('bad-tradeoff', 'p1', 'invalid', 'Bad', 'A', 2, 2)"
                )
            assert conn.execute("SELECT title FROM risks WHERE id='r1'").fetchone()[0] == "Legacy risk"
            assert conn.execute("SELECT title FROM tradeoffs WHERE id='t1'").fetchone()[0] == "Legacy tradeoff"
    finally:
        conn.close()


def test_invalid_legacy_tradeoff_kind_refuses_migration_without_mutation(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        PRAGMA user_version = 7;
        CREATE TABLE tradeoffs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
          choice TEXT NOT NULL, kind TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL);
        INSERT INTO tradeoffs VALUES ('legacy', 'p1', 'Legacy', 'A', 'invalid', 1, 1);
        """
    )
    before_dump = "\n".join(conn.iterdump())
    with pytest.raises(Exception) as exc_info:
        db.init_db(conn)
    message = str(exc_info.value).lower()
    assert "tradeoff" in message and ("kind" in message or "legacy" in message or "migration" in message)
    assert "\n".join(conn.iterdump()) == before_dump
    assert conn.execute("SELECT kind FROM tradeoffs WHERE id='legacy'").fetchone()[0] == "invalid"
    conn.close()
