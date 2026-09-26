"""Regression tests for Spec Digest trust-boundary defects."""

from __future__ import annotations

import json
import sqlite3
import sys
import time
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cli  # noqa: E402
import db  # noqa: E402


def _mkconn(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    conn = db.connect()
    return conn


def _mkproject(tmp_path, project_id, slug=None):
    conn = sqlite3.connect(str(tmp_path / "projects.db"))
    conn.execute("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT)")
    conn.execute("INSERT INTO projects VALUES (?, ?, ?)", (project_id, slug or project_id, project_id))
    conn.commit()
    conn.close()


def _mknoderow(conn, project_id, node_id=None, kind="theme", parent_id=None):
    nid = node_id or uuid.uuid4().hex[:12]
    now = time.time()
    conn.execute(
        "INSERT INTO spec_nodes (id, project_id, kind, parent_id, title, status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (nid, project_id, kind, parent_id, f"{kind}_{nid[:6]}", "draft", now, now),
    )
    conn.commit()
    return nid


def _mkcmdargs(verb, **kw):
    import argparse
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    args = ["spec", verb]
    for key, value in kw.items():
        args.extend([f"--{key.replace('_', '-')}", str(value)])
    return parser.parse_args(args)


def test_cycle_depth_exhaustion_rejected(tmp_path, monkeypatch):
    conn = _mkconn(tmp_path, monkeypatch)
    _mkproject(tmp_path, "p")
    nodes = []
    parent = None
    for i in range(1001):
        node = _mknoderow(conn, "p", node_id=f"n{i}", parent_id=parent)
        nodes.append(node)
        parent = node
    conn.execute("UPDATE spec_nodes SET parent_id = ? WHERE id = ?", (nodes[-1], nodes[0]))
    conn.commit()
    from cli_spec_cmds import _has_cycle_in_ancestors
    with pytest.raises(ValueError, match="depth"):
        _has_cycle_in_ancestors(conn, nodes[1])


def test_connect_enables_foreign_keys(tmp_path, monkeypatch):
    conn = _mkconn(tmp_path, monkeypatch)
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_delete_children_check_is_atomic(tmp_path, monkeypatch):
    conn = _mkconn(tmp_path, monkeypatch)
    _mkproject(tmp_path, "p")
    parent = _mknoderow(conn, "p")
    child = _mknoderow(conn, "p", parent_id=parent)
    conn.execute("PRAGMA busy_timeout = 1")
    with pytest.raises(ValueError, match="children"):
        from cli_spec_cmds import _delete_node
        _delete_node(conn, parent)
    assert conn.execute("SELECT id FROM spec_nodes WHERE id = ?", (child,)).fetchone()


def test_add_node_slug_persists_canonical_project_id(tmp_path, monkeypatch, capsys):
    conn = _mkconn(tmp_path, monkeypatch)
    _mkproject(tmp_path, "p_canonical", slug="demo")
    conn.close()
    args = _mkcmdargs("add-node", project_id="demo", kind="theme", title="Root")
    args.func(args)
    result = json.loads(capsys.readouterr().out)
    assert result["node"]["project_id"] == "p_canonical"


def test_ui_malformed_criteria_has_safe_fallback():
    source = Path(__file__).resolve().parents[2].joinpath("plugin.js").read_text()
    assert "criteria_json" in source
    assert "malformed criteria" in source or "criteriaError" in source
