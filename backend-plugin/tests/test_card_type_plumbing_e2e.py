"""GAP G2 regression tests — end-to-end through the ACTUAL two sanctioned
callers (decision_hud_mcp.decision_push and cli.py's push subcommand), not
just db.push_decision() directly.

Why this file exists: the pre-existing test_card_type_enforcement.py tests
db.py in isolation and would pass even with the G2 bug present, because the
bug was entirely upstream of db.py — decision_hud_mcp.py::decision_push and
cli.py's push verb accepted card_type but never forwarded
card_type_bucket/card_type_answers to db.push_decision(), so every real
card_type push through either sanctioned interface hard-failed with
ValueError. These tests exercise the actual regression site.

Isolated from the live queue.db entirely: every test uses tmp_path.
"""
from __future__ import annotations

import json
import subprocess
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


def _mkproject(tmp_path) -> str:
    import sqlite3
    import uuid
    p = tmp_path / "projects.db"
    conn = sqlite3.connect(str(p))
    conn.execute(
        "CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, "
        "name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"
    )
    pid = uuid.uuid4().hex[:12]
    conn.execute("INSERT INTO projects (id, slug, name, created_at) VALUES (?, ?, ?, 0)", (pid, "p", "P"))
    conn.commit()
    conn.close()
    return pid


# ---------------------------------------------------------------------------
# Surface 1: decision_hud_mcp.py's decision_push (imported directly, no
# subprocess needed — it's a plain function once the `mcp` package is on
# the path; import the module and call the underlying function object).
# ---------------------------------------------------------------------------

def _import_mcp_module(tmp_path, monkeypatch):
    """decision_hud_mcp.py does `import db` unqualified (standalone script
    convention) and constructs an MCPServer at import time — reuse the
    already-imported db module (already sys.path-patched above) and stub
    out the mcp server dependency so we can import decision_hud_mcp.py's
    plain functions without the real MCP runtime."""
    import types
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

    import importlib
    # decision_hud_mcp imports `db` unqualified; make sure the already-patched
    # module object (not a second copy) is what it binds to.
    monkeypatch.setitem(sys.modules, "db", db)
    spec = importlib.util.spec_from_file_location(
        "decision_hud_mcp_under_test", _PLUGIN_DIR / "decision_hud_mcp.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_mcp_decision_push_forwards_card_type_bucket_and_answers(tmp_path, monkeypatch):
    """RED before the fix: this call hard-failed with ValueError because
    decision_push() never forwarded card_type_bucket/card_type_answers_json
    to db.push_decision(). GREEN after: succeeds end-to-end."""
    mod = _import_mcp_module(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    raw = mod.decision_push(
        project_id=pid, question="Pick cache TTL", choices=["Confirm", "Cancel"],
        card_type="scalar_slider",
        card_type_bucket="scalar",
        card_type_answers_json=json.dumps(_SCALAR_ANSWERS),
    )
    result = json.loads(raw)
    assert result["ok"] is True, result
    assert result["decision"]["card_type"] == "scalar_slider"


def test_mcp_decision_push_still_rejects_mismatched_card_type(tmp_path, monkeypatch):
    """The fix forwards the params — it must not also loosen enforcement:
    a claimed card_type that doesn't match the engine's verdict is still
    rejected end-to-end through the MCP surface."""
    mod = _import_mcp_module(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    raw = mod.decision_push(
        project_id=pid, question="Pick cache TTL", choices=["Confirm", "Cancel"],
        card_type="quad_choice",  # answers actually resolve to scalar_slider
        card_type_bucket="scalar",
        card_type_answers_json=json.dumps(_SCALAR_ANSWERS),
    )
    result = json.loads(raw)
    assert result["ok"] is False
    assert "quad_choice" in result["error"] and "scalar_slider" in result["error"]


def test_mcp_decision_push_rejects_invalid_answers_json(tmp_path, monkeypatch):
    mod = _import_mcp_module(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    raw = mod.decision_push(
        project_id=pid, question="q?", choices=["a", "b"],
        card_type="scalar_slider", card_type_bucket="scalar",
        card_type_answers_json="{not valid json",
    )
    result = json.loads(raw)
    assert result["ok"] is False
    assert "card_type_answers_json" in result["error"]


def test_mcp_decision_push_without_card_type_unaffected(tmp_path, monkeypatch):
    """The new params must be fully optional — plain pushes are unaffected."""
    mod = _import_mcp_module(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    raw = mod.decision_push(project_id=pid, question="q?", choices=["a", "b"])
    result = json.loads(raw)
    assert result["ok"] is True
    assert result["decision"]["card_type"] is None


# ---------------------------------------------------------------------------
# Surface 2: cli.py's `push` subcommand, invoked via its real argument-parsing
# entrypoint (setup() -> parser -> func(args)), not just db.push_decision().
# ---------------------------------------------------------------------------

def _run_cli_push(tmp_path, monkeypatch, extra_args):
    import argparse
    import io
    import contextlib

    try:
        from . import cli as cli_module  # type: ignore
    except ImportError:
        sys.path.insert(0, str(_PLUGIN_DIR))
        import cli as cli_module  # type: ignore

    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(cli_module.db, "_hermes_home", lambda: tmp_path)

    parser = argparse.ArgumentParser()
    cli_module.setup(parser)
    pid = _mkproject(tmp_path)
    argv = ["push", "--project-id", pid, "--question", "Pick cache TTL",
            "--choice", "Confirm", "--choice", "Cancel"] + extra_args
    args = parser.parse_args(argv)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        try:
            args.func(args)
        except SystemExit:
            pass
    return json.loads(buf.getvalue().strip().splitlines()[-1])


def test_cli_push_forwards_card_type_bucket_and_answers(tmp_path, monkeypatch):
    """RED before the fix: --card-type with no forwarding path for
    --card-type-bucket/--card-type-answers hard-failed. GREEN after."""
    result = _run_cli_push(tmp_path, monkeypatch, [
        "--card-type", "scalar_slider",
        "--card-type-bucket", "scalar",
        "--card-type-answers", json.dumps(_SCALAR_ANSWERS),
    ])
    assert result["ok"] is True, result
    assert result["decision"]["card_type"] == "scalar_slider"


def test_cli_push_still_rejects_mismatched_card_type(tmp_path, monkeypatch):
    result = _run_cli_push(tmp_path, monkeypatch, [
        "--card-type", "quad_choice",
        "--card-type-bucket", "scalar",
        "--card-type-answers", json.dumps(_SCALAR_ANSWERS),
    ])
    assert result["ok"] is False
    message = result["error"]["message"]
    assert "quad_choice" in message and "scalar_slider" in message

def test_cli_push_rejects_invalid_answers_json(tmp_path, monkeypatch):
    result = _run_cli_push(tmp_path, monkeypatch, [
        "--card-type", "scalar_slider",
        "--card-type-bucket", "scalar",
        "--card-type-answers", "{not valid json",
    ])
    assert result["ok"] is False
    assert "--card-type-answers" in result["error"]["message"]
