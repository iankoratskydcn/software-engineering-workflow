"""Schema v14 (observation_checkpoints) and the human-gated checkpoint functions."""
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402

HASH = "sha256:" + "ab" * 32


@pytest.fixture(autouse=True)
def hermes_home(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    monkeypatch.delenv(db._DELEGATED_CHILD_ENV_MARKER, raising=False)


def _conn(tmp_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(tmp_path / "test_queue.db"))
    conn.row_factory = sqlite3.Row
    db.init_db(conn)
    return conn


def _tables(conn) -> set[str]:
    return {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def _dump(conn) -> str:
    return "\n".join(conn.iterdump())


def test_fresh_database_has_the_checkpoint_table_at_the_latest_version(tmp_path):
    conn = _conn(tmp_path)
    try:
        assert db.LATEST_SCHEMA_VERSION >= 14
        assert conn.execute("PRAGMA user_version").fetchone()[0] == db.LATEST_SCHEMA_VERSION
        assert "observation_checkpoints" in _tables(conn)
    finally:
        conn.close()


def test_a_v13_database_upgrades_to_v14_and_reruns_without_change(tmp_path):
    conn = _conn(tmp_path)
    try:
        conn.execute("DROP TABLE observation_checkpoints")
        conn.execute("PRAGMA user_version = 13")
        conn.commit()

        db.init_db(conn)
        assert conn.execute("PRAGMA user_version").fetchone()[0] == db.LATEST_SCHEMA_VERSION
        assert "observation_checkpoints" in _tables(conn)

        before = _dump(conn)
        db.init_db(conn)
        assert _dump(conn) == before
    finally:
        conn.close()


def test_checkpoint_is_recorded_listed_and_idempotent(tmp_path):
    conn = _conn(tmp_path)
    try:
        token = db.issue_actor_token("owner")
        first = db.add_observation_checkpoint(conn, seq=3, head_hash=HASH, actor_token=token)
        assert first["seq"] == 3 and first["head_hash"] == HASH and first["confirmed_by"] == "owner"
        assert first["id"].startswith("ocp_")

        assert db.add_observation_checkpoint(conn, seq=3, head_hash=HASH, actor_token=token) == first
        later = db.add_observation_checkpoint(conn, seq=2, head_hash="sha256:" + "cd" * 32, actor_token=token)
        assert [row["seq"] for row in db.list_observation_checkpoints(conn)] == [2, 3]
        assert later["seq"] == 2
    finally:
        conn.close()


@pytest.mark.parametrize("seq, head_hash", [
    (0, HASH), (-1, HASH), (True, HASH), ("3", HASH), (3.0, HASH),
    (3, "ab" * 32), (3, "sha256:" + "AB" * 32), (3, "sha256:" + "ab" * 31), (3, "sha256:" + "zz" * 32), (3, None),
])
def test_invalid_checkpoint_input_is_rejected(tmp_path, seq, head_hash):
    conn = _conn(tmp_path)
    try:
        with pytest.raises(db.BoundaryError) as error:
            db.add_observation_checkpoint(conn, seq=seq, head_hash=head_hash, actor_token=db.issue_actor_token("owner"))
        assert error.value.code == "invalid_input"
        assert db.list_observation_checkpoints(conn) == []
    finally:
        conn.close()


@pytest.mark.parametrize("token", [None, "", "   ", "not-a-token"])
def test_checkpoint_without_a_valid_token_is_refused(tmp_path, token):
    conn = _conn(tmp_path)
    try:
        with pytest.raises(db.NotAuthorized):
            db.add_observation_checkpoint(conn, seq=1, head_hash=HASH, actor_token=token)
        assert db.list_observation_checkpoints(conn) == []
    finally:
        conn.close()


def test_checkpoint_is_refused_in_a_delegated_child_even_with_a_valid_token(tmp_path, monkeypatch):
    conn = _conn(tmp_path)
    try:
        token = db.issue_actor_token("owner")
        monkeypatch.setenv(db._DELEGATED_CHILD_ENV_MARKER, "1")
        with pytest.raises(db.NotAuthorized):
            db.add_observation_checkpoint(conn, seq=1, head_hash=HASH, actor_token=token)
        assert db.list_observation_checkpoints(conn) == []
    finally:
        conn.close()
