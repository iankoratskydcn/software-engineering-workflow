"""_on_pre_tool_call kanban_create: sidecar-titled tasks skip ponytail injection.

Proof obligation: a task whose title starts with "sidecar:" (hermes-agent's STEP 4
label-router marker, hermes_cli/kanban_sidecar_route.py) must come back from the hook
untouched -- its body is strict JSON the classifier's own registry validator parses,
and appending free text after it breaks json.loads(), silently falling the task
through to a full agent spawn instead of the cheap deterministic sidecar op. Every
other kanban_create title is unaffected (regression coverage).
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import __init__ as plugin  # type: ignore[import-not-found]


def _settings(enabled=True, rule="Apply ponytail (lazy senior dev): test rule.", skills=None):
    return (enabled, rule, skills or [])


def test_sidecar_titled_task_untouched_even_when_injection_enabled():
    args = {"title": "sidecar:json_field_extract", "body": '{"document": "x", "fields": ["a"]}'}
    with patch.object(plugin, "_inject_settings", return_value=_settings()):
        result = plugin._on_pre_tool_call("kanban_create", dict(args))
    assert result is None, "sidecar: titled tasks must never be modified"


def test_sidecar_prefix_with_trailing_words_also_skipped():
    args = {"title": "sidecar:git_diff_summarization extra words", "body": '{"diff": "x"}'}
    with patch.object(plugin, "_inject_settings", return_value=_settings()):
        result = plugin._on_pre_tool_call("kanban_create", dict(args))
    assert result is None


def test_non_sidecar_task_still_gets_injected():
    args = {"title": "Fix the login bug", "body": "steps to reproduce"}
    with patch.object(plugin, "_inject_settings", return_value=_settings()):
        result = plugin._on_pre_tool_call("kanban_create", dict(args))
    assert result is not None
    assert "ponytail" in result["args"]["body"].lower()


def test_sidecar_lookalike_title_not_prefixed_still_injected():
    # "residecar:" contains "sidecar:" as a substring but does not START with it --
    # must not accidentally match and skip injection.
    args = {"title": "residecar:oops", "body": "some body"}
    with patch.object(plugin, "_inject_settings", return_value=_settings()):
        result = plugin._on_pre_tool_call("kanban_create", dict(args))
    assert result is not None


def test_injection_disabled_globally_still_skips_sidecar_and_everything_else():
    args = {"title": "sidecar:json_field_extract", "body": '{"document": "x", "fields": []}'}
    with patch.object(plugin, "_inject_settings", return_value=_settings(enabled=False)):
        result = plugin._on_pre_tool_call("kanban_create", dict(args))
    assert result is None
