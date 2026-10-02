"""Decision HUD backend plugin — registers `hermes decision ...` CLI commands.

See plugin.yaml for the overall architecture. This plugin is intentionally
read/resolve-only against the shared SQLite queue; the paired MCP server
(decision_hud_mcp.py) is the sole inserter.
"""

from __future__ import annotations

import json

try:
    from . import cli as _cli
    from . import db as db
except ImportError:
    # pytest's default "prepend" collection mode imports this hyphenated
    # plugin directory's __init__.py as a bare top-level module with no
    # parent package context, breaking the relative import above. This is a
    # pytest-collection-only artifact (GAP G3) — the production plugin
    # loader (hermes_cli/plugins_loader.py::_load_directory_module) always
    # constructs a real package context (__package__ + submodule_search_locations)
    # before exec, so the `try` branch above succeeds unconditionally in
    # production and this fallback never executes there. Confirmed via
    # direct testing across 4 pytest invocation shapes (repo root, plugin
    # parent dir, inside the plugin dir, explicit tests/ path).
    import sys as _sys
    from pathlib import Path as _Path
    _plugin_dir = str(_Path(__file__).resolve().parent)
    if _plugin_dir not in _sys.path:
        _sys.path.insert(0, _plugin_dir)
    import cli as _cli  # type: ignore[import-not-found]
    import db as db  # type: ignore[import-not-found]


def register(ctx) -> None:
    ctx.register_cli_command(
        name="decision",
        help="Decision HUD queue (list/resolve/push/projects)",
        setup_fn=_cli.setup,
        description="Cross-project bounded-decision queue backing the Decision HUD desktop pane.",
    )
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)


# --- Subagent skill injection --------------------------------------------
#
# Real equivalent of the old Claude Code SubagentStart hook: force a
# standing rule (default: ponytail/YAGNI) into every delegate_task/
# kanban_create call that doesn't already carry it, via pre_tool_call's
# "modify" directive. Settings (enabled + rule text) live in this plugin's
# own hud_settings table (db.py), editable from the Decision HUD desktop
# pane's fullscreen Settings overlay ("Subagent Rules" tab) or
# `hermes decision settings-set`.

_MARKER = "ponytail"  # substring used to detect the rule is already present


def _inject_settings() -> tuple[bool, str, list[str]]:
    conn = db.connect()
    try:
        enabled = db.get_setting(conn, "subagent_inject_enabled", "1") == "1"
        rule = db.get_setting(conn, "subagent_inject_rule", _cli.INJECT_DEFAULT_RULE)
        raw_skills = db.get_setting(conn, "subagent_inject_skills", "[]")
        try:
            skills = json.loads(raw_skills or "[]")
        except (TypeError, ValueError):
            skills = []
        if not isinstance(skills, list):
            skills = []
        skills = list(dict.fromkeys(s for s in skills if isinstance(s, str) and s.strip()))
        return enabled, rule, skills
    finally:
        conn.close()


def _inject(existing: str, rule: str) -> str:
    existing = existing or ""
    if _MARKER in existing.lower():
        return existing  # caller already stated it — don't duplicate
    return f"{existing}\n\n{rule}".strip() if existing else rule


def _inject_skill_context(existing: str, skills: list[str]) -> str:
    if not skills:
        return existing or ""
    marker = "Universal subagents skill select:"
    if marker.lower() in (existing or "").lower():
        return existing or ""
    skill_text = ", ".join(skills)
    return f"{existing or ''}\n\n{marker} {skill_text}".strip()


def _on_pre_tool_call(tool_name, args, **_kwargs):
    if tool_name not in ("delegate_task", "kanban_create") or not isinstance(args, dict):
        return None
    try:
        enabled, rule, skills = _inject_settings()
    except Exception:
        return None  # settings read failure must never block dispatch
    if not enabled:
        return None

    if tool_name == "delegate_task":
        tasks = args.get("tasks")
        if isinstance(tasks, list) and tasks:
            new_tasks = []
            changed = False
            for t in tasks:
                if isinstance(t, dict):
                    new_ctx = _inject_skill_context(_inject(t.get("context", ""), rule), skills)
                    if new_ctx != (t.get("context") or ""):
                        changed = True
                    new_tasks.append({**t, "context": new_ctx})
                else:
                    new_tasks.append(t)
            return {"action": "modify", "args": {"tasks": new_tasks}} if changed else None
        if "goal" in args:
            new_ctx = _inject_skill_context(_inject(args.get("context", ""), rule), skills)
            if new_ctx != (args.get("context") or ""):
                return {"action": "modify", "args": {"context": new_ctx}}
        return None

    if tool_name == "kanban_create":
        # hermes-agent's sidecar label router (hermes_cli/kanban_sidecar_route.py,
        # STEP 4) gates purely on title == "sidecar:<op>" (or that prefix + a space)
        # plus a body that parses as strict JSON matching the operation's own
        # registry schema -- no free text allowed, by design (no guessing from
        # prose). Appending the ponytail rule after the JSON breaks json.loads()
        # for every sidecar-routed task, silently falling that task through to a
        # full agent spawn instead of the cheap deterministic op it asked for.
        # Skip injection for this one title shape; every other kanban_create is
        # unaffected.
        title = args.get("title", "")
        if isinstance(title, str) and title.startswith("sidecar:"):
            return None
        new_body = _inject(args.get("body", ""), rule)
        existing_skills = args.get("skills")
        existing_skills = existing_skills if isinstance(existing_skills, list) else []
        merged_skills = list(dict.fromkeys(
            [s for s in existing_skills if isinstance(s, str) and s.strip()] + skills
        ))
        updates = {}
        if new_body != (args.get("body") or ""):
            updates["body"] = new_body
        if merged_skills != existing_skills:
            updates["skills"] = merged_skills
        return {"action": "modify", "args": updates} if updates else None

    return None
