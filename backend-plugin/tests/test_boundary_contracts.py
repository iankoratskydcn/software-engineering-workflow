"""Hostile acceptance tests for Task 1 shared trust-boundary contracts.

These tests intentionally name the small shared seam Task 1 must provide:
``db.validate_text``, ``db.validate_list``, ``db.validate_json_text``,
``db.validate_coordinate``, ``db.require_project_scope``, and
``cli.boundary_error``.  They are contract tests, not implementation tests;
production code may alias/re-export equivalent helpers from another module.
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cli  # noqa: E402
import db  # noqa: E402


LIMITS = {
    "text_chars": 4096,
    "id_chars": 128,
    "list_items": 256,
    "list_value_chars": 512,
    "json_bytes": 262144,
    "coordinate_min": -100000,
    "coordinate_max": 100000,
}


def _helper(name):
    helper = getattr(db, name, None)
    assert callable(helper), f"Task 1 shared helper missing: db.{name}"
    return helper


def _projects_db(tmp_path: Path, *rows: tuple[str, str, str]) -> None:
    conn = sqlite3.connect(tmp_path / "projects.db")
    conn.execute(
        "CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, "
        "name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"
    )
    conn.executemany(
        "INSERT INTO projects (id, slug, name, created_at) VALUES (?, ?, ?, 0)", rows
    )
    conn.commit()
    conn.close()


def test_strict_string_rejects_non_strings_before_strip():
    validate = _helper("validate_text")
    for value in (None, 1, True, [], {}, object()):
        with pytest.raises(ValueError):
            validate(value, field="title", max_chars=LIMITS["text_chars"])


def test_text_and_id_bounds_are_exact_and_no_coercion():
    validate = _helper("validate_text")
    assert validate(" x ", field="title", max_chars=3) == "x"
    for value, limit in (("x" * 4097, 4096), ("i" * 129, 128)):
        with pytest.raises(ValueError):
            validate(value, field="value", max_chars=limit)


def test_list_count_and_per_value_bounds_are_enforced():
    validate = _helper("validate_list")
    assert validate(["a", "b"], field="choices", max_items=256, max_value_chars=512) == ["a", "b"]
    with pytest.raises(ValueError):
        validate(["x"] * 257, field="choices", max_items=256, max_value_chars=512)
    with pytest.raises(ValueError):
        validate(["x" * 513], field="choices", max_items=256, max_value_chars=512)
    for bad in ("abc", {"x": 1}, [1], [None]):
        with pytest.raises(ValueError):
            validate(bad, field="choices", max_items=256, max_value_chars=512)


def test_json_raw_limit_happens_before_decode(monkeypatch):
    validate = _helper("validate_json_text")
    raw = "{" + '"x":"' + ("a" * (LIMITS["json_bytes"] + 1)) + '"}'
    called = False
    original = json.loads

    def loads(value, *args, **kwargs):
        nonlocal called
        called = True
        return original(value, *args, **kwargs)

    monkeypatch.setattr(db.json, "loads", loads)
    with pytest.raises(ValueError):
        validate(raw, field="payload", max_bytes=LIMITS["json_bytes"])
    assert called is False, "oversized raw JSON must be rejected before parsing"


def test_json_decoded_shape_depth_and_aggregate_bounds_are_enforced():
    validate = _helper("validate_json_text")
    assert validate('{"ok": [1, 2]}', field="payload", max_bytes=LIMITS["json_bytes"])
    with pytest.raises(ValueError):
        validate(json.dumps({str(i): i for i in range(257)}), field="payload", max_bytes=LIMITS["json_bytes"])
    nested = value = {}
    for _ in range(9):
        value["x"] = {}
        value = value["x"]
    with pytest.raises(ValueError):
        validate(json.dumps(nested), field="payload", max_bytes=LIMITS["json_bytes"])


def test_coordinates_require_finite_numbers_with_shared_bounds():
    validate = _helper("validate_coordinate")
    for value in (float("nan"), float("inf"), float("-inf"), -100001, 100001, "1", True):
        with pytest.raises(ValueError):
            validate(value, field="x", minimum=-100000, maximum=100000)
    assert validate(-100000, field="x", minimum=-100000, maximum=100000) == -100000
    assert validate(100000, field="y", minimum=-100000, maximum=100000) == 100000


def test_project_scope_error_shape_and_no_mutation(tmp_path, monkeypatch):
    _projects_db(tmp_path, ("p_one", "one", "One"), ("p_two", "two", "Two"))
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    conn = db.connect()
    try:
        before = conn.execute("SELECT COUNT(*) FROM decisions").fetchone()[0]
        require = _helper("require_project_scope")
        with pytest.raises(Exception) as excinfo:
            require(conn, project_id="p_two", row_project_id="p_one")
        error = excinfo.value
        assert getattr(error, "code", None) in {"not_found", "invalid_input"}
        assert not any(secret in str(error) for secret in ("p_one", "p_two", "SELECT", "sqlite"))
        after = conn.execute("SELECT COUNT(*) FROM decisions").fetchone()[0]
        assert after == before
    finally:
        conn.close()


def test_missing_and_cross_project_ids_share_external_error_identity():
    require = _helper("require_project_scope")
    errors = []
    for target in (None, "other-project"):
        try:
            require(None, project_id="caller-project", row_project_id=target)
        except Exception as exc:
            errors.append(exc)
    assert len(errors) == 2
    assert getattr(errors[0], "code", None) == getattr(errors[1], "code", None) == "not_found"
    assert str(errors[0]) == str(errors[1])


def test_fk_pragma_is_enabled_before_schema_or_data_statements(tmp_path):
    # Direct callers of init_db are inside the application trust boundary too;
    # a fresh connection must not create/write schema with FK checks disabled.
    conn = sqlite3.connect(tmp_path / "queue.db")
    conn.row_factory = sqlite3.Row
    try:
        db.init_db(conn)
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    finally:
        conn.close()


def test_cli_error_mapping_is_stable_machine_readable_and_safe():
    mapper = getattr(cli, "boundary_error", None)
    assert callable(mapper), "Task 1 CLI error mapper missing: cli.boundary_error"
    cases = [
        (ValueError("bad input"), "invalid_input", 2),
        (FileNotFoundError("secret/path"), "not_found", 3),
        (sqlite3.IntegrityError("UNIQUE failed"), "constraint", 6),
        (sqlite3.OperationalError("database is locked"), "busy", 5),
        (RuntimeError("secret traceback"), "internal_error", 1),
    ]
    for error, code, exit_code in cases:
        envelope, actual_exit = mapper(error)
        assert envelope == {"ok": False, "error": {"code": code, "message": envelope["error"]["message"]}}
        assert actual_exit == exit_code
        assert "secret" not in json.dumps(envelope)
        assert "SQL" not in json.dumps(envelope).upper()
