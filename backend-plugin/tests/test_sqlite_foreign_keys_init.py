"""Regression: every db.py SQLite connection enables FKs before reads/writes."""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402


class _TrackedConnection:
    def __init__(self, conn):
        self._conn = conn
        self.statements = []

    @property
    def row_factory(self):
        return self._conn.row_factory

    @row_factory.setter
    def row_factory(self, value):
        self._conn.row_factory = value

    def execute(self, sql, *args, **kwargs):
        self.statements.append(sql)
        return self._conn.execute(sql, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._conn, name)


def _tracked_connect(path, tracked):
    real_connect = sqlite3.connect

    def connect(*args, **kwargs):
        wrapped = _TrackedConnection(real_connect(*args, **kwargs))
        tracked.append(wrapped)
        return wrapped

    return connect


def test_projects_db_enables_foreign_keys_before_select(tmp_path, monkeypatch):
    path = tmp_path / "projects.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT)")
    conn.execute("INSERT INTO projects VALUES ('p_1', 'demo', 'Demo')")
    conn.commit()
    conn.close()
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    tracked = []
    monkeypatch.setattr(db.sqlite3, "connect", _tracked_connect(path, tracked))

    assert db._resolve_project("p_1")["id"] == "p_1"
    assert tracked[0].statements[0].strip().upper() == "PRAGMA FOREIGN_KEYS=ON"


def test_kanban_db_enables_foreign_keys_before_select(tmp_path, monkeypatch):
    path = tmp_path / "kanban.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL)")
    conn.execute("INSERT INTO tasks VALUES ('t_1', 'done')")
    conn.commit()
    conn.close()
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    tracked = []
    monkeypatch.setattr(db.sqlite3, "connect", _tracked_connect(path, tracked))

    assert db._kanban_statuses({"t_1"}) == {"t_1": "done"}
    assert tracked[0].statements[0].strip().upper() == "PRAGMA FOREIGN_KEYS=ON"


def test_queue_connection_enables_foreign_keys_before_init(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "db_path", lambda: tmp_path / "queue.db")
    tracked = []
    monkeypatch.setattr(db.sqlite3, "connect", _tracked_connect(tmp_path / "queue.db", tracked))

    conn = db.connect()
    try:
        assert tracked[0].statements[0].strip().upper() == "PRAGMA FOREIGN_KEYS=ON"
    finally:
        conn.close()
