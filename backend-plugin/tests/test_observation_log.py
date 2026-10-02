"""Observation log: append-only, locked, hash-chained, checkpoint-verified."""
import json
import multiprocessing
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import observation_log as obs  # noqa: E402

WRITERS = 8
APPENDS_PER_WRITER = 25


def _log(tmp_path) -> Path:
    return tmp_path / "observations.jsonl"


def _fill(path, count=5):
    return [obs.append(path, kind="note", author="human", data={"n": n}) for n in range(1, count + 1)]


def _lines(path) -> list[bytes]:
    return path.read_bytes().split(b"\n")[:-1]


def _write_lines(path, lines: list[bytes]) -> None:
    path.write_bytes(b"\n".join(lines) + b"\n")


def _checkpoint(path, seq) -> dict:
    return {"seq": seq, "head_hash": obs.hash_line(_lines(path)[seq - 1])}


def _codes(result) -> set[str]:
    return {p["code"] for p in result["problems"]}


def _writer(path_str: str, tag: int) -> None:
    for n in range(APPENDS_PER_WRITER):
        obs.append(Path(path_str), kind="note", author="team_lead", data={"writer": tag, "n": n})


# --- append / read -----------------------------------------------------------

def test_append_chains_records_and_verifies(tmp_path):
    path = _log(tmp_path)
    first = obs.append(path, kind="plan", author="human", data={"hours": 5}, day="2026-10-02", block=1, hour=2)
    second = obs.append(path, kind="note", author="system", feature_id="spec_1")

    assert first["seq"] == 1 and first["prev_hash"] == obs.GENESIS_HASH
    assert second["seq"] == 2 and second["prev_hash"] == obs.hash_line(_lines(path)[0])
    assert first["id"] != second["id"] and first["id"].startswith("obs_")
    assert (first["day"], first["block"], first["hour"]) == ("2026-10-02", 1, 2)

    result = obs.verify(path)
    assert result["ok"] and result["records"] == 2 and result["problems"] == []
    assert result["head"] == {"seq": 2, "hash": obs.hash_line(_lines(path)[1])}


def test_timestamp_is_utc_with_millisecond_precision(tmp_path):
    record = obs.append(
        _log(tmp_path), kind="note", author="human",
        now=datetime(2026, 10, 2, 14, 55, 2, 123456, tzinfo=timezone.utc),
    )
    assert record["ts"] == "2026-10-02T14:55:02.123Z"


def test_data_with_newlines_and_unicode_stays_on_one_line(tmp_path):
    path = _log(tmp_path)
    data = {"text": "line one\nline two\r\nend", "sep": "a b", "emoji": "✓"}
    obs.append(path, kind="note", author="human", data=data)
    obs.append(path, kind="note", author="human")

    assert len(_lines(path)) == 2
    assert obs.read(path)[0]["data"] == data
    assert obs.verify(path)["ok"]


def test_supersede_keeps_the_original(tmp_path):
    path = _log(tmp_path)
    original = obs.append(path, kind="estimate_actual", author="human", data={"estimate": 3})
    correction = obs.append(
        path, kind="estimate_actual", author="human", data={"estimate": 5}, supersedes=original["id"]
    )
    records = obs.read(path)

    assert [r["id"] for r in records] == [original["id"], correction["id"]]
    assert records[0]["data"] == {"estimate": 3} and correction["supersedes"] == original["id"]
    assert obs.verify(path)["ok"]


@pytest.mark.parametrize("kwargs, message", [
    (dict(kind="bogus", author="human"), "kind"),
    (dict(kind="note", author="nobody"), "author"),
    (dict(kind="note", author="human", data=[1]), "data"),
    (dict(kind="note", author="human", data={"x": "y" * (obs.MAX_DATA_BYTES + 1)}), "larger"),
    (dict(kind="note", author="human", data={"x": float("nan")}), "serializable"),
    (dict(kind="note", author="human", day="02/10/2026"), "day"),
    (dict(kind="note", author="human", block=-1), "block"),
    (dict(kind="note", author="human", hour=True), "hour"),
    (dict(kind="note", author="human", feature_id=""), "feature_id"),
    (dict(kind="note", author="human", supersedes="obs_missing"), "unknown record"),
    (dict(kind="note", author="human", now=datetime(2026, 10, 2)), "timezone"),
])
def test_invalid_input_is_rejected_without_writing(tmp_path, kwargs, message):
    path = _log(tmp_path)
    with pytest.raises(obs.LogError, match=message):
        obs.append(path, **kwargs)
    assert not path.exists() or path.read_bytes() == b""


def test_read_filters_and_missing_file(tmp_path):
    path = _log(tmp_path)
    assert obs.read(path) == []
    obs.append(path, kind="note", author="human", feature_id="a")
    obs.append(path, kind="accept", author="human", feature_id="b")
    obs.append(path, kind="note", author="human", feature_id="b")

    assert [r["seq"] for r in obs.read(path, kind="note")] == [1, 3]
    assert [r["seq"] for r in obs.read(path, feature_id="b")] == [2, 3]
    assert [r["seq"] for r in obs.read(path, since_seq=1)] == [2, 3]
    assert [r["seq"] for r in obs.read(path, limit=2)] == [2, 3]
    with pytest.raises(obs.LogError):
        obs.read(path, limit=0)


