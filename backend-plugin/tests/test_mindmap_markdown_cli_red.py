"""RED contracts for the MindMap Markdown CLI projection seam."""
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


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    return parser


def test_export_markdown_cli_emits_one_json_line_and_delegates(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(cli.db, "connect", lambda: _Conn())
    monkeypatch.setattr(
        cli.db,
        "export_mindmap_markdown",
        lambda conn, **kwargs: calls.append((conn, kwargs)) or "# exported mindmap\n",
    )

    args = _parser().parse_args(
        [
            "mindmap",
            "export-markdown",
            "--project-id",
            "p_1",
            "--map-id",
            "map_1",
        ]
    )
    args.func(args)

    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0]) == {"ok": True, "markdown": "# exported mindmap\n"}
    assert calls[0][1] == {"project_id": "p_1", "map_id": "map_1"}


def test_import_markdown_cli_emits_one_json_line_and_delegates(
    tmp_path, monkeypatch, capsys
):
    markdown_path = tmp_path / "release-plan.md"
    markdown_path.write_text("# imported mindmap\n", encoding="utf-8")
    calls = []
    result = {"map_id": "map_1", "node_ids": ["node_1"]}
    monkeypatch.setattr(cli.db, "connect", lambda: _Conn())
    monkeypatch.setattr(
        cli.db,
        "import_mindmap_markdown",
        lambda conn, **kwargs: calls.append((conn, kwargs)) or result,
    )

    args = _parser().parse_args(
        [
            "mindmap",
            "import-markdown",
            "--project-id",
            "p_1",
            "--map-id",
            "map_1",
            "--file",
            str(markdown_path),
        ]
    )
    args.func(args)

    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0]) == {"ok": True, "result": result}
    assert calls[0][1] == {
        "project_id": "p_1",
        "map_id": "map_1",
        "markdown": "# imported mindmap\n",
    }
