"""Tests for decision_hud_mcp.decision_classify_card_type — the thin
read-only wrapper around db._card_type_verdict that replaced the regex
text-classifier (card_type_classifier.py, deleted). This tool does NOT
infer anything from question/choices text; it only resolves bucket+answers
the caller supplies and verifies the result, so every test here exercises
the resolve/verify contract, never text inference (there is none).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402

_PLUGIN_DIR = Path(__file__).resolve().parent.parent

_SCALAR_ANSWERS = {
    "is_interval_not_point": False,
    "is_fixed_total_split": False,
    "needs_confidence_axis": False,
    "prefers_visual_segments": False,
}


def _import_mcp_module(tmp_path, monkeypatch):
    """Same stub-the-mcp-package approach as test_card_type_plumbing_e2e.py
    — import decision_hud_mcp.py's plain functions without the real MCP
    runtime, reusing the already-imported, already-patched db module."""
    import types
    import importlib

    fake_mcp_pkg = types.ModuleType("mcp")
    fake_mcp_server_pkg = types.ModuleType("mcp.server")
    fake_mcp_server_mcpserver = types.ModuleType("mcp.server.mcpserver")

    class _FakeMCPServer:
        def __init__(self, name):
            self.name = name

        def tool(self):
            def _decorator(fn):
                return fn
            return _decorator

        def run(self):
            pass

    fake_mcp_server_mcpserver.MCPServer = _FakeMCPServer
    monkeypatch.setitem(sys.modules, "mcp", fake_mcp_pkg)
    monkeypatch.setitem(sys.modules, "mcp.server", fake_mcp_server_pkg)
    monkeypatch.setitem(sys.modules, "mcp.server.mcpserver", fake_mcp_server_mcpserver)
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    monkeypatch.setitem(sys.modules, "db", db)

    spec = importlib.util.spec_from_file_location(
        "decision_hud_mcp_under_test", _PLUGIN_DIR / "decision_hud_mcp.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_no_bucket_lists_every_bucket_and_its_discriminants(tmp_path, monkeypatch):
    mod = _import_mcp_module(tmp_path, monkeypatch)
    result = json.loads(mod.decision_classify_card_type())
    assert result["ok"] is True
    assert "scalar" in result["buckets"]
    assert "scalar_slider" in result["buckets"]["scalar"]["card_types"]
    assert set(_SCALAR_ANSWERS) == set(result["buckets"]["scalar"]["discriminants"])


def test_resolved_result_is_accepted_straight_through_by_decision_push(tmp_path, monkeypatch):
    """The core correctness property: whatever this tool returns as
    "resolved" must be exactly what push_decision's _verify_card_type
    accepts -- same engine on both sides, zero drift possible."""
    mod = _import_mcp_module(tmp_path, monkeypatch)
    classify_result = json.loads(mod.decision_classify_card_type(
        bucket="scalar", answers_json=json.dumps(_SCALAR_ANSWERS),
    ))
    assert classify_result["status"] == "resolved"
    assert classify_result["card_type"] == "scalar_slider"

    import sqlite3
    import uuid
    projects_db_path = tmp_path / "projects.db"
    conn = sqlite3.connect(str(projects_db_path))
    conn.execute("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT)")
    pid = uuid.uuid4().hex[:12]
    conn.execute("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", (pid, "p", "P"))
    conn.commit()
    conn.close()

    push_result = json.loads(mod.decision_push(
        project_id=pid, question="Pick cache TTL", choices=["Confirm", "Cancel"],
        card_type=classify_result["card_type"],
        card_type_bucket=classify_result["card_type_bucket"],
        card_type_answers_json=json.dumps(classify_result["card_type_answers"]),
    ))
    assert push_result["ok"] is True, push_result
    assert push_result["decision"]["card_type"] == "scalar_slider"


def test_incomplete_answers_lists_open_questions(tmp_path, monkeypatch):
    mod = _import_mcp_module(tmp_path, monkeypatch)
    result = json.loads(mod.decision_classify_card_type(
        bucket="scalar", answers_json=json.dumps({"is_interval_not_point": True}),
    ))
    assert result["status"] == "incomplete"
    assert set(result["open_questions"]) == set(_SCALAR_ANSWERS) - {"is_interval_not_point"}


def test_no_match_status_for_impossible_combination(tmp_path, monkeypatch):
    mod = _import_mcp_module(tmp_path, monkeypatch)
    result = json.loads(mod.decision_classify_card_type(
        bucket="discrete_choice",
        answers_json=json.dumps({
            "is_and_or_neither_logic": False,
            "is_independent_subset": False,
            "is_quantized_few_levels": False,
        }),
    ))
    assert result["status"] == "no_match"


def test_invalid_answers_json_is_reported_not_raised(tmp_path, monkeypatch):
    mod = _import_mcp_module(tmp_path, monkeypatch)
    result = json.loads(mod.decision_classify_card_type(bucket="scalar", answers_json="{not json"))
    assert result["ok"] is False
    assert "answers_json" in result["error"]
