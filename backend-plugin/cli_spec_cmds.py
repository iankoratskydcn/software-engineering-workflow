"""Spec Digest CLI command implementations."""

import json
import sqlite3
import sys
import time
import uuid


def _db():
    try:
        from . import db
    except ImportError:
        import db
    return db


def _print(obj):
    print(json.dumps(obj, default=str))


def _error(exc):
    db = _db()
    if isinstance(exc, db.BoundaryError):
        code = exc.code
    elif isinstance(exc, sqlite3.IntegrityError):
        code = "constraint"
    elif isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc).lower():
        code = "busy"
    elif isinstance(exc, ValueError):
        code = "invalid_input"
    else:
        code = "internal_error"
    return {"ok": False, "error": {"code": code, "message": str(exc)[:256]}}


def _row(conn, node_id):
    return conn.execute(
        "SELECT id, project_id, kind, parent_id, level, title, status, note, description, rationale, criteria_json, metadata_json, decision_id, created_at, updated_at FROM spec_nodes WHERE id = ?",
        (node_id,),
    ).fetchone()


def _cmd_spec_add_node(args) -> None:
    db = _db()
    conn = db.connect()
    try:
        node = db.create_spec_node(
            conn, project_id=args.project_id, kind=args.kind,
            title=args.title, parent_id=args.parent_id,
        )
        _print({"ok": True, "node": node})
    except Exception as exc:
        conn.rollback()
        _print(_error(exc))
        sys.exit(1)
    finally:
        conn.close()


def _cmd_spec_tree(args) -> None:
    db = _db()
    conn = db.connect()
    try:
        _print({"ok": True, "tree": db.get_spec_tree(conn, project_id=args.project_id)})
    except Exception as exc:
        _print(_error(exc))
        sys.exit(1)
    finally:
        conn.close()


def _cmd_spec_list(args) -> None:
    db = _db()
    conn = db.connect()
    try:
        params = []
        where = []
        if args.project_id:
            where.append("project_id = ?")
            params.append(db._resolve_project(args.project_id)["id"])
        if args.kind:
            where.append("kind = ?")
            params.append(args.kind)
        sql = "SELECT id, project_id, kind, parent_id, title, status, note, criteria_json, decision_id, created_at, updated_at FROM spec_nodes"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY project_id, kind, created_at"
        _print([dict(row) for row in conn.execute(sql, params)])
    except ValueError as exc:
        _print({"ok": False, "error": str(exc)})
        sys.exit(1)
    finally:
        conn.close()


def _cmd_spec_update_node(args) -> None:
    db = _db()
    conn = db.connect()
    try:
        if _row(conn, args.id) is None:
            raise ValueError(f"node {args.id!r} not found")
        fields = [("title", args.title), ("status", args.status), ("note", args.note)]
        updates = [(key, value) for key, value in fields if value is not None]
        updates.append(("updated_at", time.time()))
        conn.execute(f"UPDATE spec_nodes SET {', '.join(f'{key} = ?' for key, _ in updates)} WHERE id = ?", [value for _, value in updates] + [args.id])
        conn.commit()
        _print(dict(_row(conn, args.id)))
    except ValueError as exc:
        _print({"ok": False, "error": str(exc)})
        sys.exit(1)
    finally:
        conn.close()


def _cmd_spec_set_criteria(args) -> None:
    db = _db()
    conn = db.connect()
    try:
        if _row(conn, args.id) is None:
            raise ValueError(f"node {args.id!r} not found")
        criteria = json.loads(args.criteria_json)
        if not isinstance(criteria, list):
            raise ValueError(f"criteria_json must be an array, not {type(criteria).__name__}")
        if not all(isinstance(item, str) for item in criteria):
            raise ValueError("all criteria items must be strings")
        if len(criteria) > 100 or any(len(item) > 10000 for item in criteria) or len(args.criteria_json.encode()) > 100 * 1024:
            raise ValueError("criteria_json exceeds size limits")
        conn.execute("UPDATE spec_nodes SET criteria_json = ?, updated_at = ? WHERE id = ?", (args.criteria_json, time.time(), args.id))
        conn.commit()
        _print(dict(_row(conn, args.id)))
    except (ValueError, json.JSONDecodeError) as exc:
        _print({"ok": False, "error": str(exc)})
        sys.exit(1)
    finally:
        conn.close()


def _cmd_spec_link_decision(args) -> None:
    db = _db()
    conn = db.connect()
    try:
        node = _row(conn, args.id)
        if node is None:
            raise ValueError(f"node {args.id!r} not found")
        decision = conn.execute("SELECT id, project_id FROM decisions WHERE id = ?", (args.decision_id,)).fetchone()
        if decision is None:
            raise ValueError(f"decision {args.decision_id!r} not found")
        if decision["project_id"] != node["project_id"]:
            raise ValueError(f"decision {args.decision_id!r} belongs to project {decision['project_id']!r}, not {node['project_id']!r}")
        conn.execute("UPDATE spec_nodes SET decision_id = ?, updated_at = ? WHERE id = ?", (args.decision_id, time.time(), args.id))
        conn.commit()
        _print(dict(_row(conn, args.id)))
    except ValueError as exc:
        _print({"ok": False, "error": str(exc)})
        sys.exit(1)
    finally:
        conn.close()


def _delete_node(conn, node_id):
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute("SELECT id FROM spec_nodes WHERE id = ?", (node_id,)).fetchone()
        if row is None:
            raise ValueError(f"node {node_id!r} not found")
        child_count = conn.execute("SELECT COUNT(*) FROM spec_nodes WHERE parent_id = ?", (node_id,)).fetchone()[0]
        if child_count:
            raise ValueError(f"cannot delete node {node_id!r}: it has {child_count} children. Delete children first.")
        conn.execute("DELETE FROM spec_nodes WHERE id = ?", (node_id,))
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _cmd_spec_delete_node(args) -> None:
    db = _db()
    conn = db.connect()
    try:
        _delete_node(conn, args.id)
        _print({"ok": True, "id": args.id})
    except ValueError as exc:
        _print({"ok": False, "error": str(exc)})
        sys.exit(1)
    finally:
        conn.close()


def _has_cycle_in_ancestors(conn: sqlite3.Connection, node_id: str, max_depth: int = 1000) -> bool:
    seen = set()
    current = node_id
    for _ in range(max_depth):
        if current in seen:
            return True
        seen.add(current)
        parent = conn.execute("SELECT parent_id FROM spec_nodes WHERE id = ?", (current,)).fetchone()
        if parent is None or parent["parent_id"] is None:
            return False
        current = parent["parent_id"]
    raise ValueError(f"ancestor chain exceeds max depth {max_depth}; refusing to trust malformed hierarchy")
