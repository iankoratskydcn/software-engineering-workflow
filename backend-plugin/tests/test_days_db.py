"""Schema v15 (days, blocks, hours) and the persistence functions behind the clock."""
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import day_schedule as ds  # noqa: E402
import db  # noqa: E402

START = 1_790_000_000.0


def _conn(tmp_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(tmp_path / "test_queue.db"))
    conn.row_factory = sqlite3.Row
    db.init_db(conn)
    return conn


def _day(conn, hours=12, start=START, date="2026-10-02"):
    return db.create_day(conn, date=date, hours_available=hours, slots=ds.hour_slots(ds.plan(hours), start))


def _count(conn, table) -> int:
    return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def test_a_v14_database_upgrades_to_v15_and_reruns_without_change(tmp_path):
    conn = _conn(tmp_path)
    try:
        for table in ("hours", "blocks", "days"):
            conn.execute(f"DROP TABLE {table}")
        conn.execute("PRAGMA user_version = 14")
        conn.commit()

        db.init_db(conn)
        assert conn.execute("PRAGMA user_version").fetchone()[0] == db.LATEST_SCHEMA_VERSION
        assert {"days", "blocks", "hours"} <= {
            row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        before = "\n".join(conn.iterdump())
        db.init_db(conn)
        assert "\n".join(conn.iterdump()) == before
    finally:
        conn.close()


def test_create_day_persists_every_block_and_hour_in_order(tmp_path):
    conn = _conn(tmp_path)
    try:
        day = _day(conn, hours=12)
        assert day["status"] == "active" and day["hours_available"] == 12 and day["date"] == "2026-10-02"
        assert day["started_at"] == START
        assert [(h["block"], h["hour"], h["kind"]) for h in day["hours"]] == (
            [(1, 1, "retro")] + [(1, n, "work") for n in range(2, 7)]
            + [(2, 1, "retro")] + [(2, n, "work") for n in range(2, 7)]
        )
        assert day["hours"][0]["start_ts"] == START and day["hours"][-1]["end_ts"] == START + 12 * 3600
        assert [r["work_hours"] for r in conn.execute("SELECT work_hours FROM blocks ORDER BY idx")] == [5, 5]
        assert db.get_active_day(conn) == day
    finally:
        conn.close()


def test_no_active_day_reads_as_none(tmp_path):
    conn = _conn(tmp_path)
    try:
        assert db.get_active_day(conn) is None
    finally:
        conn.close()


def test_only_one_day_can_be_active_and_ending_frees_the_slot(tmp_path):
    conn = _conn(tmp_path)
    try:
        first = _day(conn, hours=3)
        with pytest.raises(db.BoundaryError) as error:
            _day(conn, hours=5)
        assert error.value.code == "conflict"
        assert (_count(conn, "days"), _count(conn, "blocks"), _count(conn, "hours")) == (1, 1, 3)

        ended = db.end_active_day(conn, ended_at=START + 100)
        assert ended["id"] == first["id"] and ended["status"] == "ended" and ended["ended_at"] == START + 100
        assert db.get_active_day(conn) is None

        second = _day(conn, hours=5, start=START + 7200)
        assert second["id"] != first["id"] and _count(conn, "days") == 2
    finally:
        conn.close()


def test_the_database_itself_refuses_a_second_active_day(tmp_path):
    conn = _conn(tmp_path)
    try:
        _day(conn, hours=3)
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO days (id, date, hours_available, status, started_at) VALUES ('x', '2026-10-03', 3, 'active', 0)"
            )
    finally:
        conn.close()


def test_ending_with_no_active_day_is_not_found(tmp_path):
    conn = _conn(tmp_path)
    try:
        with pytest.raises(db.BoundaryError) as error:
            db.end_active_day(conn, ended_at=START)
        assert error.value.code == "not_found"
    finally:
        conn.close()


def test_a_bad_layout_rolls_back_without_leaving_a_partial_day(tmp_path):
    conn = _conn(tmp_path)
    try:
        slots = ds.hour_slots([3], START)[:2]  # retro + 1 work hour: a block of 1 work hour is invalid
        with pytest.raises(sqlite3.IntegrityError):
            db.create_day(conn, date="2026-10-02", hours_available=3, slots=slots)
        assert (_count(conn, "days"), _count(conn, "blocks"), _count(conn, "hours")) == (0, 0, 0)
        assert db.get_active_day(conn) is None
        assert _day(conn, hours=3)["status"] == "active"  # and the slot is still free
    finally:
        conn.close()


def test_empty_layout_is_invalid_input(tmp_path):
    conn = _conn(tmp_path)
    try:
        with pytest.raises(db.BoundaryError) as error:
            db.create_day(conn, date="2026-10-02", hours_available=3, slots=[])
        assert error.value.code == "invalid_input"
    finally:
        conn.close()


@pytest.mark.parametrize("statement", [
    "INSERT INTO days (id, date, hours_available, status, started_at) VALUES ('d', '2026-10-02', 2, 'ended', 0)",
    "INSERT INTO days (id, date, hours_available, status, started_at) VALUES ('d', '2026-10-02', 25, 'ended', 0)",
    "INSERT INTO days (id, date, hours_available, status, started_at) VALUES ('d', '2026-10-02', 5, 'paused', 0)",
])
def test_day_constraints_are_enforced(tmp_path, statement):
    conn = _conn(tmp_path)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(statement)
    finally:
        conn.close()
