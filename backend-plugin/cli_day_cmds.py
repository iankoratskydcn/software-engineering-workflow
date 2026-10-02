"""`hermes decision day ...`: the daily cadence clock.

Layout and phase logic are pure (day_schedule.py); this module persists a day,
reads where `now` falls in it, and records the human's own actions in the
observation log. Scheduled phase changes are not logged: they are a pure
function of the plan record and the clock, so the retro can recompute them.
What is worth recording is what the human actually did (hat switches).
"""
import time
from datetime import datetime, timezone

try:
    from . import day_schedule, db, observation_log
    from .cli_observe_cmds import _guarded, log_path
    from .cli_spec_cmds import _fail, _print, _run
except ImportError:
    import day_schedule  # type: ignore[import-not-found]
    import db  # type: ignore[import-not-found]
    import observation_log  # type: ignore[import-not-found]
    from cli_observe_cmds import _guarded, log_path  # type: ignore[import-not-found]
    from cli_spec_cmds import _fail, _print, _run  # type: ignore[import-not-found]

DAY_HATS = day_schedule.HATS


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_time(value) -> datetime:
    """An aware datetime. No value means now; a naive ISO value is local time."""
    if value is None:
        return datetime.now().astimezone()
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValueError("time must be an ISO-8601 timestamp, e.g. 2026-10-02T09:00:00-07:00")
    return parsed if parsed.tzinfo is not None else parsed.astimezone()


def _hour_view(hour: dict) -> dict:
    return {**hour, "start": _iso(hour["start_ts"]), "end": _iso(hour["end_ts"])}


def _layout(work_hours_per_block: list) -> str:
    return ", ".join(f"1+{work}" for work in work_hours_per_block)


def _day_view(day: dict) -> dict:
    work_per_block: dict = {}
    for hour in day["hours"]:
        work_per_block[hour["block"]] = work_per_block.get(hour["block"], 0) + (hour["kind"] == "work")
    blocks = [work_per_block[block] for block in sorted(work_per_block)]
    return {
        "id": day["id"],
        "date": day["date"],
        "status": day["status"],
        "hours_available": day["hours_available"],
        "started_at": _iso(day["started_at"]),
        "layout": _layout(blocks),
        "blocks": len(blocks),
        "hours": [_hour_view(hour) for hour in day["hours"]],
    }


def _log(kind: str, *, day: str, data: dict, block=None, hour=None):
    """Append to the observation log. A failure here must not undo a day that
    already exists, so it is reported as a warning instead."""
    try:
        observation_log.append(
            log_path(), kind=kind, author="human", data=data, day=day, block=block, hour=hour
        )
    except (observation_log.LogError, OSError) as exc:
        return f"observation log write failed: {str(exc)[:200]}"
    return None


def _with_warning(payload: dict, warning) -> dict:
    return {**payload, "warnings": [warning]} if warning else payload


def _current_hat(day: dict):
    """The hat from the newest hat_switch record for this day, or None."""
    try:
        records = observation_log.read(log_path(), kind="hat_switch")
    except observation_log.LogError:
        return None
    for record in reversed(records):
        if record.get("day") == day["date"]:
            return (record.get("data") or {}).get("hat")
    return None


def _cmd_day_plan(args):
    """Preview a day's layout without saving anything."""
    try:
        start = _parse_time(args.at)
        blocks = day_schedule.plan(args.hours)
        slots = day_schedule.hour_slots(blocks, start.timestamp())
    except Exception as exc:
        _fail(exc)
    _print({"ok": True, "plan": {
        "hours_available": args.hours,
        "layout": _layout(blocks),
        "blocks": len(blocks),
        "hours": [_hour_view(slot) for slot in slots],
    }})


def _cmd_day_start(args):
    def action(db_, conn):
        start = _parse_time(args.at)
        blocks = day_schedule.plan(args.hours)
        slots = day_schedule.hour_slots(blocks, start.timestamp())
        day = db_.create_day(conn, date=start.date().isoformat(), hours_available=args.hours, slots=slots)
        warning = _log("plan", day=day["date"], data={
            "event": "day_started", "hours_available": args.hours, "work_hours_per_block": blocks,
            "start": _iso(day["started_at"]),
        })
        _print(_with_warning({"ok": True, "day": _day_view(day)}, warning))
    _run(args, action)


def _cmd_day_status(args):
    def action(db_, conn):
        day = db_.get_active_day(conn)
        if day is None:
            _print({"ok": True, "active": False})
            return
        now = _parse_time(args.now).timestamp()
        snap = day_schedule.snapshot(day["hours"], now)
        current = snap["current"]
        if current is not None:
            phase = current["phase"]
            current = {**_hour_view({k: v for k, v in current.items() if k != "phase"}), "phase": {
                **phase,
                "phase_start": _iso(phase["phase_start_ts"]),
                "phase_end": _iso(phase["phase_end_ts"]),
            }}
        upcoming = snap["next"]
        _print({
            "ok": True,
            "active": True,
            "now": _iso(now),
            "state": snap["state"],
            "day": _day_view(day),
            "current": current,
            "next": _hour_view(upcoming) if upcoming else None,
            "starts_in_seconds": snap.get("starts_in_seconds"),
            "hours_remaining": snap.get("hours_remaining"),
            "current_hat": _current_hat(day),
        })
    _run(args, action)


def _cmd_day_hat(args):
    """Record which hat the human is wearing now."""
    def action(db_, conn):
        day = db_.get_active_day(conn)
        if day is None:
            raise db_.BoundaryError("not_found", "no active day")
        block = hour = None
        snap = day_schedule.snapshot(day["hours"], time.time())
        if snap["current"] is not None:
            block, hour = snap["current"]["block"], snap["current"]["hour"]
        record = _guarded(lambda: observation_log.append(
            log_path(), kind="hat_switch", author="human", data={"hat": args.hat},
            day=day["date"], block=block, hour=hour,
        ))
        _print({"ok": True, "hat": args.hat, "record": record})
    _run(args, action)


def _cmd_day_end(args):
    def action(db_, conn):
        day = db_.end_active_day(conn, ended_at=time.time())
        warning = _log("plan", day=day["date"], data={"event": "day_ended", "ended_at": _iso(day["ended_at"])})
        _print(_with_warning({"ok": True, "day": _day_view(day)}, warning))
    _run(args, action)
