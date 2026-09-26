"""Invariant tests for the v5 migration (missing_constraint / Rule 4
PO-escalation-on-2nd-failure mechanism) — written BEFORE the implementation
per task instructions.

Isolated from the live ~/.hermes/decision_hud/queue.db entirely: every test
builds its own throwaway sqlite3 connection against a tmp_path file and
calls db.init_db()/db functions directly, never db.connect() (which would
touch the real hermes home / live queue.db).
"""

from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402  (local module: db.py in this worktree)


def _conn(tmp_path: Path) -> sqlite3.Connection:
    c = sqlite3.connect(str(tmp_path / "test_queue.db"))
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA busy_timeout=5000")
    db.init_db(c)
    return c


PROJECT_ID = "p_test_proj_a"


def _make_projects_db(tmp_path: Path) -> None:
    """v6: push_missing_constraint/require_constraint_resolved now validate
    project_id against a real projects.db row (see db._resolve_project) —
    every test needs monkeypatch(db._hermes_home) pointed at tmp_path AND
    this fixture so PROJECT_ID actually resolves."""
    p = tmp_path / "projects.db"
    conn = sqlite3.connect(str(p))
    conn.execute(
        "CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, "
        "archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"
    )
    conn.execute(
        "INSERT INTO projects (id, slug, name, created_at) VALUES (?, 'proj-a', 'Project A', 0)",
        (PROJECT_ID,),
    )
    conn.commit()
    conn.close()


def _token(actor: str = "test-po") -> str:
    # issue_actor_token writes to _actor_token_dir() under _hermes_home();
    # fine for tests (isolated per-process, no live-db writes), matches
    # resolve_decision's real authorization path rather than bypassing it.
    return db.issue_actor_token(actor)


def _resolve_as_human(conn, decision_id, choice, payload=None, *, actor_token):
    """resolve_decision() fail-closed-rejects any process running under
    HERMES_DELEGATED_CHILD_CONTEXT (this test suite itself may run as a
    delegated subagent under Hermes orchestration). Temporarily clearing the
    marker here simulates the interactive/human resolution path the real
    desktop pane uses — it does NOT weaken resolve_decision itself, which is
    unmodified and re-checks the env var fresh on every call."""
    prev = os.environ.pop("HERMES_DELEGATED_CHILD_CONTEXT", None)
    try:
        return db.resolve_decision(conn, decision_id, choice, payload, actor_token=actor_token)
    finally:
        if prev is not None:
            os.environ["HERMES_DELEGATED_CHILD_CONTEXT"] = prev


# --- (1) push_missing_constraint creates a real row -------------------------

