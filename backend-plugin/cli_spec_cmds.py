"""Spec node CLI wrappers."""
import json
import sqlite3
import sys


def _db():
    try:
        from . import db
    except ImportError:
        import db
    return db


def _print(value):
    print(json.dumps(value, default=str))


def _fail(exc):
    db = _db()
    if isinstance(exc, db.BoundaryError):
        code = exc.code
    elif isinstance(exc, sqlite3.IntegrityError):
        code = "constraint"
    elif isinstance(exc, ValueError):
        code = "invalid_input"
    else:
        code = "internal_error"
    exit_code = {"invalid_input": 2, "not_found": 3, "conflict": 4,
                 "busy": 5, "constraint": 6, "internal_error": 1}.get(code, 1)
    message = "resource not found" if code == "not_found" else str(exc)[:256]
    _print({"ok": False, "error": {"code": code, "message": message}})
    raise SystemExit(exit_code)


def _run(args, action):
    db = _db()
    conn = db.connect()
    try:
        return action(db, conn)
    except Exception as exc:
        conn.rollback()
        _fail(exc)
    finally:
        conn.close()


def _cmd_spec_add_node(args):
    def action(db, conn):
        node = db.create_spec_node(conn, project_id=args.project_id, kind=args.kind,
                                   title=args.title, parent_id=args.parent_id)
        _print({"ok": True, "node": node})
    _run(args, action)


def _cmd_spec_tree(args):
    _run(args, lambda db, conn: _print({"ok": True, "tree": db.get_spec_tree(conn, project_id=args.project_id)}))


def _cmd_spec_list(args):
    def action(db, conn):
        project = db._spec_project(args.project_id)
        rows = conn.execute(
            "SELECT id, project_id, kind, parent_id, level, title, status, note, criteria_json, decision_id, created_at, updated_at "
            "FROM spec_nodes WHERE project_id = ?" + (" AND kind = ?" if args.kind else "") +
            " ORDER BY kind, created_at, id",
            (project, args.kind) if args.kind else (project,),
        ).fetchall()
        _print({"ok": True, "nodes": [dict(row) for row in rows]})
    _run(args, action)


def _cmd_spec_update_node(args):
    def action(db, conn):
        fields = {k: v for k, v in {"title": args.title, "status": args.status, "note": args.note, "metadata_json": args.metadata_json}.items() if v is not None}
        node = db.update_spec_node(conn, args.id, project_id=args.project_id, **fields)
        _print({"ok": True, "node": node})
    _run(args, action)


def _cmd_spec_set_criteria(args):
    def action(db, conn):
        value = json.loads(args.criteria_json)
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise db.BoundaryError("invalid_input", "criteria_json must be an array of strings")
        node = db.update_spec_node(conn, args.id, project_id=args.project_id, criteria_json=args.criteria_json)
        _print({"ok": True, "node": node})
    _run(args, action)


def _cmd_spec_link_decision(args):
    def action(db, conn):
        node = db.update_spec_node(conn, args.id, project_id=args.project_id, decision_id=args.decision_id)
        _print({"ok": True, "node": node})
    _run(args, action)


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


def _delete_node(conn, node_id, project_id=None):
    if project_id is None:
        project_id = conn.execute("SELECT project_id FROM spec_nodes WHERE id = ?", (node_id,)).fetchone()["project_id"]
    conn.execute("BEGIN IMMEDIATE")
    row = conn.execute("SELECT id FROM spec_nodes WHERE id = ? AND project_id = ?", (node_id, project_id)).fetchone()
    if row is None:
        raise _db().BoundaryError("not_found", "resource not found")
    child_count = conn.execute("SELECT COUNT(*) FROM spec_nodes WHERE project_id = ? AND parent_id = ?", (project_id, node_id)).fetchone()[0]
    if child_count:
        raise _db().BoundaryError("constraint", f"cannot delete node {node_id!r}: it has children")
    conn.execute("DELETE FROM spec_nodes WHERE project_id = ? AND id = ?", (project_id, node_id))
    conn.commit()


def _cmd_spec_delete_node(args):
    def action(db, conn):
        project = db._spec_project(args.project_id)
        _delete_node(conn, args.id, project)
        _print({"ok": True, "id": args.id, "project_id": project})
    _run(args, action)
