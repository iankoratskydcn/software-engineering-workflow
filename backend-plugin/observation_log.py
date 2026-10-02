"""Append-only observation log for the daily cadence workflow.

One JSON object per line (JSONL). Everything the retro reads is recorded here,
and nothing edits or deletes a record: a correction is a new record whose
`supersedes` names the one it replaces.

Integrity, in layers:

* **Single writer.** `append` takes an exclusive interprocess lock around
  read-tail, `seq` allocation, write, and fsync, so the desktop pane and any
  number of agents can append concurrently without duplicating a `seq`.
* **Hash chain.** Each record carries `prev_hash`, the SHA-256 of the previous
  record's exact line. Editing, deleting, or reordering a record breaks the
  chain at the record after it.
* **Checkpoints.** The chain alone cannot see truncation or a full rewrite with
  a fresh chain. `verify` therefore also checks the log against checkpoints
  (`seq` + head hash) that a human confirmed earlier and that live outside this
  file (see db.add_observation_checkpoint).

Threat model: this detects accidental or careless writes by agents, not a
determined adversary with full filesystem and database access. Records written
after the newest checkpoint can still be truncated undetected, and the very
last record can be edited undetected until the next append is chained onto it.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

if os.name == "nt":  # pragma: no cover - exercised on Windows only
    import msvcrt
else:
    import fcntl

KINDS = (
    "plan", "estimate_actual", "carryover", "accept", "reject", "rework",
    "blocker_raised", "blocker_answered", "standup", "presence", "hat_switch",
    "fleet_idle", "note", "retro_finding", "process_change", "hour_summary",
)
AUTHORS = ("human", "system", "scrum_master", "observer", "team_lead", "qa", "reviewer")

GENESIS_HASH = "sha256:" + "0" * 64
MAX_DATA_BYTES = 32 * 1024
MAX_ID_LENGTH = 128
LOCK_TIMEOUT_SECONDS = 30.0
MAX_REPORTED_PROBLEMS = 20
_TAIL_BYTES = 64 * 1024  # > MAX_DATA_BYTES plus record overhead, so the last line always fits
_REQUIRED_KEYS = ("id", "seq", "prev_hash", "ts", "kind", "author", "data")


class LogError(ValueError):
    """Bad input to the observation log."""


class LogBusy(LogError):
    """The append lock could not be acquired in time."""


class LogCorrupt(LogError):
    """The log's tail is not something safe to append to."""


