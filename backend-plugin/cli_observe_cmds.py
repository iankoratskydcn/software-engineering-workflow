"""`hermes decision observe ...`: the append-only observation log.

There is deliberately no edit or delete verb. A correction is a new record
with --supersedes. The record timestamp is never caller-supplied, so neither a
user nor an agent can backdate an entry.
"""
from pathlib import Path

try:
    from . import db, observation_log
    from .cli_spec_cmds import _fail, _print
except ImportError:
    import db  # type: ignore[import-not-found]
    import observation_log  # type: ignore[import-not-found]
    from cli_spec_cmds import _fail, _print  # type: ignore[import-not-found]

OBSERVE_KINDS = observation_log.KINDS
OBSERVE_AUTHORS = observation_log.AUTHORS

# Beyond cli_spec_cmds._fail's exit codes (invalid_input 2, not_found 3,
# conflict 4, busy 5, constraint 6, internal_error 1).
_EXIT_NOT_AUTHORIZED = 7


def log_path() -> Path:
    return db.db_path().parent / "observations.jsonl"


def _guarded(action):
    try:
        return action()
    except db.NotAuthorized as exc:
        _print({"ok": False, "error": {"code": "not_authorized", "message": str(exc)[:256]}})
        raise SystemExit(_EXIT_NOT_AUTHORIZED)
    except observation_log.LogBusy as exc:
        _print({"ok": False, "error": {"code": "busy", "message": str(exc)[:256]}})
        raise SystemExit(5)
    except observation_log.LogCorrupt as exc:
        _print({"ok": False, "error": {"code": "conflict", "message": str(exc)[:256]}})
        raise SystemExit(4)
    except Exception as exc:
        _fail(exc)


def _checkpoints() -> list:
    conn = db.connect()
    try:
        return db.list_observation_checkpoints(conn)
    finally:
        conn.close()


def _cmd_observe_add(args):
    def action():
        record = observation_log.append(
            log_path(),
            kind=args.kind,
            author=args.author,
            data=db.parse_json_kwarg(args.data, "--data"),
            feature_id=args.feature_id,
            day=args.day,
            block=args.block,
            hour=args.hour,
            supersedes=args.supersedes,
        )
        _print({"ok": True, "record": record})
    _guarded(action)


def _cmd_observe_list(args):
    def action():
        records = observation_log.read(
            log_path(), kind=args.kind, feature_id=args.feature_id,
            since_seq=args.since_seq, limit=args.limit,
        )
        _print({"ok": True, "records": records})
    _guarded(action)


def _verification_failed(result):
    _print({
        "ok": False,
        "error": {"code": "integrity_failed",
                  "message": f"observation log failed verification ({result['problem_count']} problem(s))"},
        "verification": result,
    })
    raise SystemExit(6)


def _cmd_observe_verify(args):
    def action():
        result = observation_log.verify(log_path(), _checkpoints())
        if not result["ok"]:
            _verification_failed(result)
        _print({"ok": True, "verification": result})
    _guarded(action)


def _cmd_observe_checkpoint(args):
    """Confirm the log's current head. Verifies first: a log that already fails
    verification is never blessed. Needs an interactive actor token, like
    `decision resolve`; a delegated child process is refused."""
    def action():
        result = observation_log.verify(log_path(), _checkpoints())
        if not result["ok"]:
            _verification_failed(result)
        if result["head"] is None:
            raise ValueError("observation log is empty; nothing to checkpoint")
        conn = db.connect()
        try:
            checkpoint = db.add_observation_checkpoint(
                conn, seq=result["head"]["seq"], head_hash=result["head"]["hash"],
                actor_token=args.actor_token,
            )
        finally:
            conn.close()
        _print({"ok": True, "checkpoint": checkpoint})
    _guarded(action)
