"""Contract tests for the canonical MindMap demo seed command."""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cli  # noqa: E402
import db  # noqa: E402


def _mkproject(tmp_path: Path, project_id: str = "p_demo") -> None:
    conn = sqlite3.connect(tmp_path / "projects.db")
    conn.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT)")
    conn.execute("INSERT INTO projects VALUES (?, ?, ?)", (project_id, "demo", "Demo"))
    conn.commit()
    conn.close()


def _parse(tmp_path: Path, project_id: str = "p_demo"):
    parser = __import__("argparse").ArgumentParser()
    cli.setup(parser)
    return parser.parse_args(["spec", "seed-demo", "--project-id", project_id])


def test_seed_demo_is_idempotent_and_builds_four_level_tree(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _mkproject(tmp_path)

    args = _parse(tmp_path)
    args.func(args)
    first = json.loads(capsys.readouterr().out)

    args.func(args)
    second = json.loads(capsys.readouterr().out)

    assert first["ok"] is True
    assert second["ok"] is True
    assert first["created_or_reused_root"] == second["created_or_reused_root"]

    conn = db.connect()
    try:
        rows = conn.execute(
            "SELECT kind, level, title, parent_id FROM spec_nodes WHERE project_id = ? ORDER BY level, title",
            ("p_demo",),
        ).fetchall()
        assert len(rows) == 7
        assert {row["kind"] for row in rows} == {"theme", "epic", "feature", "story"}
        assert {row["level"] for row in rows} == {0, 1, 2, 3}
        assert rows[0]["title"] == "Software Engineering Workflow"
    finally:
        conn.close()


def test_seed_demo_refuses_to_replace_an_existing_different_root(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    _mkproject(tmp_path)
    conn = db.connect()
    try:
        db.create_spec_node(conn, project_id="p_demo", kind="theme", title="Existing product")
    finally:
        conn.close()

    with pytest.raises(SystemExit) as exc:
        _parse(tmp_path).func(_parse(tmp_path))
    assert exc.value.code == 4
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] is False
    assert result["error"]["code"] == "conflict"