def hash_line(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _canonical(record: dict) -> bytes:
    return json.dumps(
        record, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def _try_lock(lock) -> None:
    if os.name == "nt":  # pragma: no cover
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock(lock) -> None:
    if os.name == "nt":  # pragma: no cover
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


@contextmanager
def _exclusive(path: Path, timeout: float = LOCK_TIMEOUT_SECONDS) -> Iterator[None]:
    lock_path = path.with_name(path.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+b") as lock:
        deadline = time.monotonic() + timeout
        while True:
            try:
                _try_lock(lock)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise LogBusy(f"observation log is busy (lock held longer than {timeout:g}s)")
                time.sleep(0.01)
        try:
            yield
        finally:
            _unlock(lock)


def _read_last_line(path: Path) -> Optional[bytes]:
    """Return the final record's exact bytes (no newline), or None if empty."""
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        return None
    if size == 0:
        return None
    with open(path, "rb") as f:
        f.seek(max(0, size - _TAIL_BYTES))
        tail = f.read()
    if not tail.endswith(b"\n"):
        raise LogCorrupt("observation log does not end with a newline; run `observe verify`")
    body = tail[:-1]
    if b"\n" not in body and len(tail) < size:
        raise LogCorrupt("final observation line is longer than expected; run `observe verify`")
    last = body.rsplit(b"\n", 1)[-1]
    if not last:
        raise LogCorrupt("observation log ends with an empty line; run `observe verify`")
    return last


def _parse(raw: bytes, where: str) -> dict:
    try:
        record = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise LogCorrupt(f"{where} is not valid JSON; run `observe verify`")
    if not isinstance(record, dict):
        raise LogCorrupt(f"{where} is not a JSON object; run `observe verify`")
    return record


def _id_exists(path: Path, record_id: str) -> bool:
    try:
        with open(path, "rb") as f:
            for raw in f:
                try:
                    if json.loads(raw).get("id") == record_id:
                        return True
                except (ValueError, AttributeError):
                    continue
    except FileNotFoundError:
        pass
    return False


def _timestamp(now: Optional[datetime]) -> str:
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        raise LogError("timestamp must be timezone-aware")
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _validate(kind, author, data, feature_id, day, block, hour, supersedes) -> dict:
    if kind not in KINDS:
        raise LogError(f"kind must be one of: {', '.join(KINDS)}")
    if author not in AUTHORS:
        raise LogError(f"author must be one of: {', '.join(AUTHORS)}")
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise LogError("data must be a JSON object")
    try:
        data_bytes = len(_canonical(data))
    except (TypeError, ValueError):
        raise LogError("data must be JSON-serializable")
    if data_bytes > MAX_DATA_BYTES:
        raise LogError(f"data is larger than {MAX_DATA_BYTES} bytes")
    for name, value in (("feature_id", feature_id), ("supersedes", supersedes)):
        if value is not None and (not isinstance(value, str) or not value or len(value) > MAX_ID_LENGTH):
            raise LogError(f"{name} must be a non-empty string of at most {MAX_ID_LENGTH} characters")
    if day is not None:
        try:
            datetime.strptime(day, "%Y-%m-%d")
        except (TypeError, ValueError):
            raise LogError("day must be YYYY-MM-DD")
    for name, value in (("block", block), ("hour", hour)):
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 0):
            raise LogError(f"{name} must be a non-negative integer")
    return data


def append(
    path: Path,
    *,
    kind: str,
    author: str,
    data: Optional[dict] = None,
    feature_id: Optional[str] = None,
    day: Optional[str] = None,
    block: Optional[int] = None,
    hour: Optional[int] = None,
    supersedes: Optional[str] = None,
    now: Optional[datetime] = None,
) -> dict:
    """Append one record and return it. `now` exists for tests; callers that
    face users or agents must not expose it, since it would allow backdating."""
    path = Path(path)
    data = _validate(kind, author, data, feature_id, day, block, hour, supersedes)
    with _exclusive(path):
        last = _read_last_line(path)
        if last is None:
            seq, prev_hash = 1, GENESIS_HASH
        else:
            previous = _parse(last, "final observation line")
            if not isinstance(previous.get("seq"), int):
                raise LogCorrupt("final observation line has no integer seq; run `observe verify`")
            seq, prev_hash = previous["seq"] + 1, hash_line(last)
        if supersedes is not None and not _id_exists(path, supersedes):
            raise LogError(f"supersedes names an unknown record: {supersedes}")
        record = {
            "id": "obs_" + uuid.uuid4().hex,
            "seq": seq,
            "prev_hash": prev_hash,
            "ts": _timestamp(now),
            "day": day,
            "block": block,
            "hour": hour,
            "kind": kind,
            "feature_id": feature_id,
            "author": author,
            "data": data,
            "supersedes": supersedes,
        }
        line = _canonical(record) + b"\n"
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "ab") as f:
            f.write(line)
            f.flush()
            os.fsync(f.fileno())
    return record


def read(
    path: Path,
    *,
    kind: Optional[str] = None,
    feature_id: Optional[str] = None,
    since_seq: Optional[int] = None,
    limit: Optional[int] = None,
) -> list[dict]:
    """Return records in order, optionally filtered; `limit` keeps the newest N.
    Raises LogCorrupt on an unparseable line: use `verify` to diagnose."""
    path = Path(path)
    if not path.exists():
        return []
    records = []
    with open(path, "rb") as f:
        for number, raw in enumerate(f, start=1):
            record = _parse(raw.rstrip(b"\n"), f"line {number}")
            if kind is not None and record.get("kind") != kind:
                continue
            if feature_id is not None and record.get("feature_id") != feature_id:
                continue
            if since_seq is not None and not record.get("seq", 0) > since_seq:
                continue
            records.append(record)
    if limit is not None:
        if limit < 1:
            raise LogError("limit must be at least 1")
        records = records[-limit:]
    return records


def verify(path: Path, checkpoints: tuple[dict, ...] | list[dict] = ()) -> dict:
    """Check structure, chain, and checkpoints. Never raises on a bad log: it
    reports `problems` instead. Each checkpoint is {"seq": int, "head_hash": str}."""
    path = Path(path)
    problems: list[dict] = []

    def problem(code: str, message: str, line: Optional[int] = None) -> None:
        problems.append({"code": code, "line": line, "message": message})

    data = path.read_bytes() if path.exists() else b""
    lines = data.split(b"\n")
    if data and not data.endswith(b"\n"):
        problem("missing_final_newline", "last line is incomplete (truncated or partially written)", len(lines))
    else:
        lines = lines[:-1]  # drop the empty string after the final newline
    hashes: dict[int, str] = {}
    seen_ids: set[str] = set()
    expected_prev = GENESIS_HASH
    head: Optional[dict] = None

    for number, raw in enumerate(lines, start=1):
        line_hash = hash_line(raw)
        try:
            record = json.loads(raw)
            if not isinstance(record, dict):
                raise ValueError
        except (ValueError, UnicodeDecodeError):
            problem("malformed_record", "line is not a JSON object", number)
            expected_prev = line_hash
            continue
        missing = [key for key in _REQUIRED_KEYS if key not in record]
        if missing:
            problem("malformed_record", f"missing keys: {', '.join(missing)}", number)
        if record.get("seq") != number:
            problem("bad_seq", f"expected seq {number}, found {record.get('seq')!r}", number)
        if record.get("prev_hash") != expected_prev:
            problem("broken_chain", "prev_hash does not match the previous line", number)
        record_id = record.get("id")
        if record_id in seen_ids:
            problem("duplicate_id", f"id {record_id!r} appears more than once", number)
        supersedes = record.get("supersedes")
        if supersedes is not None and supersedes not in seen_ids:
            problem("dangling_supersedes", f"supersedes {supersedes!r} names no earlier record", number)
        if isinstance(record_id, str):
            seen_ids.add(record_id)
        hashes[number] = line_hash
        expected_prev = line_hash
        head = {"seq": number, "hash": line_hash}

    for checkpoint in checkpoints:
        seq, head_hash = checkpoint.get("seq"), checkpoint.get("head_hash")
        if not isinstance(seq, int) or seq > len(lines):
            problem("checkpoint_beyond_log", f"log has {len(lines)} records but a checkpoint was taken at seq {seq}")
        elif hashes.get(seq) != head_hash:
            problem("checkpoint_mismatch", f"record {seq} no longer matches the confirmed checkpoint", seq)

    return {
        "ok": not problems,
        "records": len(lines),
        "head": head,
        "problem_count": len(problems),
        "problems": problems[:MAX_REPORTED_PROBLEMS],
    }