def test_push_missing_constraint_creates_row_with_card_type(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _make_projects_db(tmp_path)
    conn = _conn(tmp_path)
    result = db.push_missing_constraint(
        conn, project_id=PROJECT_ID, task_id="task-1",
        question="What retry backoff should task-1 use?",
    )
    assert result["card_type"] == "missing_constraint"
    assert result["project_id"] == PROJECT_ID
    assert result["card_payload"]["task_id"] == "task-1"
    assert result["card_payload"]["question"] == "What retry backoff should task-1 use?"
    assert result["resolved_at"] is None

    # Really landed in the decisions table, not just returned in-memory.
    row = conn.execute(
        "SELECT * FROM decisions WHERE card_type = 'missing_constraint' AND id = ?",
        (result["id"],),
    ).fetchone()
    assert row is not None
    assert row["project_id"] == PROJECT_ID


# --- (2) require_constraint_resolved raises when absent / unresolved --------

def test_require_constraint_resolved_raises_when_no_row_exists(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _make_projects_db(tmp_path)
    conn = _conn(tmp_path)
    try:
        db.require_constraint_resolved(conn, project_id=PROJECT_ID, task_id="never-pushed")
        assert False, "expected ConstraintNotResolved"
    except db.ConstraintNotResolved:
        pass


def test_require_constraint_resolved_raises_when_unresolved(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _make_projects_db(tmp_path)
    conn = _conn(tmp_path)
    db.push_missing_constraint(
        conn, project_id=PROJECT_ID, task_id="task-2", question="Which auth scheme?",
    )
    try:
        db.require_constraint_resolved(conn, project_id=PROJECT_ID, task_id="task-2")
        assert False, "expected ConstraintNotResolved"
    except db.ConstraintNotResolved:
        pass


# --- (3) require_constraint_resolved succeeds once resolved ------------------

def test_require_constraint_resolved_succeeds_after_resolution(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _make_projects_db(tmp_path)
    conn = _conn(tmp_path)
    pushed = db.push_missing_constraint(
        conn, project_id=PROJECT_ID, task_id="task-3", question="What timeout value?",
    )
    token = _token()
    resolved = _resolve_as_human(
        conn, pushed["id"], "resolved", payload={"timeout_seconds": 30}, actor_token=token,
    )
    assert resolved["resolved_at"] is not None

    result = db.require_constraint_resolved(conn, project_id=PROJECT_ID, task_id="task-3")
    assert result["resolved_choice"] == "resolved"
    assert result["resolved_payload"]["timeout_seconds"] == 30
    assert result["id"] == pushed["id"]


# --- (4) duplicate push_missing_constraint for the same task_id -------------
#
# Explicit design choice (documented in db.py's push_missing_constraint
# docstring): a second push for a (project_id, task_id) that still has an
# UNRESOLVED missing_constraint row raises ValueError (mirrors
# push_batch_approval's raise-on-duplicate — a retried escalation call must
# not fork multiple open PO questions for the same task). Once the first is
# resolved, a later push for the same task_id IS allowed (a task can hit an
# independent second missing-constraint escalation later) and becomes the
# new latest/current row.

def test_duplicate_push_while_unresolved_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _make_projects_db(tmp_path)
    conn = _conn(tmp_path)
    db.push_missing_constraint(
        conn, project_id=PROJECT_ID, task_id="task-4", question="First question?",
    )
    try:
        db.push_missing_constraint(
            conn, project_id=PROJECT_ID, task_id="task-4", question="Second question, still open?",
        )
        assert False, "expected ValueError on duplicate open missing_constraint"
    except ValueError as exc:
        assert "task-4" in str(exc)


def test_push_after_prior_resolution_is_allowed_and_becomes_latest(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _make_projects_db(tmp_path)
    conn = _conn(tmp_path)
    first = db.push_missing_constraint(
        conn, project_id=PROJECT_ID, task_id="task-5", question="First round question?",
    )
    token = _token()
    _resolve_as_human(conn, first["id"], "resolved", actor_token=token)

    second = db.push_missing_constraint(
        conn, project_id=PROJECT_ID, task_id="task-5", question="Second round, new question?",
    )
    assert second["id"] != first["id"]

    # require_constraint_resolved must fail closed again: the LATEST row
    # for task-5 is the new unresolved one, even though an older resolved
    # row for the same task_id exists.
    try:
        db.require_constraint_resolved(conn, project_id=PROJECT_ID, task_id="task-5")
        assert False, "expected ConstraintNotResolved for the new unresolved escalation"
    except db.ConstraintNotResolved:
        pass


# --- (5) PRAGMA user_version advances (now 12, post v12 cutover), idempotent --

def test_user_version_advances_and_init_db_is_idempotent(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    conn = _conn(tmp_path)
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    assert version == 12

    # Running init_db a second time on the same connection/file must not
    # error and must not double-apply (columns already present, version
    # already 12 — every _migrate_vN_columns call is a no-op the 2nd time).
    db.init_db(conn)
    version_again = conn.execute("PRAGMA user_version").fetchone()[0]
    assert version_again == 12

    # And a brand-new connection against the SAME on-disk file (simulating
    # process restart hitting an already-migrated db) is equally idempotent.
    conn2 = sqlite3.connect(str(Path(conn.execute("PRAGMA database_list").fetchone()[2])))
    conn2.row_factory = sqlite3.Row
    db.init_db(conn2)
    assert conn2.execute("PRAGMA user_version").fetchone()[0] == 12
    conn2.close()

    # No duplicate/extra columns were introduced by the no-op v5 migration
    # (task requirement: v5 adds ZERO new columns to decisions).
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(decisions)").fetchall()]
    assert cols.count("card_type") == 1
    assert cols.count("batch_id") == 1
