"""`hermes decision observer ...`: deterministic standup reports.

The Observer is read-only. Its single write is one `standup` record in the
observation log per 20-minute slot (the record itself is the dedupe key, so the
pane can ask as often as it likes). It never dispatches, reassigns, unblocks,
or edits anything, and it skips silently when the human is offline, no day is
running, or the hour is a retro hour. Two windows asking in the same instant
could both report a slot; the pane is the only caller, so that is not guarded.
"""
import json
import subprocess
import time

try:
    from . import day_schedule, db, observation_log, observer
    from .cli_day_cmds import _current_hat, _parse_time
    from .cli_observe_cmds import _guarded, log_path
    from .cli_presence_cmds import _settle, load_state
    from .cli_spec_cmds import _print, _run
except ImportError:
    import day_schedule  # type: ignore[import-not-found]
    import db  # type: ignore[import-not-found]
    import observation_log  # type: ignore[import-not-found]
    import observer  # type: ignore[import-not-found]
    from cli_day_cmds import _current_hat, _parse_time  # type: ignore[import-not-found]
    from cli_observe_cmds import _guarded, log_path  # type: ignore[import-not-found]
    from cli_presence_cmds import _settle, load_state  # type: ignore[import-not-found]
    from cli_spec_cmds import _print, _run  # type: ignore[import-not-found]

KANBAN_CALL_TIMEOUT = 8
KANBAN_TOTAL_BUDGET = 20


def read_kanban() -> dict:
    """Every board's tasks via the hermes CLI. Failing to read Kanban is a fact
    to report, not a reason to skip the standup, so errors come back as data."""
    deadline = time.monotonic() + KANBAN_TOTAL_BUDGET

    def call(argv):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(argv, KANBAN_TOTAL_BUDGET)
        result = subprocess.run(
            argv, check=True, capture_output=True, text=True, timeout=min(KANBAN_CALL_TIMEOUT, remaining),
        )
        return json.loads(result.stdout)

    try:
        boards = []
        for board in observer.parse_tasks(call(["hermes", "kanban", "boards", "list", "--json"])):
            slug = board.get("slug")
            if not slug:
                continue
            tasks = observer.parse_tasks(call(["hermes", "kanban", "--board", slug, "list", "--json"]))
            boards.append({"board": slug, "tasks": tasks})
        return {"available": True, "error": None, "boards": boards}
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        return {"available": False, "error": f"{type(exc).__name__}: {str(exc)[:160]}", "boards": []}


def _standups(day_date: str) -> list:
    try:
        return [r for r in observation_log.read(log_path(), kind="standup") if r.get("day") == day_date]
    except observation_log.LogError:
        return []


def _since_last(day_date: str, previous) -> dict:
    try:
        records = observation_log.read(log_path(), since_seq=previous["seq"] if previous else None)
    except observation_log.LogError:
        return {"records": 0, "by_kind": {}}
    by_kind: dict = {}
    for record in records:
        if record.get("kind") == "standup" or (previous is None and record.get("day") != day_date):
            continue
        by_kind[record["kind"]] = by_kind.get(record["kind"], 0) + 1
    return {"records": sum(by_kind.values()), "by_kind": by_kind}


def _skip(reason: str) -> None:
    _print({"ok": True, "reported": False, "skipped": reason})


def _cmd_observer_standup(args):
    def action(db_, conn):
        now = _parse_time(args.now).timestamp()
        evaluation, _warning = _settle(db_, conn, load_state(db_, conn), now)
        if not evaluation["online"]:
            return _skip("offline")
        day = db_.get_active_day(conn)
        if day is None:
            return _skip("no_active_day")
        snap = day_schedule.snapshot(day["hours"], now)
        if snap["state"] != "in_progress":
            return _skip("day_not_in_progress")
        current = snap["current"]
        if current["kind"] == "retro":
            return _skip("retro_hour")
        slot = observer.standup_slot(day["started_at"], now)
        standups = _standups(day["date"])
        previous = standups[-1] if standups else None
        if any(r["data"].get("slot") == slot for r in standups):
            return _skip("already_reported")

        pending = db_.list_pending(conn, limit=1000)
        previous_kanban = (previous or {}).get("data", {}).get("kanban", {})
        report = observer.build_report(
            slot=slot, day=day["date"], current=current, kanban_boards=read_kanban(),
            decisions={"pending": len(pending), "urgent": sum(1 for d in pending if d.get("urgency") == "high")},
            since_last=_since_last(day["date"], previous), current_hat=_current_hat(day),
            previous_totals=previous_kanban.get("totals") if previous_kanban.get("available") else None,
            now_ts=now,
        )
        record = _guarded(lambda: observation_log.append(
            log_path(), kind="standup", author="observer", data=report,
            day=day["date"], block=current["block"], hour=current["hour"],
        ))
        _print({"ok": True, "reported": True, "standup": record})
    _run(args, action)


def _cmd_observer_latest(args):
    """The newest standup of the active day, or None."""
    def action(db_, conn):
        day = db_.get_active_day(conn)
        standups = _standups(day["date"]) if day else []
        _print({"ok": True, "standup": standups[-1] if standups else None})
    _run(args, action)
