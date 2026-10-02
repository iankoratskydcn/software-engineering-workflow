#!/usr/bin/env python3
"""Software Engineering Workflow MCP server — the sole write/insert path into the shared
decision queue (~/.hermes/decision_hud/queue.db). Any agent (this Hermes
session, a subagent, a cron job, a different project's tooling) that hits a
genuine owner-decision blocker calls decision_push here instead of asking
inline; the desktop pane (Decision HUD plugin) surfaces it as a card.

Configure in `~/.hermes/config.yaml` (use your local checkout path; `${userHome}` is supported by Hermes):

    mcp_servers:
      software_engineering_workflow:
        command: python3
        args: ["${userHome}/GitHub/software-engineering-workflow/backend-plugin/decision_hud_mcp.py"]

Uses the stdlib `mcp` package already vendored into the Hermes venv
(mcp.server.mcpserver.MCPServer) — no extra install required.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
import uuid
from pathlib import Path

# Reuse the exact same schema/queries as the backend plugin without importing
# it as a package (this script runs standalone, spawned by the MCP client).
_PLUGIN_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_PLUGIN_DIR))
import db  # noqa: E402  (local module: decision-hud/db.py)

from mcp.server.mcpserver import MCPServer  # noqa: E402

mcp = MCPServer("software-engineering-workflow")


@mcp.tool()
def decision_push(project_id: str, question: str, choices: list[str],
                   recommended: str | None = None, urgency: str = "normal",
                   card_type: str | None = None, card_payload_json: str | None = None,
                   card_type_bucket: str | None = None,
                   card_type_answers_json: str | None = None) -> str:
    """Push a bounded owner decision into the cross-project Decision HUD queue.

    Use this INSTEAD of inline chat clarification when the decision is a genuine
    owner-policy call that can wait for the user to clear it from their queue
    (not an urgent blocking question in the current live conversation). This
    also applies whenever the decision has a natural card shape (a range, a
    split of a fixed total, a tradeoff between options, items to group/order/
    map) — prefer this push over inline clarify so it renders as the matching
    card_type instead of a plain button list; pick the bucket matching the
    shape (docs/card-type-decision-tree.md), answer its discriminants
    yourself, and call decision_classify_card_type to resolve + verify the
    card_type before pushing, rather than defaulting to no card_type.

    Args:
        project_id: id of a real project from `hermes project list` (v6: no
            longer a free-text tag — must match an existing Project row).
        question: the bounded question text (no options embedded in the prose).
        choices: 2-4 short option labels; put the recommended option first.
        recommended: one of choices, or None.
        urgency: "low" | "normal" | "high".
        card_type: optional decision-hud-cards taxonomy key (e.g. "balance_scale",
            "assemble_pieces", "quad_choice") hinting which visual card a
            card-aware renderer should use. Always leave question/choices as a
            complete, standalone plain-text fallback — this is a hint, not a
            replacement; the built-in desktop pane ignores it and just shows
            the plain text. If card_type is set, card_type_bucket and
            card_type_answers_json are now REQUIRED (GAP G2 fix, 2026-09-12):
            db.py runs the same deterministic card-type-gate discriminant
            engine against them and rejects the push unless it resolves to
            exactly the claimed card_type — a bare card_type assertion with
            no bucket/answers always raised ValueError before this fix.
        card_payload_json: optional JSON string with card-specific config
            (e.g. '{"considerations": ["Needs strict schema", ...]}' for
            balance_scale). Must be valid JSON if provided.
        card_type_bucket: the taxonomy bucket (e.g. "continuous_single",
            "categorical_constrained" -- see decision_classify_card_type's
            own docstring for the full list) that card_type belongs to.
            Required whenever card_type is set.
        card_type_answers_json: JSON string of the discriminant answers dict
            for card_type_bucket (e.g. '{"is_interval_not_point": false, ...}').
            Must resolve, together with card_type_bucket, to exactly the
            claimed card_type via the same engine card-type-gate's CLI uses.
            Required whenever card_type is set.
    """
    conn = db.connect()
    try:
        try:
            card_payload = db.parse_json_kwarg(card_payload_json, "card_payload_json")
            card_type_answers = db.parse_json_kwarg(card_type_answers_json, "card_type_answers_json")
        except ValueError as exc:
            return json.dumps({"ok": False, "error": str(exc)})
        result = db.push_decision(
            conn, project_id=project_id, question=question, choices=choices,
            recommended=recommended, urgency=urgency,
            card_type=card_type, card_payload=card_payload,
            card_type_bucket=card_type_bucket, card_type_answers=card_type_answers,
        )
        return json.dumps({"ok": True, "decision": result})
    except ValueError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    finally:
        conn.close()


@mcp.tool()
def decision_classify_card_type(bucket: str | None = None, answers_json: str | None = None) -> str:
    """Resolve card_type/card_type_bucket/card_type_answers for decision_push,
    without writing anything. A thin, read-only wrapper around
    db._card_type_verdict — the SAME engine push_decision's _verify_card_type
    enforces — so a "resolved" result is always accepted by decision_push.

    This does NOT try to guess your decision's shape from question text:
    guessing from English prose is unreliable and was deleted from this repo
    for exactly that reason (it covered 3 of 24 card types and still
    misfired on plain wording). You already know your decision's shape —
    you're the one writing the question — so you answer the discriminants
    yourself; this tool only resolves them deterministically and verifies
    the result, the part a human/regex shouldn't have to re-derive by hand.

    Call with no args (bucket omitted) to list every bucket, the card_types
    in it, and the discriminant keys it needs answered — each key's own name
    describes what it's asking (e.g. is_interval_not_point,
    needs_confidence_axis). Pick the bucket matching your decision's shape
    (see docs/card-type-decision-tree.md for the full picture), answer every
    listed key, then call again with bucket + answers_json.

    Verdict on a bucket + full answers:
      resolved   -> exactly one card_type matched; pass card_type/
                    card_type_bucket/card_type_answers straight through to
                    decision_push (plus card_payload if that card_type needs
                    one — see decision_push's own docstring).
      incomplete -> answers is missing some of the bucket's keys (listed in
                    open_questions).
      ambiguous  -> more than one card_type matched these answers (should
                    not happen while the rule table stays partitioned —
                    report it rather than guessing which one you meant).
      no_match   -> no card_type matched; push with card_type=None instead
                    (the plain choice list).

    Args:
        bucket: one of the taxonomy buckets -- a value_type x cardinality
            cut ("continuous_single", "continuous_independent",
            "continuous_constrained", "categorical_single",
            "categorical_independent", "categorical_constrained",
            "ordinal_constrained", "relational_constrained",
            "compound_single"), plus "info_only" (the one pre-gate bucket
            outside that grid -- "is anything being decided at all").
            Single/independent are structurally absent for ordinal and
            relational (both need >=2 related items by definition). Omit
            to list all buckets instead of resolving one.
        answers_json: JSON string of {discriminant_key: true/false} covering
            every key the bucket listing names. Required when bucket is set.
    """
    if not bucket:
        buckets: dict[str, dict[str, object]] = {}
        for card_type, b, reqs in db._CARD_TYPE_RULES:
            entry = buckets.setdefault(b, {"card_types": [], "discriminants": set()})
            entry["card_types"].append(card_type)
            entry["discriminants"].update(reqs.keys())
        return json.dumps({"ok": True, "buckets": {
            b: {"card_types": v["card_types"], "discriminants": sorted(v["discriminants"])}
            for b, v in buckets.items()
        }})
    try:
        answers = db.parse_json_kwarg(answers_json, "answers_json") or {}
    except ValueError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    if not isinstance(answers, dict):
        return json.dumps({"ok": False, "error": "answers_json must decode to a JSON object"})
    verdict = db._card_type_verdict(bucket, dict(answers))
    result: dict[str, object] = {"ok": True, "status": verdict["status"]}
    if verdict["status"] == "resolved":
        result["card_type"] = verdict["matches"][0][0]
        result["card_type_bucket"] = bucket
        result["card_type_answers"] = answers
    elif verdict["status"] == "incomplete":
        result["open_questions"] = verdict["open_questions"]
    elif verdict["status"] == "ambiguous":
        result["matches"] = [m[0] for m in verdict["matches"]]
    return json.dumps(result)


@mcp.tool()
def decision_list(project_id: str | None = None, limit: int = 5) -> str:
    """List pending (unresolved) decisions, optionally filtered to one project."""
    conn = db.connect()
    try:
        return json.dumps({"decisions": db.list_pending(conn, project_id=project_id, limit=limit)})
    finally:
        conn.close()


@mcp.tool()
def problem_report(project_id: str, problem: str, context: str | None = None, reporter: str | None = None) -> str:
    """Report a problem/blocker for the singleton board agent to triage into a bounded
    decision, INSTEAD OF formulating the choices yourself.

    Use this when you're stuck on an owner-policy call but don't want to pre-decide the
    options — just describe what you're blocked on and why; the board agent (an aux LLM
    call, same mechanism as `hermes kanban specify`) will read it and produce the bounded
    question + 2-4 choices + recommendation + urgency, which lands in the Decision HUD
    queue. Prefer `decision_push` instead if you already know the exact bounded choices.

    Triage runs synchronously (inline aux LLM call) before this returns.

    Args:
        project_id: id of a real project from `hermes project list` (v6: no
            longer a free-text tag — must match an existing Project row).
        problem: free-form description of what you're blocked on and why.
        context: optional free-form evidence/background (code excerpts, tradeoffs found).
        reporter: optional free-text identifying which agent/session filed this.
    """
    conn = db.connect()
    try:
        result = db.push_problem_report(conn, project_id=project_id, problem=problem, context=context, reporter=reporter)
    except ValueError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    finally:
        conn.close()
    # Triage runs out-of-process via `hermes decision triage <id>` so this MCP server
    # never has to import hermes_cli/agent internals directly (keeps it a thin, portable
    # standalone script). Failure here still leaves the raw report queryable/retriable.
    import subprocess
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "hermes_cli.main", "decision", "triage", result["id"]],
            capture_output=True, text=True, timeout=120,
        )
        triage = json.loads(proc.stdout.strip().splitlines()[-1]) if proc.stdout.strip() else {
            "ok": False, "error": (proc.stderr or "no output")[:500]}
    except Exception as exc:
        triage = {"ok": False, "error": f"triage subprocess failed: {exc}"}
    return json.dumps({"ok": True, "report": result, "triage": triage})


@mcp.tool()
def decision_check(decision_id: str) -> str:
    """Check whether a previously pushed decision has been resolved yet, and by what choice."""
    conn = db.connect()
    try:
        result = db.get_decision(conn, decision_id)
        if result is None:
            return json.dumps({"ok": False, "error": f"decision {decision_id!r} not found"})
        return json.dumps({"ok": True, "decision": result})
    finally:
        conn.close()


@mcp.tool()
def decision_defer(decision_id: str, note: str | None = None) -> str:
    """Skip a pending decision for now without resolving it.

    Use this to record "I looked at this and I'm passing over it for now" —
    distinct from decision_push (creates a new row) or resolving it (which
    permanently answers it). A deferred decision stays pending: it still
    shows up in decision_list/decision_check results, it just sorts after
    non-deferred decisions of the same urgency on the next list.

    Args:
        decision_id: id of an existing, still-unresolved decision.
        note: optional free-text reason for skipping it right now.
    """
    conn = db.connect()
    try:
        result = db.defer_decision(conn, decision_id, note=note)
        if result is None:
            return json.dumps({"ok": False, "error": f"decision {decision_id!r} not found"})
        return json.dumps({"ok": True, "decision": result})
    except ValueError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    finally:
        conn.close()


@mcp.tool()
def batch_approval_push(project_id: str, batch_id: str, task_list: list[str], urgency: str = "normal") -> str:
    """Create the Rule-1 batch approval decision for a dispatch batch.

    This is the canonical push path for batch gates. It stores a native
    batch_approval card and rejects duplicate batch IDs per project."""
    conn = db.connect()
    try:
        result = db.push_batch_approval(
            conn, project_id=project_id, batch_id=batch_id, task_list=task_list, urgency=urgency,
        )
        return json.dumps({"ok": True, "decision": result})
    except ValueError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    finally:
        conn.close()


@mcp.tool()
def batch_approval_check(project_id: str, batch_id: str) -> str:
    """Fail-closed dispatch-side Rule-1 gate. Returns approved=true only
    after the exact batch was resolved with the literal choice 'approve'."""
    conn = db.connect()
    try:
        try:
            result = db.require_batch_approval(conn, project_id=project_id, batch_id=batch_id)
        except db.BatchNotApproved as exc:
            return json.dumps({"ok": False, "approved": False, "error": str(exc)})
        return json.dumps({"ok": True, "approved": True, "decision": result})
    finally:
        conn.close()


@mcp.tool()
def push_missing_constraint(project_id: str, task_id: str, question: str, urgency: str = "normal") -> str:
    """Create the Rule-4 missing_constraint decision (PO-escalation-on-2nd-
    failure): push this when an agent has failed twice on the same task for
    lack of a constraint/spec answer, instead of guessing or looping.

    This is the canonical push path for that gate. It stores a native
    missing_constraint card on the same decisions table as batch_approval
    (no new table — see db.py's v5 migration) and rejects a duplicate push
    for a task_id that already has an unresolved missing_constraint row."""
    conn = db.connect()
    try:
        result = db.push_missing_constraint(
            conn, project_id=project_id, task_id=task_id, question=question, urgency=urgency,
        )
        return json.dumps({"ok": True, "decision": result})
    except ValueError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    finally:
        conn.close()


@mcp.tool()
def check_constraint_resolved(project_id: str, task_id: str) -> str:
    """Fail-closed gate mirroring batch_approval_check's exact pattern.
    Returns resolved=true only once a missing_constraint decision for this
    exact (project_id, task_id) has been resolved by the PO (any resolved
    choice counts; see the resolved decision's resolved_choice for which)."""
    conn = db.connect()
    try:
        try:
            result = db.require_constraint_resolved(conn, project_id=project_id, task_id=task_id)
        except db.ConstraintNotResolved as exc:
            return json.dumps({"ok": False, "resolved": False, "error": str(exc)})
        return json.dumps({"ok": True, "resolved": True, "decision": result})
    finally:
        conn.close()


@mcp.tool()
def mark_necessity(decision_id: str, was_necessary: bool, note: str | None = None) -> str:
    """Retro: mark whether an already-resolved (non-batch_approval) escalation
    should have been resolved without reaching the human owner.

    Mirrors `hermes decision mark-necessity`. Use this after the owner has
    reviewed a resolved decision in retro and judged, in hindsight, whether
    escalating it to them was actually necessary — feeds
    `necessity_rate`'s MVP metric. Raises no exception to the caller; a
    not-found id or an attempt to mark an unresolved decision comes back as
    ok=false with an error string.

    Args:
        decision_id: id of an already-resolved decision (not a batch_approval).
        was_necessary: True if escalating to the owner was actually warranted;
            False if it judged in retro that this should not have reached them.
        note: optional free-text justification for the call.
    """
    conn = db.connect()
    try:
        result = db.mark_escalation_necessity(conn, decision_id, was_necessary=was_necessary, note=note)
        if result is None:
            return json.dumps({"ok": False, "error": f"decision {decision_id!r} not found"})
        return json.dumps({"ok": True, "decision": result})
    except ValueError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    finally:
        conn.close()


@mcp.tool()
def necessity_rate(project_id: str | None = None) -> str:
    """Escalation-necessity rate (MVP metric): the fraction of retro-marked
    escalations judged, in hindsight, to have been unnecessary.

    Mirrors `hermes decision necessity-rate`. Only counts decisions that
    actually received a retro mark via `mark_necessity` — unmarked resolved
    decisions are excluded, not assumed necessary or unnecessary. Returns
    marked_count, unnecessary_count, and escalation_necessity_rate (None
    when marked_count is 0).

    Args:
        project_id: optional project id to scope the rate to; omit for all
            projects combined.
    """
    conn = db.connect()
    try:
        return json.dumps(db.escalation_necessity_rate(conn, project_id=project_id))
    finally:
        conn.close()


if __name__ == "__main__":
    mcp.run()
