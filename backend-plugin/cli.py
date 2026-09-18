"""Decision HUD — `hermes decision ...` CLI subcommands.

Thin argparse wrappers over db.py, output as JSON so the desktop plugin can
parse it via cli.exec({argv: [...]}). Human-readable text is used only for
bare interactive invocation (no --json).
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
from pathlib import Path
from typing import Optional

try:
    from . import db
except ImportError:
    # See __init__.py's matching try/except for the full explanation
    # (GAP G3 — pytest-collection-only artifact, production loader unaffected).
    import sys as _sys
    from pathlib import Path as _Path
    _plugin_dir = str(_Path(__file__).resolve().parent)
    if _plugin_dir not in _sys.path:
        _sys.path.insert(0, _plugin_dir)
    import db  # type: ignore[import-not-found]

_TRIAGE_SYSTEM_PROMPT = (
    "You triage raw problem reports into a bounded owner decision for a human "
    "who juggles several software projects. Given a project tag, a free-form "
    "problem description, and optional context, respond with STRICT JSON only "
    "(no prose, no code fence):\n"
    '{"question": "<one bounded sentence, no options embedded in the prose>", '
    '"choices": ["<option 1>", "<option 2>", ...(2-4 total)], '
    '"recommended": "<one of choices, or null>", '
    '"urgency": "low"|"normal"|"high"}\n'
    "Put the recommended option FIRST in choices. Urgency reflects how much the "
    "reporter is blocked, not general importance. If the report doesn't actually "
    "need a human policy call (it's answerable from evidence alone), still "
    "produce the best 2-4 reasonable choices — never refuse to triage.")


def _triage_user_prompt(report: dict) -> str:
    try:
        proj = db._resolve_project(report["project_id"])
        project_label = proj["slug"]
    except Exception:
        project_label = report["project_id"]
    return (
        f"Project: {project_label}\n\n"
        f"Problem:\n{report['problem']}\n\n"
        f"Context:\n{report.get('context') or '(none)'}")


def _print(obj) -> None:
    print(json.dumps(obj, default=str))


def setup(p) -> None:
    """setup_fn passed to register_cli_command: receives the ALREADY-CREATED
    `decision` parser (main.py: `plugin_parser = subparsers.add_parser(name, ...)`
    then `setup_fn(plugin_parser)`) — not the top-level subparsers object."""
    verbs = p.add_subparsers(dest="verb", required=True)

    v = verbs.add_parser("list", help="List pending decisions")
    v.add_argument("--project-id", default=None, dest="project_id")
    v.add_argument("--limit", type=int, default=5)
    v.set_defaults(func=_cmd_list)

    v = verbs.add_parser("resolve", help="Resolve a decision by id (requires --actor-token; see 'decision issue-token')")
    v.add_argument("id")
    v.add_argument("choice")
    v.add_argument("--payload", default=None,
                    help="Optional JSON string with structured card result "
                         "(e.g. from a decision-hud-cards card confirm), "
                         "stored alongside the required plain-text choice")
    v.add_argument("--actor-token", required=True, dest="actor_token",
                    help="Capability token from 'hermes decision issue-token' (interactive-only "
                         "resolution path; F2). Required on every resolve — no default, no env "
                         "fallback, so a script can't quietly bypass authorization.")
    v.set_defaults(func=_cmd_resolve)

    v = verbs.add_parser("issue-token", help="Mint a per-session actor token for the interactive resolve path")
    v.add_argument("--actor", required=True, help="Identity to record on rows this token resolves, e.g. your name")
    v.add_argument("--ttl-seconds", type=int, default=None, dest="ttl_seconds")
    v.add_argument("--project-id", default=None, dest="project_id",
                    help="Optional: also stamp a project claim on the minted token via the "
                         "decision-hud desktop plugin's agent-dashboard backend "
                         "(issue_project_actor_token), so the SAME token is usable both to "
                         "resolve decisions here and to read Agent Dashboard telemetry scoped "
                         "to this project. Without this flag the token is unscoped, as before.")
    v.set_defaults(func=_cmd_issue_token)

    v = verbs.add_parser("projects", help="List projects with pending counts")
    v.set_defaults(func=_cmd_projects)

    v = verbs.add_parser("push", help="Push a new decision (mainly for local testing; agents use the MCP tool)")
    v.add_argument("--project-id", required=True, dest="project_id")
    v.add_argument("--question", required=True)
    v.add_argument("--choice", action="append", dest="choices", required=True)
    v.add_argument("--recommended", default=None)
    v.add_argument("--urgency", default="normal", choices=["low", "normal", "high"])
    v.add_argument("--card-type", default=None, dest="card_type",
                    help="Optional decision-hud-cards taxonomy key, e.g. balance_scale")
    v.add_argument("--card-payload", default=None, dest="card_payload",
                    help="Optional JSON string with card-specific config")
    v.add_argument("--card-type-bucket", default=None, dest="card_type_bucket",
                    help="card-type-gate taxonomy bucket for --card-type, e.g. scalar. "
                         "Required whenever --card-type is given (GAP G2 fix).")
    v.add_argument("--card-type-answers", default=None, dest="card_type_answers",
                    help="JSON string of discriminant answers for --card-type-bucket. "
                         "Required whenever --card-type is given (GAP G2 fix).")
    v.set_defaults(func=_cmd_push)

    v = verbs.add_parser("report", help="File a raw problem report for board-agent triage")
    v.add_argument("--project-id", required=True, dest="project_id")
    v.add_argument("--problem", required=True)
    v.add_argument("--context", default=None)
    v.add_argument("--reporter", default=None)
    v.set_defaults(func=_cmd_report)

    v = verbs.add_parser("reports", help="List pending (untriaged) problem reports")
    v.add_argument("--limit", type=int, default=20)
    v.set_defaults(func=_cmd_reports)

    v = verbs.add_parser("triage", help="Triage one pending report into a decision card (board-agent tool)")
    v.add_argument("id")
    v.set_defaults(func=_cmd_triage)

    v = verbs.add_parser("triage-blocked", help="Group blocked Kanban work into idempotent Decision HUD cards")
    v.add_argument("--project-id", required=True, dest="project_id")
    v.add_argument("--board", required=True)
    v.add_argument("--diagnostics", required=True, help="JSON from kanban diagnostics")
    v.add_argument("--blocked", required=True, help="JSON from kanban list --status blocked")
    v.add_argument("--graph", default="{}", help="JSON map of task id to graph details")
    v.set_defaults(func=_cmd_triage_blocked)

    v = verbs.add_parser("push-batch", help="Push a Rule-1 batch_approval decision")
    v.add_argument("--project-id", required=True, dest="project_id")
    v.add_argument("--batch-id", required=True, dest="batch_id")
    v.add_argument("--task", action="append", dest="task_list", required=True,
                    help="Repeatable: one task description per --task")
    v.add_argument("--urgency", default="normal", choices=["low", "normal", "high"])
    v.set_defaults(func=_cmd_push_batch)

    v = verbs.add_parser("check-batch", help="Rule-1 dispatch gate: exits nonzero unless the batch is resolved 'approve'")
    v.add_argument("--project-id", required=True, dest="project_id")
    v.add_argument("--batch-id", required=True, dest="batch_id")
    v.set_defaults(func=_cmd_check_batch)

    v = verbs.add_parser("mark-necessity", help="Retro: mark whether a resolved (non-batch) escalation was necessary")
    v.add_argument("id")
    v.add_argument("--necessary", choices=["yes", "no"], required=True)
    v.add_argument("--note", default=None)
    v.set_defaults(func=_cmd_mark_necessity)

    v = verbs.add_parser("defer", help="Skip a pending decision for now without resolving it")
    v.add_argument("id")
    v.add_argument("--note", default=None)
    v.set_defaults(func=_cmd_defer)

    v = verbs.add_parser("necessity-rate", help="Escalation-necessity rate (MVP metric)")
    v.add_argument("--project-id", default=None, dest="project_id")
    v.set_defaults(func=_cmd_necessity_rate)

    v = verbs.add_parser("settings-get", help="Read HUD settings (subagent skill injection, etc.)")
    v.set_defaults(func=_cmd_settings_get)

    v = verbs.add_parser("settings-set", help="Write one HUD setting key=value")
    v.add_argument("key")
    v.add_argument("value")
    v.set_defaults(func=_cmd_settings_set)

    v = verbs.add_parser("agent-metrics-snapshot", help="Emit the agent_metrics_snapshot.py JSON (heatmap/scatter/treemap/radar/sankey widgets)")
    v.set_defaults(func=_cmd_agent_metrics_snapshot)

    p.set_defaults(func=lambda args: p.print_help())


def _cmd_list(args) -> None:
    conn = db.connect()
    try:
        _print({"decisions": db.list_pending(conn, project_id=args.project_id, limit=args.limit)})
    finally:
        conn.close()


def _cmd_resolve(args) -> None:
    conn = db.connect()
    try:
        try:
            payload = db.parse_json_kwarg(getattr(args, "payload", None), "--payload")
        except ValueError as exc:
            _print({"ok": False, "error": str(exc)})
            sys.exit(1)
            return
        try:
            result = db.resolve_decision(conn, args.id, args.choice, payload=payload, actor_token=args.actor_token)
        except db.NotAuthorized as exc:
            _print({"ok": False, "error": str(exc)})
            sys.exit(1)
            return
        if result is None:
            _print({"ok": False, "error": f"decision {args.id!r} not found"})
            sys.exit(1)
        _print({"ok": True, "decision": result})
    except ValueError as exc:
        _print({"ok": False, "error": str(exc)})
        sys.exit(1)
    finally:
        conn.close()


def _agent_dashboard_auth_module():
    """Import the agent-dashboard backend's `service.auth` module by file
    path. It lives in a sibling repo (the standalone decision-hud desktop
    plugin repo's `backend/`), not an installed package, so this loads it
    the same way `service/auth.py` itself reaches back INTO this plugin's
    `db.py` (see that module's docstring) — the coupling is bidirectional
    and equally fragile in both directions; consolidating it behind a
    published interface is flagged there and applies here too.

    Overridable via DECISION_HUD_BACKEND_AUTH_PATH for tests/non-default
    checkout locations. Default assumes the desktop plugin repo is checked
    out at ~/.hermes/desktop-plugins/decision-hud (this plugin's own
    ~/.hermes/plugins/decision-hud is a DIFFERENT directory — decisions
    SQLite backend vs. the telemetry backend)."""
    override = os.environ.get("DECISION_HUD_BACKEND_AUTH_PATH")
    path = Path(override) if override else (
        Path.home() / ".hermes" / "desktop-plugins" / "decision-hud" / "backend" / "agent_dashboard" / "service" / "auth.py"
    )
    if not path.exists():
        raise ImportError(
            f"agent-dashboard backend auth module not found at {path}; set "
            "DECISION_HUD_BACKEND_AUTH_PATH or check out the decision-hud desktop "
            "plugin repo's backend/. Refusing to mint an unscoped token when a "
            "project scope was explicitly requested.")
    module_name = "decision_hud_backend_auth_reused"
    if module_name in sys.modules:
        return sys.modules[module_name]
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load spec for agent-dashboard auth module at {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _cmd_issue_token(args) -> None:
    """Mint an actor token for the interactive resolve path (F2). This is
    itself interactive-command-only surface — it isn't gated by anything
    beyond running as a normal (non-delegated-child) process, since the
    token it produces is what gates the actually-sensitive operation
    (resolve). A delegated child COULD call this, but the token it gets
    would still be refused by resolve_decision()'s own delegated-child
    check, so nothing is gained by doing so.

    --project-id additionally stamps a project claim on the SAME token via
    the agent-dashboard backend's issue_project_actor_token(), so one token
    resolves decisions AND reads Agent Dashboard telemetry scoped to that
    project. project_id is caller-supplied (the desktop pane passes the
    currently-selected Kanban board slug); this module does not validate it
    against the kanban board list — an unknown slug just means later reads
    scoped to it return empty telemetry, not an auth error."""
    project_id = getattr(args, "project_id", None)
    if project_id:
        try:
            auth = _agent_dashboard_auth_module()
            token = auth.issue_project_actor_token(
                args.actor, project_id,
                ttl_seconds=getattr(args, "ttl_seconds", None))
        except (ImportError, ValueError) as exc:
            _print({"ok": False, "error": str(exc)})
            sys.exit(1)
            return
        _print({"ok": True, "actor_token": token, "project_id": project_id})
        return
    kwargs = {}
    if getattr(args, "ttl_seconds", None):
        kwargs["ttl_seconds"] = args.ttl_seconds
    try:
        token = db.issue_actor_token(args.actor, **kwargs)
    except ValueError as exc:
        _print({"ok": False, "error": str(exc)})
        sys.exit(1)
        return
    _print({"ok": True, "actor_token": token})


def _cmd_projects(args) -> None:
    conn = db.connect()
    try:
        _print({"projects": db.list_projects(conn)})
    finally:
        conn.close()


def _cmd_push(args) -> None:
    conn = db.connect()
    try:
        try:
            card_payload = db.parse_json_kwarg(getattr(args, "card_payload", None), "--card-payload")
            card_type_answers = db.parse_json_kwarg(
                getattr(args, "card_type_answers", None), "--card-type-answers")
        except ValueError as exc:
            _print({"ok": False, "error": str(exc)})
            sys.exit(1)
            return
        result = db.push_decision(
            conn, project_id=args.project_id, question=args.question, choices=args.choices,
            recommended=args.recommended, urgency=args.urgency,
            card_type=getattr(args, "card_type", None), card_payload=card_payload,
            card_type_bucket=getattr(args, "card_type_bucket", None),
            card_type_answers=card_type_answers,
        )
        _print({"ok": True, "decision": result})
    except ValueError as exc:
        _print({"ok": False, "error": str(exc)})
        sys.exit(1)
    finally:
        conn.close()


def _cmd_report(args) -> None:
    conn = db.connect()
    try:
        report = db.push_problem_report(
            conn, project_id=args.project_id, problem=args.problem, context=args.context, reporter=args.reporter,
        )
    except ValueError as exc:
        _print({"ok": False, "error": str(exc)})
        sys.exit(1)
        return
    finally:
        conn.close()
    # Trigger triage immediately (per build decision: synchronous, inline aux LLM call —
    # same shape as hermes_cli.kanban_specify). A triage failure still leaves the raw
    # report queryable via `decision reports` / marked triage_failed, never silently lost.
    outcome = _run_triage(report["id"])
    _print({"ok": True, "report": report, "triage": outcome})


def _cmd_reports(args) -> None:
    conn = db.connect()
    try:
        _print({"reports": db.list_pending_reports(conn, limit=args.limit)})
    finally:
        conn.close()


def _cmd_triage(args) -> None:
    outcome = _run_triage(args.id)
    _print(outcome)
    if not outcome.get("ok"):
        sys.exit(1)


def _triage_json(raw: str, name: str):
    try:
        return json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise ValueError(f"--{name} is not valid JSON: {exc}") from exc


def _rows(value, keys):
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in keys:
            if isinstance(value.get(key), list):
                return value[key]
    return []


def _task_id(row):
    return str(row.get("id") or row.get("task_id") or "").strip()


def _root_id(task_id, graph, blocked_ids):
    """Follow blocked-task parents to one root, with cycle protection."""
    seen = set()
    current = task_id
    while current not in seen:
        seen.add(current)
        parents = graph.get(current, {}).get("parents", [])
        parents = [str(parent) for parent in parents if str(parent) in blocked_ids]
        if not parents:
            return current
        current = parents[0]
    return current


def _diag_kind(row):
    return str(row.get("kind") or row.get("code") or row.get("type") or "").lower()


def _cmd_triage_blocked(args) -> None:
    try:
        diagnostics = _rows(_triage_json(args.diagnostics, "diagnostics"), ("diagnostics", "items", "rows"))
        blocked = _rows(_triage_json(args.blocked, "blocked"), ("tasks", "blocked", "items", "rows"))
        graph = _triage_json(args.graph, "graph")
        if not isinstance(graph, dict):
            raise ValueError("--graph must be a JSON object")
        if not args.board.strip():
            raise ValueError("--board is required")
        blocked_ids = {_task_id(task) for task in blocked if isinstance(task, dict)}
        by_task = {}
        for row in diagnostics:
            if isinstance(row, dict):
                by_task.setdefault(_task_id(row), []).extend(row.get("diagnostics") or [row])
        groups = {}
        dependency_only = 0
        dependency_kinds = {"dependency", "dependency_wait", "dependency-only", "waiting_on_dependency"}
        for task in blocked:
            if not isinstance(task, dict):
                continue
            tid = _task_id(task)
            if not tid:
                continue
            parents = graph.get(tid, {}).get("parents", [])
            has_blocked_parent = any(str(parent) in blocked_ids for parent in parents)
            actionable = [d for d in by_task.get(tid, []) if isinstance(d, dict) and _diag_kind(d) not in dependency_kinds]
            # A blocked task with no blocked parent is a root blocker even when
            # the diagnostics engine has no typed signal for it yet. Those are
            # exactly the cases the auxiliary triage pass must inspect.
            if not actionable and has_blocked_parent:
                dependency_only += 1
                continue
            if not actionable:
                actionable = [{"kind": "unclassified_blocked", "detail": "blocked root requires triage"}]
            root = _root_id(tid, graph, blocked_ids)
            group = groups.setdefault(root, {"task_ids": [], "titles": [], "evidence": []})
            group["task_ids"].append(tid)
            if task.get("title"):
                group["titles"].append(str(task["title"]))
            group["evidence"].extend({"task_id": tid, "kind": _diag_kind(d), "message": str(d.get("message") or d.get("detail") or d.get("reason") or "")[:300]} for d in actionable)

        conn = db.connect()
        created = []
        try:
            pending = db.list_pending(conn, project_id=args.project_id, limit=10000)
            for root, group in groups.items():
                payload = {"_kanban_task_ids": sorted(set(group["task_ids"])), "_kanban_board": args.board, "_kanban_root_task_id": root, "_triage_kind": "kanban_blocked", "evidence": group["evidence"][:20]}
                existing = next((d for d in pending if d.get("card_payload") == payload), None)
                if existing:
                    created.append(existing)
                    continue
                question = f"Investigate unresolved blocker for Kanban task group {root} ({', '.join(group['titles'][:3]) or 'untitled'})"
                decision = None
                # Reuse the existing auxiliary triage path when installed. Its
                # output is still constrained to the same two explicit choices;
                # if the auxiliary client is unavailable, stay deterministic.
                try:
                    from agent.auxiliary_client import call_llm  # noqa: F401
                    report = db.push_problem_report(
                        conn, project_id=args.project_id,
                        problem=question,
                        context=json.dumps(payload, sort_keys=True),
                        reporter="decision-hud-kanban-triage",
                    )
                    outcome = _run_triage(report["id"])
                    if outcome.get("ok") and outcome.get("decision"):
                        decision = outcome["decision"]
                        conn.execute(
                            "UPDATE decisions SET question = ?, choices_json = ?, recommended = ?, card_payload_json = ? WHERE id = ?",
                            (question, json.dumps(["Investigate/resolve manually", "Leave blocked for now"]), "Investigate/resolve manually", json.dumps(payload), decision["id"]),
                        )
                        conn.commit()
                        decision.update({"question": question, "choices": ["Investigate/resolve manually", "Leave blocked for now"], "recommended": "Investigate/resolve manually", "card_payload": payload})
                except Exception:
                    decision = None
                if decision is None:
                    decision = db.push_decision(
                        conn, project_id=args.project_id, question=question,
                        choices=["Investigate/resolve manually", "Leave blocked for now"],
                        recommended="Investigate/resolve manually", urgency="normal", card_payload=payload,
                    )
                created.append(decision)
        finally:
            conn.close()
        _print({"ok": True, "decisions": created, "summary": {"created": len(created), "actionable_groups": len(groups), "dependency_only": dependency_only}})
    except ValueError as exc:
        _print({"ok": False, "error": str(exc)})
        sys.exit(1)


def _run_triage(report_id: str) -> dict:
    """Turn one pending problem_report into a decision card via the auxiliary LLM
    (same call_llm plumbing as hermes_cli.kanban_specify, under auxiliary.triage_specifier
    config — provider/model/base_url/extra_body/reasoning_effort all apply)."""
    conn = db.connect()
    try:
        report = db.get_problem_report(conn, report_id)
        if report is None:
            return {"ok": False, "error": f"report {report_id!r} not found"}
        if report["status"] != "pending":
            return {"ok": False, "error": f"report {report_id!r} already {report['status']}"}
        try:
            from agent.auxiliary_client import call_llm
        except Exception as exc:
            db.mark_report_failed(conn, report_id, f"auxiliary client unavailable: {exc}")
            return {"ok": False, "error": "auxiliary client unavailable"}
        try:
            resp = call_llm(
                task="triage_specifier",
                messages=[
                    {"role": "system", "content": _TRIAGE_SYSTEM_PROMPT},
                    {"role": "user", "content": _triage_user_prompt(report)},
                ],
                temperature=0.2, max_tokens=500, timeout=90,
            )
            raw = (resp.choices[0].message.content or "").strip()
        except Exception as exc:
            db.mark_report_failed(conn, report_id, f"LLM error: {type(exc).__name__}: {exc}")
            return {"ok": False, "error": f"LLM error: {exc}"}
        parsed = _parse_triage_json(raw)
        if parsed is None:
            db.mark_report_failed(conn, report_id, f"could not parse triage output: {raw[:500]!r}")
            return {"ok": False, "error": "could not parse triage output from model"}
        try:
            decision = db.push_decision(
                conn, project_id=report["project_id"], question=parsed["question"], choices=parsed["choices"],
                recommended=parsed.get("recommended"), urgency=parsed.get("urgency", "normal"),
            )
        except ValueError as exc:
            db.mark_report_failed(conn, report_id, f"triage produced an invalid decision: {exc}")
            return {"ok": False, "error": f"triage produced an invalid decision: {exc}"}
        db.mark_report_triaged(conn, report_id, decision["id"])
        return {"ok": True, "decision": decision}
    finally:
        conn.close()


def _parse_triage_json(raw: str) -> Optional[dict]:
    try:
        m = None if raw.lstrip().startswith("{") else re.search(r"\{.*\}", raw, re.DOTALL)
        obj = json.loads(m.group(0) if m else raw)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    question = str(obj.get("question") or "").strip()
    choices = [c for c in (obj.get("choices") or []) if isinstance(c, str) and c.strip()]
    if not question or not (2 <= len(choices) <= 4):
        return None
    recommended = obj.get("recommended")
    recommended = recommended if recommended in choices else None
    urgency = str(obj.get("urgency") or "normal").strip().lower()
    urgency = urgency if urgency in ("low", "normal", "high") else "normal"
    return {"question": question, "choices": choices, "recommended": recommended, "urgency": urgency}


def _cmd_push_batch(args) -> None:
    conn = db.connect()
    try:
        result = db.push_batch_approval(
            conn, project_id=args.project_id, batch_id=args.batch_id,
            task_list=args.task_list, urgency=args.urgency,
        )
        _print({"ok": True, "decision": result})
    except ValueError as exc:
        _print({"ok": False, "error": str(exc)})
        sys.exit(1)
    finally:
        conn.close()


def _cmd_check_batch(args) -> None:
    """Dispatch-side gate CLI: exits 0 + prints the approved row only when
    resolved_choice == 'approve'; exits 1 for pending/rejected/missing.
    Intended to be called (and its exit code checked) immediately before any
    batch dispatch — the enforcement point, not just an informational list."""
    conn = db.connect()
    try:
        row = db.require_batch_approval(conn, project_id=args.project_id, batch_id=args.batch_id)
        _print({"ok": True, "approved": True, "decision": row})
    except db.BatchNotApproved as exc:
        _print({"ok": False, "approved": False, "error": str(exc)})
        sys.exit(1)
    finally:
        conn.close()


def _cmd_mark_necessity(args) -> None:
    conn = db.connect()
    try:
        result = db.mark_escalation_necessity(
            conn, args.id, was_necessary=(args.necessary == "yes"), note=args.note,
        )
        if result is None:
            _print({"ok": False, "error": f"decision {args.id!r} not found"})
            sys.exit(1)
        _print({"ok": True, "decision": result})
    except ValueError as exc:
        _print({"ok": False, "error": str(exc)})
        sys.exit(1)
    finally:
        conn.close()


def _cmd_necessity_rate(args) -> None:
    conn = db.connect()
    try:
        _print(db.escalation_necessity_rate(conn, project_id=args.project_id))
    finally:
        conn.close()


def _cmd_defer(args) -> None:
    conn = db.connect()
    try:
        result = db.defer_decision(conn, args.id, note=args.note)
        if result is None:
            _print({"ok": False, "error": f"decision {args.id!r} not found"})
            sys.exit(1)
        _print({"ok": True, "decision": result})
    except ValueError as exc:
        _print({"ok": False, "error": str(exc)})
        sys.exit(1)
    finally:
        conn.close()


# --- HUD settings: subagent skill injection ------------------------------
#
# Backs the fullscreen Settings overlay's "Subagent Rules" tab. Keys are
# looked up here AND directly by subagent_injection.py at pre_tool_call
# time (same db.py connect/get_setting path) — this file only exposes them
# to the CLI/desktop bridge, it is not the source of truth for the hook.

INJECT_DEFAULT_RULE = (
    "Apply ponytail (lazy senior dev / YAGNI): simplest working solution. "
    "Ladder, stop at first rung that holds: (1) does this need to exist? "
    "(2) reuse what's already in this codebase (3) stdlib (4) native "
    "platform feature (5) already-installed dependency (6) one line "
    "(7) only then, minimum new code. Never simplify away validation, "
    "error handling, security, or anything explicitly requested."
)
_SETTINGS_KEYS = {
    "subagent_inject_enabled": "1",
    "subagent_inject_rule": INJECT_DEFAULT_RULE,
    "subagent_inject_skills": "[]",
    # Which kanban_block()/kanban_request_review() calls should auto-push a
    # Decision HUD card: 'off' (never), 'needs_input' (only reason kind
    # needs_input, i.e. genuine owner decisions — capability/transient/
    # dependency blocks are status, not decisions, so they're excluded even
    # at 'all'), or 'all' (needs_input + review requests). Owner-changeable
    # from the pane, not hardcoded, since scope needs differ by how much
    # blocked/review traffic a board is generating.
    "kanban_escalation_bridge_scope": "needs_input",
    # Profiles the kanban_profile_hooks_sync.py cron script must NEVER patch
    # hooks into (JSON array of profile names). Owner-editable from the pane
    # so an intentionally-hookless profile (e.g. one that must never trigger
    # escalation, or a throwaway test profile) doesn't get its config.yaml
    # rewritten on the next 30-minute tick.
    "kanban_profile_hooks_exempt": "[]",
    "agent_health_bars": json.dumps([
        {"metric": "done", "enabled": True},
        {"metric": "todo", "enabled": True},
        {"metric": "blocked", "enabled": True},
    ]),
}


def _cmd_settings_get(args) -> None:
    conn = db.connect()
    try:
        out = {k: db.get_setting(conn, k, default) for k, default in _SETTINGS_KEYS.items()}
        _print({"ok": True, "settings": out})
    finally:
        conn.close()


def _cmd_settings_set(args) -> None:
    if args.key not in _SETTINGS_KEYS:
        _print({"ok": False, "error": f"unknown setting key {args.key!r}, expected one of {sorted(_SETTINGS_KEYS)}"})
        sys.exit(1)
        return
    conn = db.connect()
    try:
        db.set_setting(conn, args.key, args.value)
        _print({"ok": True, "key": args.key, "value": args.value})
    finally:
        conn.close()


def _agent_metrics_snapshot_script_path() -> Path:
    """Locate backend/scripts/agent_metrics_snapshot.py — same sibling-repo
    coupling pattern as _agent_dashboard_auth_module() above (the desktop
    plugin repo's backend/ is not an installed package). Overridable via
    DECISION_HUD_AGENT_METRICS_SCRIPT_PATH for tests/non-default checkouts."""
    override = os.environ.get("DECISION_HUD_AGENT_METRICS_SCRIPT_PATH")
    if override:
        return Path(override)
    return (
        Path.home() / ".hermes" / "desktop-plugins" / "decision-hud" / "backend"
        / "scripts" / "agent_metrics_snapshot.py"
    )


def _cmd_agent_metrics_snapshot(args) -> None:
    """Run agent_metrics_snapshot.py as a subprocess and re-emit its JSON
    verbatim on stdout — same "thin CLI wrapper, real work lives in a
    read-only script/module" shape as every other verb in this file. Never
    fabricates a snapshot: a missing script or a failing subprocess is
    reported as an explicit error, not swallowed into an empty result."""
    import subprocess

    path = _agent_metrics_snapshot_script_path()
    if not path.exists():
        _print({"ok": False, "error": f"agent_metrics_snapshot.py not found at {path}"})
        sys.exit(1)
        return
    try:
        result = subprocess.run(
            [sys.executable, str(path)], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        _print({"ok": False, "error": f"agent_metrics_snapshot.py failed to run: {exc}"})
        sys.exit(1)
        return
    if result.returncode != 0:
        _print({"ok": False, "error": f"agent_metrics_snapshot.py exited {result.returncode}: {result.stderr.strip()}"})
        sys.exit(1)
        return
    try:
        snapshot = json.loads(result.stdout)
    except ValueError as exc:
        _print({"ok": False, "error": f"agent_metrics_snapshot.py produced invalid JSON: {exc}"})
        sys.exit(1)
        return
    _print(snapshot)
