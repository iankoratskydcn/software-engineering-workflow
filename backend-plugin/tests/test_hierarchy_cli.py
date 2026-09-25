"""CLI contracts for mindmap hierarchy node commands."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cli  # noqa: E402


class _Conn:
    def close(self):
        pass


def _parser():
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    return parser


def test_node_create_cli_forwards_arguments(monkeypatch, capsys):
    calls = []
    result = {"id": "n_1"}
    monkeypatch.setattr(cli.db, "connect", lambda: _Conn())
    monkeypatch.setattr(cli.db, "create_node", lambda conn, **kwargs: calls.append(kwargs) or result)
    args = _parser().parse_args(["node", "create", "--project", "p_1", "--parent", "none", "--level", "0", "--title", "Root", "--kanban-task", "t_1"])
    args.func(args)
    assert json.loads(capsys.readouterr().out) == {"ok": True, "node": result}
    assert calls == [{"project_id": "p_1", "parent_id": None, "level": 0, "title": "Root", "kanban_task_id": "t_1"}]


def test_node_list_tree_link_and_archive_cli_contracts(monkeypatch, capsys):
    cases = [
        (["node", "list", "--project", "p_1", "--parent", "n_0"], "list_nodes", {"nodes": []}, {"project_id": "p_1", "parent_id": "n_0"}, {"ok": True, "nodes": {"nodes": []}}),
        (["node", "tree", "--project", "p_1"], "get_subtree", {"id": "n_0", "done_count": 1, "total_count": 2}, {"project_id": "p_1"}, {"ok": True, "tree": {"id": "n_0", "done_count": 1, "total_count": 2}}),
        (["node", "link-kanban", "n_1", "t_1"], "link_node_to_kanban", {"id": "n_1"}, {"node_id": "n_1", "kanban_task_id": "t_1"}, {"ok": True, "node": {"id": "n_1"}}),
        (["node", "update", "n_1", "--kanban-task", ""], "update_node", {"id": "n_1"}, {"node_id": "n_1", "kanban_task_id": None}, {"ok": True, "node": {"id": "n_1"}}),
        (["node", "archive", "n_1"], "archive_node", {"id": "n_1"}, {"node_id": "n_1"}, {"ok": True, "node": {"id": "n_1"}}),
    ]
    for argv, func, result, expected_kwargs, expected_output in cases:
        calls = []
        monkeypatch.setattr(cli.db, "connect", lambda: _Conn())
        monkeypatch.setattr(cli.db, func, lambda conn, **kwargs: calls.append(kwargs) or result)
        args = _parser().parse_args(argv)
        args.func(args)
        assert json.loads(capsys.readouterr().out) == expected_output
        assert calls == [expected_kwargs]
