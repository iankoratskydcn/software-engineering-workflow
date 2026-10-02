"""`hermes decision presence ...`: the online switch.

On and off are the human's own actions. The one-hour idle expiry is decided by
presence.py; any presence command settles an expiry it finds, by turning the
switch off and recording `reason: idle` with the time it should have expired.
`--now` exists so the rules are testable; it only affects how the stored
timestamps are read and written, never the log record's own timestamp.
"""
import json

try:
    from . import db, observation_log, presence
    from .cli_day_cmds import _iso, _parse_time, _with_warning
    from .cli_observe_cmds import log_path
    from .cli_spec_cmds import _print, _run
except ImportError:
    import db  # type: ignore[import-not-found]
    import observation_log  # type: ignore[import-not-found]
    import presence  # type: ignore[import-not-found]
    from cli_day_cmds import _iso, _parse_time, _with_warning  # type: ignore[import-not-found]
    from cli_observe_cmds import log_path  # type: ignore[import-not-found]
    from cli_spec_cmds import _print, _run  # type: ignore[import-not-found]

_SETTING = "presence"


def load_state(db_, conn):
    raw = db_.get_setting(conn, _SETTING)
    try:
        state = json.loads(raw) if raw else None
    except ValueError:
        return None  # an unreadable value means the switch is off, never "stuck on"
    return state if isinstance(state, dict) and {"online", "since", "last_seen"} <= set(state) else None


def _save(db_, conn, state):
    db_.set_setting(conn, _SETTING, json.dumps(state))


def _record(author: str, data: dict):
    try:
        observation_log.append(log_path(), kind="presence", author=author, data=data)
    except (observation_log.LogError, OSError) as exc:
        return f"observation log write failed: {str(exc)[:200]}"
    return None


def _settle(db_, conn, state, now_ts):
    """Evaluate the state, turning the switch off (and logging why) if it expired."""
    evaluation = presence.evaluate(state, now_ts)
    warning = None
    if evaluation["expired"]:
        _save(db_, conn, presence.turned_off(state))
        warning = _record("system", {"state": "off", "reason": "idle", "expired_at": _iso(evaluation["expired_at"])})
    return evaluation, warning


def _view(state, now_ts, *, changed=False, auto_off=False):
    evaluation = presence.evaluate(state, now_ts)
    return {
        "online": evaluation["online"],
        "since": _iso(evaluation["since"]) if evaluation["since"] else None,
        "last_seen": _iso(evaluation["last_seen"]) if evaluation["last_seen"] else None,
        "idle_after_seconds": presence.IDLE_SECONDS,
        "changed": changed,
        "auto_off": auto_off,
    }


def _first(*warnings):
    return next((w for w in warnings if w), None)


def _cmd_presence_status(args):
    def action(db_, conn):
        now = _parse_time(args.now).timestamp()
        evaluation, warning = _settle(db_, conn, load_state(db_, conn), now)
        _print(_with_warning({"ok": True, "presence": _view(load_state(db_, conn), now, auto_off=evaluation["expired"])}, warning))
    _run(args, action)


def _cmd_presence_on(args):
    def action(db_, conn):
        now = _parse_time(args.now).timestamp()
        state = load_state(db_, conn)
        evaluation, warning = _settle(db_, conn, state, now)
        changed = not evaluation["online"]
        if changed:
            _save(db_, conn, presence.turned_on(now))
            warning = _first(warning, _record("human", {"state": "on", "reason": "manual"}))
        else:
            _save(db_, conn, presence.touched(state, now))
        _print(_with_warning({"ok": True, "presence": _view(load_state(db_, conn), now, changed=changed, auto_off=evaluation["expired"])}, warning))
    _run(args, action)


def _cmd_presence_off(args):
    def action(db_, conn):
        now = _parse_time(args.now).timestamp()
        state = load_state(db_, conn)
        evaluation, warning = _settle(db_, conn, state, now)
        changed = evaluation["online"]
        if changed:
            _save(db_, conn, presence.turned_off(state))
            warning = _first(warning, _record("human", {"state": "off", "reason": "manual"}))
        _print(_with_warning({"ok": True, "presence": _view(load_state(db_, conn), now, changed=changed, auto_off=evaluation["expired"])}, warning))
    _run(args, action)


def _cmd_presence_touch(args):
    """Heartbeat: the human interacted. Never turns the switch on, and writes
    nothing to the observation log."""
    def action(db_, conn):
        now = _parse_time(args.now).timestamp()
        state = load_state(db_, conn)
        evaluation, warning = _settle(db_, conn, state, now)
        if evaluation["online"]:
            _save(db_, conn, presence.touched(state, now))
        _print(_with_warning({"ok": True, "presence": _view(load_state(db_, conn), now, auto_off=evaluation["expired"])}, warning))
    _run(args, action)