# --- concurrency -------------------------------------------------------------

def test_concurrent_writers_get_unique_gap_free_seq(tmp_path):
    path = _log(tmp_path)
    ctx = multiprocessing.get_context("spawn")  # what Windows and macOS use
    workers = [ctx.Process(target=_writer, args=(str(path), tag)) for tag in range(WRITERS)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=120)
        assert worker.exitcode == 0

    records = obs.read(path)
    total = WRITERS * APPENDS_PER_WRITER
    assert [r["seq"] for r in records] == list(range(1, total + 1))
    assert len({r["id"] for r in records}) == total
    assert obs.verify(path)["ok"]
    per_writer = {tag: sum(1 for r in records if r["data"]["writer"] == tag) for tag in range(WRITERS)}
    assert set(per_writer.values()) == {APPENDS_PER_WRITER}


def test_lock_timeout_raises_busy(tmp_path):
    path = _log(tmp_path)
    with obs._exclusive(path):
        with pytest.raises(obs.LogBusy):
            with obs._exclusive(path, timeout=0.05):
                pass


# --- tamper detection --------------------------------------------------------

def test_edited_record_is_detected(tmp_path):
    path = _log(tmp_path)
    _fill(path)
    lines = _lines(path)
    lines[2] = lines[2].replace(b'"n":3', b'"n":99')
    _write_lines(path, lines)

    result = obs.verify(path)
    assert not result["ok"] and "broken_chain" in _codes(result)
    assert result["problems"][0]["line"] == 4  # the record after the edited one


def test_deleted_record_is_detected(tmp_path):
    path = _log(tmp_path)
    _fill(path)
    lines = _lines(path)
    del lines[2]
    _write_lines(path, lines)

    assert {"bad_seq", "broken_chain"} <= _codes(obs.verify(path))


def test_reordered_records_are_detected(tmp_path):
    path = _log(tmp_path)
    _fill(path)
    lines = _lines(path)
    lines[1], lines[2] = lines[2], lines[1]
    _write_lines(path, lines)

    assert {"bad_seq", "broken_chain"} <= _codes(obs.verify(path))


def test_truncation_below_a_checkpoint_is_detected(tmp_path):
    path = _log(tmp_path)
    _fill(path)
    checkpoint = _checkpoint(path, 4)
    _write_lines(path, _lines(path)[:3])

    result = obs.verify(path, [checkpoint])
    assert not result["ok"] and _codes(result) == {"checkpoint_beyond_log"}


def test_rewrite_with_a_fresh_valid_chain_is_caught_by_the_checkpoint(tmp_path):
    path = _log(tmp_path)
    _fill(path)
    checkpoint = _checkpoint(path, 3)
    path.unlink()
    for n in range(1, 6):
        obs.append(path, kind="note", author="human", data={"n": n, "rewritten": True})

    assert obs.verify(path)["ok"]  # the chain alone cannot see this
    result = obs.verify(path, [checkpoint])
    assert not result["ok"] and _codes(result) == {"checkpoint_mismatch"}


def test_truncated_final_line_is_reported_and_blocks_append(tmp_path):
    path = _log(tmp_path)
    _fill(path)
    path.write_bytes(path.read_bytes()[:-20])
    before = path.read_bytes()

    assert "missing_final_newline" in _codes(obs.verify(path))
    with pytest.raises(obs.LogCorrupt):
        obs.append(path, kind="note", author="human")
    assert path.read_bytes() == before


def test_garbage_tail_blocks_append_and_is_reported(tmp_path):
    path = _log(tmp_path)
    _fill(path, 2)
    with open(path, "ab") as f:
        f.write(b"not json\n")
    before = path.read_bytes()

    assert "malformed_record" in _codes(obs.verify(path))
    with pytest.raises(obs.LogCorrupt):
        obs.append(path, kind="note", author="human")
    assert path.read_bytes() == before


def test_duplicate_id_and_dangling_supersedes_are_detected(tmp_path):
    path = _log(tmp_path)
    _fill(path, 2)
    lines = _lines(path)
    second = json.loads(lines[1])
    second["supersedes"] = "obs_not_earlier"
    second["id"] = json.loads(lines[0])["id"]
    lines[1] = json.dumps(second, sort_keys=True, separators=(",", ":")).encode()
    _write_lines(path, lines)

    assert {"duplicate_id", "dangling_supersedes"} <= _codes(obs.verify(path))


def test_missing_or_empty_log_verifies_clean(tmp_path):
    path = _log(tmp_path)
    assert obs.verify(path) == {"ok": True, "records": 0, "head": None, "problem_count": 0, "problems": []}
    path.write_bytes(b"")
    assert obs.verify(path)["ok"]


# --- documented limits (the threat model in the module docstring) ------------

def test_truncation_after_the_newest_checkpoint_is_not_detected(tmp_path):
    path = _log(tmp_path)
    _fill(path)
    checkpoint = _checkpoint(path, 3)
    _write_lines(path, _lines(path)[:4])

    assert obs.verify(path, [checkpoint])["ok"]


def test_editing_the_last_record_is_not_detected_until_chained_over(tmp_path):
    path = _log(tmp_path)
    _fill(path)
    lines = _lines(path)
    lines[-1] = lines[-1].replace(b'"n":5', b'"n":99')
    _write_lines(path, lines)

    assert obs.verify(path)["ok"]
