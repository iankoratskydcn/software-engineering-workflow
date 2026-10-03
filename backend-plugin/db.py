"""Decision HUD — shared SQLite queue.

Multiple processes/paths can insert `decisions` rows (NOT single-writer,
despite an earlier version of this docstring claiming the MCP server was
the sole inserter — that was never true and F12 corrects it):
  - decision_hud_mcp.py (decision_push, batch_approval_push MCP tools) —
    the primary path for agents.
  - cli.py's `hermes decision push` / `push-batch` / `report` (which
    triages into a push_decision call) commands — used directly by humans
    and by scripts/automation that shell out to the CLI instead of MCP.
All three call the same push_decision()/push_batch_approval() functions in
this module, so insert-time invariants (choices bounds, batch_id
uniqueness, etc.) are enforced once regardless of caller.

Resolution (`resolve_decision`) is authorization-gated (see the actor-token
section below): only a caller holding a valid, non-expired actor token
issued via `issue_actor_token()` may resolve a row, and a process running
in a delegated-child context (HERMES_DELEGATED_CHILD_CONTEXT) is rejected
outright even with a valid token — no subagent, worker, or raw import can
self-approve a decision, batch_approval included. Two SQLite connections
in WAL mode can safely share the file under this division of labor.

Break-glass override (`issue_owner_override_token`, added 2026-09-12): for
the rare case where the owner has no working desktop-pane/CLI session to
mint a normal actor token themselves, but has explicitly instructed the
top-level orchestrating agent, in the current conversation, to resolve a
specific decision on their behalf. This does NOT weaken any of the above —
the delegated-child block still applies unmodified, so a subagent can never
use it either — it only ever extends the top-level session's own authority,
and only when it can cite the exact owner instruction that authorized it.
Every mint writes a full, unslugged reason + timestamp to an independent,
append-only `override_audit.log`, and the resulting `resolved_by` is always
prefixed `AGENT_OVERRIDE:` so an override resolution is never confused with
a real interactive one. See `tests/test_owner_override.py` for the contract.
This is a break-glass mechanic, not a standing default — reach for the
normal interactive path first whenever it's available.

Schema (v2, adds card_type/card_payload_json/resolved_payload_json for the
decision-hud-cards skill: pushed decisions can carry a rendering hint + config
for a visual card instead of plain text, and resolutions can carry structured
data instead of just a plain-text choice):
    id              TEXT PRIMARY KEY   (uuid4 hex, assigned by the MCP server)
    project         TEXT NOT NULL      (v1-v5: free-text project tag, e.g.
                                         "tbcaf" — REPLACED by project_id in
                                         v6, see below; kept here only as a
                                         historical record of what v2 added)
    question        TEXT NOT NULL
    choices_json     TEXT NOT NULL      (JSON list[str], 2-4 entries)
    recommended     TEXT               (one of choices, or NULL)
    urgency         TEXT NOT NULL      (low|normal|high)
    created_at      REAL NOT NULL      (unix time)
    card_type       TEXT               (NULL, or a decision-hud-cards taxonomy
                                         key e.g. "balance_scale",
                                         "assemble_pieces" — a rendering hint;
                                         the desktop pane's plain text/choices
                                         fallback still always applies)
    card_payload_json TEXT             (NULL, or JSON config for the card,
                                         e.g. {"considerations": [...]} for
                                         balance_scale)
    resolved_choice TEXT              (NULL until resolved; free-text allowed
                                         for an "Other" answer — always kept as
                                         a human-readable summary even when
                                         resolved_payload_json is also set)
    resolved_at     REAL               (NULL until resolved)
    resolved_payload_json TEXT         (NULL, or JSON structured result from a
                                         card, e.g. {"winner": "postgres",
                                         "tally": {"postgres": 3, "mongo": 2}})

Schema (v3, adds defer support — a lightweight "looked at it, skipping for
now, still pending" signal distinct from resolving):
    defer_log_json  TEXT               (NULL, or JSON list of
                                         {"deferred_at": <unix time>,
                                         "note": <str|None>} — append-only,
                                         one entry per defer_decision() call)
    last_deferred_at REAL              (NULL, or unix time of the most recent
                                         defer — a plain column rather than
                                         re-parsing defer_log_json so
                                         list_pending's ORDER BY tiebreak can
                                         stay simple SQL, not JSON path magic)
    defer_count     INTEGER NOT NULL DEFAULT 0  (redundant with
                                         len(defer_log) but kept as its own
                                         column for the same reason —
                                         cheap to sort/filter on without
                                         parsing JSON in every list_pending
                                         call)

A deferred decision NEVER sets resolved_choice/resolved_at — it stays in
list_pending() results forever, exactly like any other unresolved row. The
only externally visible effect of a defer is that it sorts later than
non-deferred rows of the same urgency (see list_pending), plus the
defer_log/defer_count/last_deferred_at fields a UI can use to show "skipped
N times, last Tuesday" context. This mirrors mark_escalation_necessity's
choice to ride on existing row/columns rather than add a whole new table —
here the fields are dedicated (not reusing resolved_payload_json) because
defer is meaningful on UNRESOLVED rows, where resolved_payload_json is by
definition still NULL.

Schema (v6, breaking cutover — owner decision: pre-v6 rows are disposable
test data, no backfill): `project` (free text) is REPLACED by `project_id`,
which must reference a real row in hermes_cli.projects_db's `projects` table
(the same store `hermes project ...` manages). Every push validates the id
against that store at insert time; there is no more accepting an arbitrary
string. Display fields (project slug/name) are joined in at read time, not
duplicated into the decisions table, so a project rename is reflected
immediately everywhere without a decision-hud-side update.

Raw problem reports (pre-triage), fast-path decisions bypass this table entirely:
    id              TEXT PRIMARY KEY   (uuid4 hex)
    project_id      TEXT NOT NULL      (validated against projects.db, as above)
    problem         TEXT NOT NULL      (free-form: what the agent is stuck on)
    context         TEXT               (free-form evidence/background, optional)
    reporter        TEXT               (free-text: which agent/session filed it)
    created_at      REAL NOT NULL
    status          TEXT NOT NULL      ('pending' | 'triaged' | 'triage_failed')
    decision_id     TEXT               (set once triage produces a decisions row)
    triage_error    TEXT               (set on 'triage_failed')
    triaged_at      REAL
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Optional

_VALID_URGENCY = ("low", "normal", "high")

_MAX_FLOW_STEPS = 512
_MAX_FLOW_EDGES = 32
_MAX_FLOW_GRAPH_BYTES = 256 * 1024

TEXT_LIMIT = 4096
ID_LIMIT = 128
LIST_LIMIT = 256
LIST_VALUE_LIMIT = 512
JSON_LIMIT = 256 * 1024
JSON_DEPTH_LIMIT = 8
COORDINATE_MIN = -100000
COORDINATE_MAX = 100000

# Newest schema version init_db migrates to. Bump together with the newest
# _migrate_vN; the tests assert init_db lands exactly here.
LATEST_SCHEMA_VERSION = 17


class BoundaryError(ValueError):
    """Safe, machine-readable rejection at a trust boundary."""

    def __init__(self, code: str, message: str = "request rejected") -> None:
        super().__init__(message)
        self.code = code


class _RoadmapMigrationConflict(BoundaryError, sqlite3.OperationalError):
    """Roadmap preflight error compatible with legacy DDL-conflict callers."""


def validate_text(value: Any, *, field: str, max_chars: int = TEXT_LIMIT,
                  allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise BoundaryError("invalid_input", f"{field} must be a string")
    result = value.strip()
    if not result and not allow_empty:
        raise BoundaryError("invalid_input", f"{field} is required")
    if len(result) > max_chars:
        raise BoundaryError("invalid_input", f"{field} exceeds its size limit")
    return result


def validate_list(value: Any, *, field: str, max_items: int = LIST_LIMIT,
                  max_value_chars: int = LIST_VALUE_LIMIT) -> list[str]:
    if not isinstance(value, list):
        raise BoundaryError("invalid_input", f"{field} must be a list")
    if len(value) > max_items:
        raise BoundaryError("invalid_input", f"{field} has too many items")
    result: list[str] = []
    for item in value:
        result.append(validate_text(item, field=f"{field} item", max_chars=max_value_chars))
    return result


def _validate_json_value(value: Any, *, field: str, depth: int,
                         max_items: int, max_value_chars: int) -> None:
    if depth > JSON_DEPTH_LIMIT:
        raise BoundaryError("invalid_input", f"{field} is too deeply nested")
    if isinstance(value, dict):
        if len(value) > max_items:
            raise BoundaryError("invalid_input", f"{field} has too many object keys")
        for key, child in value.items():
            validate_text(key, field=f"{field} key", max_chars=max_value_chars)
            _validate_json_value(child, field=field, depth=depth + 1,
                                 max_items=max_items, max_value_chars=max_value_chars)
    elif isinstance(value, list):
        if len(value) > max_items:
            raise BoundaryError("invalid_input", f"{field} has too many items")
        for child in value:
            _validate_json_value(child, field=field, depth=depth + 1,
                                 max_items=max_items, max_value_chars=max_value_chars)
    elif isinstance(value, str) and len(value) > max_value_chars:
        raise BoundaryError("invalid_input", f"{field} contains an oversized string")


def validate_json_text(value: Any, *, field: str, max_bytes: int = JSON_LIMIT,
                       max_items: int = LIST_LIMIT,
                       max_value_chars: int = LIST_VALUE_LIMIT) -> Any:
    if not isinstance(value, str):
        raise BoundaryError("invalid_input", f"{field} must be JSON text")
    if len(value.encode("utf-8")) > max_bytes:
        raise BoundaryError("invalid_input", f"{field} exceeds its size limit")
    try:
        decoded = json.loads(value, parse_constant=lambda token: (_ for _ in ()).throw(ValueError(f"non-standard JSON constant: {token}")))
    except (json.JSONDecodeError, ValueError) as exc:
        raise BoundaryError("invalid_input", f"{field} must be valid JSON") from exc
    _validate_json_value(decoded, field=field, depth=0, max_items=max_items,
                         max_value_chars=max_value_chars)
    return decoded


def validate_coordinate(value: Any, *, field: str,
                        minimum: float = COORDINATE_MIN,
                        maximum: float = COORDINATE_MAX) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise BoundaryError("invalid_input", f"{field} must be a finite number")
    if value < minimum or value > maximum:
        raise BoundaryError("invalid_input", f"{field} is outside its allowed range")
    return value


def require_project_scope(conn: Optional[sqlite3.Connection], *, project_id: str,
                          row_project_id: Optional[str]) -> None:
    del conn
    if row_project_id is None or row_project_id != project_id:
        raise BoundaryError("not_found", "resource not found")

# --- delegated-child detection --------------------------------------------
#
# decision-hud does not import hermes-agent (it's a standalone plugin, and
# the MCP server script in particular runs as its own spawned process), so
# this replicates only the detection SIGNAL hermes-agent's
# agent.delegation_context.is_delegated_child_process_context() uses — the
# env var a delegate_task child (and any subprocess it spawns) carries —
# not that function's ContextVar half, which only makes sense inside the
# same long-lived agent process. Same env var name, same fail-closed intent:
# a delegated subagent/worker process must never be able to resolve a
# decision, even by shelling out to `hermes decision resolve` directly.
_DELEGATED_CHILD_ENV_MARKER = "HERMES_DELEGATED_CHILD_CONTEXT"


def _is_delegated_child_process_context() -> bool:
    """True in this process or any subprocess spawned by a delegate_task child
    (mirrors hermes-agent's env-var signal; see module comment above)."""
    return bool(os.environ.get(_DELEGATED_CHILD_ENV_MARKER))


def _connect_sqlite(path: Path | str, **kwargs: Any) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), **kwargs)
    conn.execute("PRAGMA foreign_keys=ON")
    if conn.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
        conn.close()
        raise RuntimeError("SQLite foreign-key enforcement could not be enabled")
    return conn


def _resolve_project(project_id: str) -> dict[str, str]:
    """Validate `project_id` against the real hermes_cli.projects_db store and
    return {"id", "slug", "name"}. Matches by id first, then by slug —
    mirroring hermes_cli.projects_db.get_project()'s id-or-slug contract, so
    callers that only know a project's human slug (e.g. kanban's
    batch_approval_gate, which an operator types as a board-facing name, not
    the internal p_xxxxxxxx id) still resolve. Raises ValueError for
    anything that isn't a currently-known project row — this is the v6
    enforcement point: NO caller may push a decision/report/batch/constraint
    against a project_id that doesn't exist. Reads projects.db directly
    (read-only, no import of hermes_cli itself — this plugin runs
    standalone, same reasoning as the delegated-child-context detection
    above) so a missing hermes_cli import is never a viable escape hatch:
    any failure to open/read the real store is a hard error, not a silent
    pass-through.
    """
    if not project_id or not project_id.strip():
        raise ValueError("project_id is required")
    project_id = project_id.strip()
    projects_db_path = _hermes_home() / "projects.db"
    if not projects_db_path.exists():
        raise ValueError(
            f"project_id {project_id!r} could not be validated: no projects.db found at "
            f"{projects_db_path} — create the project first with `hermes project create`")
    conn = _connect_sqlite(projects_db_path)
    try:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT id, slug, name FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        if row is None:
            row = conn.execute(
                "SELECT id, slug, name FROM projects WHERE slug = ?", (project_id.lower(),)
            ).fetchone()
    finally:
        conn.close()
    if row is None:
        raise ValueError(
            f"project_id {project_id!r} does not match any known project; "
            "list real projects with `hermes project list` or create one with `hermes project create`")
    return {"id": row["id"], "slug": row["slug"], "name": row["name"]}


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except Exception:
        return Path.home() / ".hermes"


def db_path() -> Path:
    d = _hermes_home() / "decision_hud"
    d.mkdir(parents=True, exist_ok=True)
    return d / "queue.db"


def connect() -> sqlite3.Connection:
    conn = _connect_sqlite(db_path(), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    init_db(conn)
    return conn


def _migrate_v7_hierarchy(conn: sqlite3.Connection) -> None:
    """Create the persisted Project-to-Task hierarchy tables idempotently."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS hierarchy_nodes (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            parent_id TEXT,
            level INTEGER NOT NULL,
            title TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            kanban_task_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_hierarchy_parent ON hierarchy_nodes(parent_id);
        CREATE INDEX IF NOT EXISTS idx_hierarchy_project ON hierarchy_nodes(project_id, level);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_hierarchy_one_root_per_project
            ON hierarchy_nodes(project_id) WHERE level = 0;
        """
    )
    current_version = conn.execute("PRAGMA user_version").fetchone()[0]
    if current_version < 7:
        conn.execute("PRAGMA user_version = 7")
    conn.commit()


_RISK_TRADEOFF_KINDS = ("scale", "duel", "anchor")
_RISK_STATUSES = ("open", "mitigated", "accepted", "closed")


def _preflight_risk_tradeoff_legacy(conn: sqlite3.Connection) -> None:
    """Refuse incompatible legacy rows before any migration write."""
    tradeoff_table = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='tradeoffs'").fetchone()
    risk_table = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='risks'").fetchone()
    if tradeoff_table is None and risk_table is None:
        return

    legacy_tradeoffs = {"id", "project_id", "decision_id", "title", "option_a", "option_b", "prioritized_side", "created_at", "updated_at"}
    canonical_tradeoffs = {"id", "project_id", "kind", "title", "choice", "created_at", "updated_at"}
    legacy_empty_tradeoffs = False
    if tradeoff_table is not None:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(tradeoffs)")}
        if not canonical_tradeoffs.issubset(columns):
            if columns != legacy_tradeoffs or conn.execute("SELECT 1 FROM tradeoffs LIMIT 1").fetchone() is not None:
                raise BoundaryError("constraint", "tradeoff migration requires canonical columns")
            legacy_empty_tradeoffs = True

    legacy_risks = {"id", "project_id", "decision_id", "title", "description", "status", "created_at", "updated_at"}
    legacy_empty_risks = False
    if risk_table is not None:
        risk_columns = {row[1] for row in conn.execute("PRAGMA table_info(risks)")}
        if risk_columns == legacy_risks and conn.execute("SELECT 1 FROM risks LIMIT 1").fetchone() is None:
            legacy_empty_risks = True

    for name, required_sql in (
        ("risks", ("check(statusin('open','mitigated','accepted','closed'))", "foreignkey(project_id,decision_id)")),
        ("tradeoffs", ("check(kindin('scale','duel','anchor'))", "foreignkey(project_id,decision_id)", "prioritized_side")),
    ):
        if name == "risks" and legacy_empty_risks:
            continue
        if name == "tradeoffs" and legacy_empty_tradeoffs:
            continue
        row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
        if row is not None:
            sql = "".join((row[0] or "").lower().split())
            if any(fragment not in sql for fragment in required_sql):
                raise BoundaryError("constraint", f"{name} migration requires canonical constrained schema")


def _migrate_v8_stage2_risk_tradeoffs(conn: sqlite3.Connection) -> None:
    columns = {row[1] for row in conn.execute("PRAGMA table_info(tradeoffs)")}
    legacy = {"id", "project_id", "decision_id", "title", "option_a", "option_b", "prioritized_side", "created_at", "updated_at"}
    risk_row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='risks'").fetchone()
    risk_columns = {row[1] for row in conn.execute("PRAGMA table_info(risks)")} if risk_row else set()
    legacy_risks = {"id", "project_id", "decision_id", "title", "description", "status", "created_at", "updated_at"}
    rebuilding_legacy = columns == legacy
    rebuilding_legacy_risks = risk_columns == legacy_risks
    outer_transaction = conn.in_transaction
    savepoint = "stage2_v8_risk_tradeoffs"
    try:
        if outer_transaction:
            conn.execute(f"SAVEPOINT {savepoint}")
        else:
            conn.execute("BEGIN IMMEDIATE")
        if rebuilding_legacy:
            conn.execute("DROP INDEX IF EXISTS idx_tradeoffs_project")
            conn.execute("DROP TABLE tradeoffs")
        if rebuilding_legacy_risks:
            conn.execute("DROP INDEX IF EXISTS idx_risks_project")
            conn.execute("DROP TABLE risks")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_project_id_unique ON decisions(project_id, id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS risks (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, decision_id TEXT,
                title TEXT NOT NULL, description TEXT, breaks_when TEXT,
                status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','mitigated','accepted','closed')),
                created_at REAL NOT NULL, updated_at REAL NOT NULL,
                UNIQUE(project_id, id),
                FOREIGN KEY(project_id,decision_id) REFERENCES decisions(project_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_risks_project ON risks(project_id, created_at, id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tradeoffs (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, decision_id TEXT,
                kind TEXT NOT NULL CHECK(kind IN ('scale','duel','anchor')),
                title TEXT NOT NULL, choice TEXT NOT NULL, alt_label TEXT, cost TEXT, gain TEXT,
                prioritized_side TEXT CHECK(prioritized_side IS NULL OR prioritized_side IN ('a','b')),
                created_at REAL NOT NULL, updated_at REAL NOT NULL,
                UNIQUE(project_id, id),
                FOREIGN KEY(project_id,decision_id) REFERENCES decisions(project_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tradeoffs_project ON tradeoffs(project_id, created_at, id)")
        if conn.execute("PRAGMA user_version").fetchone()[0] < 8:
            conn.execute("PRAGMA user_version = 8")
        if outer_transaction:
            conn.execute(f"RELEASE SAVEPOINT {savepoint}")
        else:
            conn.commit()
    except Exception:
        if outer_transaction:
            conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            conn.execute(f"RELEASE SAVEPOINT {savepoint}")
        else:
            conn.rollback()
        raise


def _migrate_v9_flowcharts(conn: sqlite3.Connection) -> None:
    """Add canonical project-owned flowcharts after the v8 risk migration."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS flows (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            steps_json TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(project_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_flows_project ON flows(project_id, updated_at, id);
        """
    )
    if conn.execute("PRAGMA user_version").fetchone()[0] < 9:
        conn.execute("PRAGMA user_version = 9")


def _migrate_v10_architecture(conn: sqlite3.Connection) -> None:
    """Create the architecture surface as one atomic, idempotent migration."""
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='architecture_diagrams'"
    ).fetchone()
    if version == 10 and table is None:
        raise BoundaryError("constraint", "partial v10 architecture migration is unsupported")
    if version > 10:
        return

    if table is not None:
        _preflight_architecture_legacy(conn, version=version)
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS architecture_diagrams (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL,
                nodes_json TEXT NOT NULL,
                edges_json TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                UNIQUE(project_id, id)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_architecture_diagrams_project "
            "ON architecture_diagrams(project_id, updated_at, id)"
        )
        conn.execute("PRAGMA user_version = 10")
        conn.commit()
    except Exception:
        conn.rollback()
        raise


_ROADMAP_STATUSES = ("planned", "todo", "in_progress", "blocked", "done", "cancelled")


_ROADMAP_TABLES = {"roadmap_lanes", "roadmap_items"}
_ROADMAP_COLUMNS = {
    "roadmap_lanes": (
        ("id", "TEXT", 0, None, 1),
        ("project_id", "TEXT", 1, None, 0),
        ("title", "TEXT", 1, None, 0),
        ("sort_order", "INTEGER", 1, "0", 0),
        ("created_at", "REAL", 1, None, 0),
        ("updated_at", "REAL", 1, None, 0),
    ),
    "roadmap_items": (
        ("id", "TEXT", 0, None, 1),
        ("project_id", "TEXT", 1, None, 0),
        ("lane_id", "TEXT", 1, None, 0),
        ("title", "TEXT", 1, None, 0),
        ("description", "TEXT", 0, None, 0),
        ("status", "TEXT", 1, "'planned'", 0),
        ("sort_order", "INTEGER", 1, "0", 0),
        ("depends_on_json", "TEXT", 1, "'[]'", 0),
        ("links_json", "TEXT", 1, "'[]'", 0),
        ("created_at", "REAL", 1, None, 0),
        ("updated_at", "REAL", 1, None, 0),
    ),
}


def _roadmap_constraint(message: str) -> BoundaryError:
    return BoundaryError("constraint", message)


def _preflight_roadmap(conn: sqlite3.Connection, *, version: int) -> None:
    objects = {
        row[0]: row[1]
        for row in conn.execute(
            "SELECT name, type FROM sqlite_master WHERE name IN ('roadmap_lanes','roadmap_items')"
        )
    }
    names = set(objects)
    if names and (names != _ROADMAP_TABLES or any(objects[n] != "table" for n in names)):
        error = _RoadmapMigrationConflict("roadmap migration requires both canonical tables")
        error.code = "constraint"
        raise error
    if not names:
        return

    for table, expected in _ROADMAP_COLUMNS.items():
        actual = tuple(
            (row[1], row[2].upper(), row[3], row[4], row[5])
            for row in conn.execute(f"PRAGMA table_info({table})")
        )
        if actual != expected:
            raise _roadmap_constraint(f"{table} has non-canonical columns")

    unique = {}
    for table in _ROADMAP_TABLES:
        for row in conn.execute(f"PRAGMA index_list({table})"):
            if row[2]:
                cols = tuple(r[2] for r in conn.execute(f"PRAGMA index_info({row[1]})"))
                unique.setdefault(table, set()).add(cols)
    if unique.get("roadmap_lanes", set()) != {("id",), ("project_id", "id")}:
        raise _roadmap_constraint("roadmap_lanes unique constraints are non-canonical")
    if unique.get("roadmap_items", set()) != {("id",), ("project_id", "id")}:
        raise _roadmap_constraint("roadmap_items unique constraints are non-canonical")

    table_sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roadmap_items'"
    ).fetchone()[0]
    normalized_sql = "".join((table_sql or "").lower().split())
    required_status_check = (
        "check(statusin('planned','todo','in_progress','blocked','done','cancelled'))"
    )
    if required_status_check not in normalized_sql:
        raise _roadmap_constraint("roadmap_items status constraint is non-canonical")

    for row in conn.execute("SELECT depends_on_json, links_json FROM roadmap_items"):
        for column, field in (
            (row["depends_on_json"], "depends_on"),
            (row["links_json"], "links"),
        ):
            decoded = validate_json_text(column, field=f"roadmap {field}")
            _roadmap_lists(decoded, field)

    indexes = {
        row[1]: tuple(r[2] for r in conn.execute(f"PRAGMA index_info({row[1]})"))
        for row in conn.execute("PRAGMA index_list(roadmap_lanes)")
    }
    if indexes.get("idx_roadmap_lanes_project") != ("project_id", "sort_order", "id"):
        raise _roadmap_constraint("roadmap_lanes project index is missing")
    indexes = {
        row[1]: tuple(r[2] for r in conn.execute(f"PRAGMA index_info({row[1]})"))
        for row in conn.execute("PRAGMA index_list(roadmap_items)")
    }
    if indexes.get("idx_roadmap_items_project") != ("project_id", "lane_id", "sort_order", "id"):
        raise _roadmap_constraint("roadmap_items project index is missing")

    foreign_keys = {
        (row[2], row[3], row[4], row[5], row[6], row[7])
        for row in conn.execute("PRAGMA foreign_key_list(roadmap_items)")
    }
    expected_fk = {
        ("roadmap_lanes", "project_id", "project_id", "RESTRICT", "RESTRICT", "NONE"),
        ("roadmap_lanes", "lane_id", "id", "RESTRICT", "RESTRICT", "NONE"),
    }
    if foreign_keys != expected_fk:
        raise _roadmap_constraint("roadmap_items foreign keys are non-canonical")


def _migrate_v11_roadmap(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    _preflight_roadmap(conn, version=version)
    if version >= 11:
        return
    roadmap_objects = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('roadmap_lanes','roadmap_items')"
        )
    }
    try:
        conn.execute("BEGIN IMMEDIATE")
        if roadmap_objects:
            conn.execute("PRAGMA user_version = 11")
            conn.commit()
            return
        conn.execute("""
            CREATE TABLE roadmap_lanes (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL,
                UNIQUE(project_id, id)
            )
        """)
        conn.execute("CREATE INDEX idx_roadmap_lanes_project ON roadmap_lanes(project_id, sort_order, id)")
        conn.execute("""
            CREATE TABLE roadmap_items (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, lane_id TEXT NOT NULL, title TEXT NOT NULL,
                description TEXT, status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','todo','in_progress','blocked','done','cancelled')),
                sort_order INTEGER NOT NULL DEFAULT 0, depends_on_json TEXT NOT NULL DEFAULT '[]',
                links_json TEXT NOT NULL DEFAULT '[]', created_at REAL NOT NULL, updated_at REAL NOT NULL,
                UNIQUE(project_id, id), FOREIGN KEY(project_id, lane_id) REFERENCES roadmap_lanes(project_id, id)
                    ON DELETE RESTRICT ON UPDATE RESTRICT
            )
        """)
        conn.execute("CREATE INDEX idx_roadmap_items_project ON roadmap_items(project_id, lane_id, sort_order, id)")
        conn.execute("PRAGMA user_version = 11")
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _roadmap_project(project_id):
    return _resolve_project(validate_text(project_id, field="project_id", max_chars=ID_LIMIT))["id"]


def _roadmap_id(value, field):
    return validate_text(value, field=field, max_chars=ID_LIMIT)


def _roadmap_lists(value, field):
    values = [] if value is None else validate_list(value, field=field, max_value_chars=LIST_VALUE_LIMIT - 1)
    encoded = json.dumps(values, separators=(",", ":"), ensure_ascii=False)
    if len(encoded.encode("utf-8")) > JSON_LIMIT:
        raise BoundaryError("invalid_input", f"{field} exceeds its size limit")
    return values, encoded


def _roadmap_row(row):
    if row is None:
        raise BoundaryError("not_found", "resource not found")
    result = dict(row)
    result["depends_on"] = json.loads(result.pop("depends_on_json", "[]")) if "depends_on_json" in result else []
    result["links"] = json.loads(result.pop("links_json", "[]")) if "links_json" in result else []
    return result


def create_roadmap_lane(conn, *, project_id, title, sort_order=0):
    project_id = _roadmap_project(project_id); title = validate_text(title, field="title")
    now = time.time(); lane_id = "rml_" + secrets.token_hex(6)
    conn.execute("INSERT INTO roadmap_lanes VALUES (?, ?, ?, ?, ?, ?)", (lane_id, project_id, title, sort_order, now, now)); conn.commit()
    return dict(conn.execute("SELECT * FROM roadmap_lanes WHERE id = ?", (lane_id,)).fetchone())


def list_roadmap_lanes(conn, *, project_id):
    project_id = _roadmap_project(project_id)
    return [dict(r) for r in conn.execute("SELECT * FROM roadmap_lanes WHERE project_id = ? ORDER BY sort_order, id", (project_id,))]


def update_roadmap_lane(conn, *, project_id, lane_id, title=None, sort_order=None, expected_updated_at=None):
    project_id = _roadmap_project(project_id); lane_id = _roadmap_id(lane_id, "lane_id")
    row = conn.execute("SELECT * FROM roadmap_lanes WHERE id = ? AND project_id = ?", (lane_id, project_id)).fetchone()
    if row is None: raise BoundaryError("not_found", "resource not found")
    if expected_updated_at is not None and row["updated_at"] != expected_updated_at: raise BoundaryError("conflict", "stale or conflicting request")
    updates, values = [], []
    if title is not None: updates += ["title = ?"]; values += [validate_text(title, field="title")]
    if sort_order is not None: updates += ["sort_order = ?"]; values += [sort_order]
    if not updates: return dict(row)
    updates += ["updated_at = ?"]; values += [time.time(), lane_id, project_id]
    conn.execute(f"UPDATE roadmap_lanes SET {', '.join(updates)} WHERE id = ? AND project_id = ?", values); conn.commit()
    return dict(conn.execute("SELECT * FROM roadmap_lanes WHERE id = ? AND project_id = ?", (lane_id, project_id)).fetchone())


def _roadmap_item_target_check(conn, project_id, values):
    for target in values:
        row = conn.execute("SELECT project_id FROM roadmap_items WHERE id = ?", (target,)).fetchone()
        if row is not None and row[0] != project_id:
            raise BoundaryError("not_found", "resource not found")
        if row is None:
            raise BoundaryError("not_found", "resource not found")


def create_roadmap_item(conn, *, project_id, lane_id, title, description=None, status="planned", sort_order=0, depends_on=None, links=None):
    project_id = _roadmap_project(project_id); lane_id = _roadmap_id(lane_id, "lane_id")
    title = validate_text(title, field="title")
    description = None if description is None else validate_text(description, field="description", allow_empty=True)
    if status not in _ROADMAP_STATUSES: raise BoundaryError("invalid_input", "invalid roadmap status")
    depends, depends_json = _roadmap_lists(depends_on, "depends_on"); _, links_json = _roadmap_lists(links, "links")
    _roadmap_item_target_check(conn, project_id, depends)
    if conn.execute("SELECT 1 FROM roadmap_lanes WHERE id = ? AND project_id = ?", (lane_id, project_id)).fetchone() is None: raise BoundaryError("not_found", "resource not found")
    now = time.time(); item_id = "rmi_" + secrets.token_hex(6)
    conn.execute("INSERT INTO roadmap_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (item_id, project_id, lane_id, title, description, status, sort_order, depends_json, links_json, now, now)); conn.commit()
    return _roadmap_row(conn.execute("SELECT * FROM roadmap_items WHERE id = ?", (item_id,)).fetchone())


def list_roadmap_items(conn, *, project_id, lane_id=None):
    project_id = _roadmap_project(project_id)
    if lane_id is None: rows = conn.execute("SELECT * FROM roadmap_items WHERE project_id = ? ORDER BY sort_order, id", (project_id,))
    else: rows = conn.execute("SELECT * FROM roadmap_items WHERE project_id = ? AND lane_id = ? ORDER BY sort_order, id", (project_id, _roadmap_id(lane_id, "lane_id")))
    return [_roadmap_row(r) for r in rows]


def get_roadmap_item(conn, *, project_id, item_id):
    project_id = _roadmap_project(project_id); item_id = _roadmap_id(item_id, "item_id")
    return _roadmap_row(conn.execute("SELECT * FROM roadmap_items WHERE id = ? AND project_id = ?", (item_id, project_id)).fetchone())


def update_roadmap_item(conn, *, project_id, item_id, lane_id=None, title=None, description=None, status=None, sort_order=None, depends_on=None, links=None, clear_depends_on=False, clear_links=False, expected_updated_at=None):
    project_id = _roadmap_project(project_id); item_id = _roadmap_id(item_id, "item_id")
    row = conn.execute("SELECT * FROM roadmap_items WHERE id = ? AND project_id = ?", (item_id, project_id)).fetchone()
    if row is None: raise BoundaryError("not_found", "resource not found")
    if expected_updated_at is not None and row["updated_at"] != expected_updated_at: raise BoundaryError("conflict", "stale or conflicting request")
    updates, values = [], []
    if lane_id is not None:
        lane_id = _roadmap_id(lane_id, "lane_id")
        if conn.execute("SELECT 1 FROM roadmap_lanes WHERE id = ? AND project_id = ?", (lane_id, project_id)).fetchone() is None: raise BoundaryError("not_found", "resource not found")
        updates += ["lane_id = ?"]; values += [lane_id]
    if title is not None: updates += ["title = ?"]; values += [validate_text(title, field="title")]
    if description is not None: updates += ["description = ?"]; values += [validate_text(description, field="description", allow_empty=True)]
    if status is not None:
        if status not in _ROADMAP_STATUSES: raise BoundaryError("invalid_input", "invalid roadmap status")
        updates += ["status = ?"]; values += [status]
    if sort_order is not None: updates += ["sort_order = ?"]; values += [sort_order]
    if clear_depends_on: depends_on = []
    if depends_on is not None:
        depends, encoded = _roadmap_lists(depends_on, "depends_on"); _roadmap_item_target_check(conn, project_id, depends); updates += ["depends_on_json = ?"]; values += [encoded]
    if clear_links: links = []
    if links is not None:
        _, encoded = _roadmap_lists(links, "links"); updates += ["links_json = ?"]; values += [encoded]
    if not updates: return _roadmap_row(row)
    updates += ["updated_at = ?"]; values += [time.time(), item_id, project_id]
    conn.execute(f"UPDATE roadmap_items SET {', '.join(updates)} WHERE id = ? AND project_id = ?", values); conn.commit()
    return get_roadmap_item(conn, project_id=project_id, item_id=item_id)


def _preflight_architecture_legacy(conn: sqlite3.Connection, *, version: int | None = None) -> None:
    """Validate legacy architecture state before any migration can write."""
    if version is None:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
    table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='architecture_diagrams'"
    ).fetchone()
    if table is None:
        return
    assert version is not None

    columns = [tuple(row) for row in conn.execute("PRAGMA table_info(architecture_diagrams)")]
    expected = [
        ("id", "TEXT", 0, None, 1),
        ("project_id", "TEXT", 1, None, 0),
        ("title", "TEXT", 1, None, 0),
        ("nodes_json", "TEXT", 1, None, 0),
        ("edges_json", "TEXT", 1, None, 0),
        ("created_at", "REAL", 1, None, 0),
        ("updated_at", "REAL", 1, None, 0),
    ]
    actual = [(row[1], row[2], row[3], row[4], row[5]) for row in columns]
    if actual != expected:
        raise BoundaryError("constraint", "architecture migration requires canonical table definition")

    rows = conn.execute("SELECT * FROM architecture_diagrams").fetchall()
    known = {(row["project_id"], row["id"]) for row in rows}
    for row in rows:
        try:
            nodes = json.loads(row["nodes_json"])
            edges = json.loads(row["edges_json"])
        except (TypeError, json.JSONDecodeError) as exc:
            raise BoundaryError("constraint", "architecture migration found invalid JSON") from exc
        _validate_architecture_payload(
            row["title"], nodes, edges,
            drill_targets=known,
            project_id=row["project_id"],
        )
    if version < 10:
        raise BoundaryError(
            "constraint",
            "architecture migration refuses a preexisting architecture table in a v9 database",
        )

    indexes = {
        row[1]: (row[2], row[3])
        for row in conn.execute("PRAGMA index_list(architecture_diagrams)")
    }
    unique_columns = {
        tuple(info[2] for info in conn.execute(f"PRAGMA index_info({name!r})"))
        for name, (unique, _origin) in indexes.items()
        if unique
    }
    if ("project_id", "id") not in unique_columns:
        raise BoundaryError("constraint", "architecture migration requires UNIQUE(project_id, id)")
    project_index = indexes.get("idx_architecture_diagrams_project")
    if project_index is None or project_index[0] != 0:
        raise BoundaryError("constraint", "architecture migration requires canonical project index")
    project_index_columns = tuple(
        info[2] for info in conn.execute(
            "PRAGMA index_info('idx_architecture_diagrams_project')"
        )
    )
    if project_index_columns != ("project_id", "updated_at", "id"):
        raise BoundaryError("constraint", "architecture migration requires canonical project index")


def _validate_architecture_payload(title, nodes, edges, *, drill_targets, project_id):
    title = validate_text(title, field="title", max_chars=TEXT_LIMIT)
    if not isinstance(nodes, list) or len(nodes) > 512:
        raise BoundaryError("invalid_input", "nodes must be an array of at most 512 items")
    if not isinstance(edges, list) or len(edges) > 1024:
        raise BoundaryError("invalid_input", "edges must be an array of at most 1024 items")
    node_ids = set()
    clean_nodes = []
    for node in nodes:
        if not isinstance(node, dict) or set(node) not in ({"id", "label", "x", "y"}, {"id", "label", "x", "y", "drill_to_diagram_id"}):
            raise BoundaryError("invalid_input", "each node must have only id, label, x, y, and optional drill target")
        node_id = validate_text(node["id"], field="node id", max_chars=ID_LIMIT)
        if node_id in node_ids:
            raise BoundaryError("invalid_input", "duplicate node id")
        node_ids.add(node_id)
        clean = {"id": node_id, "label": validate_text(node["label"], field="node label", max_chars=TEXT_LIMIT, allow_empty=True), "x": validate_coordinate(node["x"], field="node x"), "y": validate_coordinate(node["y"], field="node y")}
        if "drill_to_diagram_id" in node:
            target = validate_text(node["drill_to_diagram_id"], field="drill target", max_chars=ID_LIMIT)
            if (project_id, target) not in drill_targets:
                raise BoundaryError("not_found", "resource not found")
            clean["drill_to_diagram_id"] = target
        clean_nodes.append(clean)
    clean_edges = []
    for edge in edges:
        if not isinstance(edge, dict) or set(edge) not in ({"source", "target"}, {"source", "target", "label"}):
            raise BoundaryError("invalid_input", "each edge must have only source, target, and optional label")
        source = validate_text(edge["source"], field="edge source", max_chars=ID_LIMIT)
        target = validate_text(edge["target"], field="edge target", max_chars=ID_LIMIT)
        if source not in node_ids or target not in node_ids:
            raise BoundaryError("invalid_input", "edge references missing node")
        clean = {"source": source, "target": target}
        if "label" in edge:
            clean["label"] = validate_text(edge["label"], field="edge label", max_chars=TEXT_LIMIT, allow_empty=True)
        clean_edges.append(clean)
    node_json = json.dumps(clean_nodes, separators=(",", ":"), ensure_ascii=False)
    edge_json = json.dumps(clean_edges, separators=(",", ":"), ensure_ascii=False)
    if len((node_json + edge_json).encode("utf-8")) > JSON_LIMIT:
        raise BoundaryError("invalid_input", "architecture JSON exceeds its size limit")
    return title, clean_nodes, clean_edges


def _architecture_row(row):
    return dict(row)


def _architecture_for_project(conn, project_id, diagram_id):
    project = _resolve_project(project_id)
    row = conn.execute("SELECT * FROM architecture_diagrams WHERE id = ? AND project_id = ?", (diagram_id, project["id"])).fetchone()
    if row is None:
        raise BoundaryError("not_found", "resource not found")
    return row


def add_diagram(conn, project_id, title, nodes, edges):
    project = _resolve_project(project_id)
    known = {(row["project_id"], row["id"]) for row in conn.execute("SELECT project_id, id FROM architecture_diagrams")}
    title, clean_nodes, clean_edges = _validate_architecture_payload(title, nodes, edges, drill_targets=known, project_id=project["id"])
    diagram_id = "arch_" + secrets.token_hex(6)
    now = time.time()
    conn.execute("INSERT INTO architecture_diagrams (id, project_id, title, nodes_json, edges_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", (diagram_id, project["id"], title, json.dumps(clean_nodes, separators=(",", ":"), ensure_ascii=False), json.dumps(clean_edges, separators=(",", ":"), ensure_ascii=False), now, now))
    conn.commit()
    return _architecture_row(_architecture_for_project(conn, project["id"], diagram_id))


def list_diagrams(conn, project_id):
    project = _resolve_project(project_id)
    return [_architecture_row(row) for row in conn.execute("SELECT * FROM architecture_diagrams WHERE project_id = ? ORDER BY updated_at DESC, id", (project["id"],)).fetchall()]


def get_diagram(conn, project_id, diagram_id):
    return _architecture_row(_architecture_for_project(conn, project_id, diagram_id))


def set_diagram(conn, project_id, diagram_id, title=None, nodes=None, edges=None):
    row = _architecture_for_project(conn, project_id, diagram_id)
    new_title = row["title"] if title is None else title
    new_nodes = json.loads(row["nodes_json"]) if nodes is None else nodes
    new_edges = json.loads(row["edges_json"]) if edges is None else edges
    known = {(item["project_id"], item["id"]) for item in conn.execute("SELECT project_id, id FROM architecture_diagrams")}
    new_title, clean_nodes, clean_edges = _validate_architecture_payload(new_title, new_nodes, new_edges, drill_targets=known, project_id=row["project_id"])
    conn.execute("UPDATE architecture_diagrams SET title = ?, nodes_json = ?, edges_json = ?, updated_at = ? WHERE id = ? AND project_id = ?", (new_title, json.dumps(clean_nodes, separators=(",", ":"), ensure_ascii=False), json.dumps(clean_edges, separators=(",", ":"), ensure_ascii=False), time.time(), diagram_id, row["project_id"]))
    conn.commit()
    return _architecture_row(_architecture_for_project(conn, project_id, diagram_id))


def _migrate_v12_mindmap(conn: sqlite3.Connection) -> None:
    """Make spec_nodes authoritative and import legacy hierarchy rows once."""
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    spec_exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='spec_nodes'"
    ).fetchone() is not None
    if not spec_exists:
        return

    columns = {row["name"] for row in conn.execute("PRAGMA table_info(spec_nodes)")}
    required = {"level", "description", "rationale", "metadata_json"}
    if version >= 12 and not required.issubset(columns):
        raise BoundaryError("constraint", "partial v12 mindmap migration is unsupported")
    if version < 12:
        # Preflight before any DDL: invalid legacy data must leave schema,
        # rows, and version untouched.
        legacy = conn.execute(
                "SELECT id, project_id, parent_id, level, title, sort_order, kanban_task_id, "
                "created_at, updated_at, archived FROM hierarchy_nodes ORDER BY project_id, level, sort_order, created_at, id"
        ).fetchall()
        by_id = {row["id"]: row for row in legacy}
        seen_ids = set()
        for row in legacy:
            if row["id"] in seen_ids:
                raise BoundaryError("constraint", f"duplicate hierarchy node {row['id']!r}")
            seen_ids.add(row["id"])
            parent_id = row["parent_id"]
            if parent_id is not None:
                parent = by_id.get(parent_id)
                if parent is None:
                    raise BoundaryError("constraint", f"orphan hierarchy node {row['id']!r}")
                if parent["project_id"] != row["project_id"]:
                    raise BoundaryError("constraint", f"cross-project hierarchy parent {row['id']!r}")
                if int(row["level"]) != int(parent["level"]) + 1:
                    raise BoundaryError("constraint", f"invalid hierarchy level for {row['id']!r}")
            elif int(row["level"]) != 0:
                raise BoundaryError("constraint", f"non-root hierarchy node {row['id']!r}")
            chain = set()
            current = row["id"]
            while current is not None:
                if current in chain:
                    raise BoundaryError("constraint", f"cycle in hierarchy node {row['id']!r}")
                chain.add(current)
                current = by_id[current]["parent_id"] if current in by_id else None
            existing = conn.execute("SELECT * FROM spec_nodes WHERE id = ?", (row["id"],)).fetchone()
            if existing is not None:
                if existing["project_id"] != row["project_id"]:
                    raise BoundaryError("constraint", f"spec node collision for {row['id']!r}")
                if existing["parent_id"] != parent_id or existing["title"] != row["title"] or int(existing["level"] or 0) != int(row["level"]):
                    raise BoundaryError("constraint", f"spec node collision for {row['id']!r}")
                if existing["decision_id"] is not None:
                    raise BoundaryError("constraint", f"decision mismatch for {row['id']!r}")

        planning_rows = None
        if conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='planning_items'"
        ).fetchone() is not None:
            # Rebuild child table after spec_nodes so ALTER TABLE does not
            # retarget its foreign key to spec_nodes_v11.
            _preflight_planning(conn, require_sprint_check=conn.execute("PRAGMA user_version").fetchone()[0] >= 13)
            planning_rows = conn.execute(
                "SELECT id, project_id, spec_node_id, title, status, estimate, sprint, created_at, updated_at "
                "FROM planning_items"
            ).fetchall()

        try:
            conn.execute("BEGIN IMMEDIATE")
            if planning_rows is not None:
                conn.execute("DROP INDEX IF EXISTS idx_planning_items_project")
                conn.execute("DROP TABLE planning_items")
            conn.execute("ALTER TABLE spec_nodes RENAME TO spec_nodes_v11")
            conn.execute("""CREATE TABLE spec_nodes (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('theme','epic','feature','story')),
                parent_id TEXT, level INTEGER NOT NULL DEFAULT 0,
                title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
                note TEXT, description TEXT, rationale TEXT, criteria_json TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}', decision_id TEXT,
                created_at REAL NOT NULL, updated_at REAL NOT NULL,
                UNIQUE(project_id, id),
                FOREIGN KEY(project_id, parent_id) REFERENCES spec_nodes(project_id, id),
                FOREIGN KEY(project_id, decision_id) REFERENCES decisions(project_id, id)
            )""")
            old = {r["name"] for r in conn.execute("PRAGMA table_info(spec_nodes_v11)")}
            def col(name, default):
                return name if name in old else default
            conn.execute(f"""INSERT INTO spec_nodes
                (id, project_id, kind, parent_id, level, title, status, note,
                 description, rationale, criteria_json, metadata_json, decision_id,
                 created_at, updated_at)
                SELECT id, project_id, kind, parent_id, {col('level','0')}, title,
                 status, {col('note','NULL')}, {col('description','NULL')},
                 {col('rationale','NULL')}, {col('criteria_json','NULL')},
                 COALESCE({col('metadata_json',"'{}'" )}, '{{}}'), {col('decision_id','NULL')},
                 created_at, updated_at FROM spec_nodes_v11""")
            conn.execute("DROP TABLE spec_nodes_v11")
            for row in legacy:
                parent_id = row["parent_id"]
                # Legacy hierarchy allowed deeper task levels.  v12 has no
                # task-level spec kinds, so collapse every level >= 3 to the
                # canonical story level while preserving the legacy parent
                # links and row identity.
                normalized_level = min(max(int(row["level"]), 0), 3)
                kind = ("theme", "epic", "feature", "story")[normalized_level]
                if conn.execute("SELECT 1 FROM spec_nodes WHERE id = ?", (row["id"],)).fetchone() is None:
                    conn.execute(
                    "INSERT INTO spec_nodes "
                    "(id, project_id, kind, parent_id, level, title, status, description, rationale, "
                    "metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)",
                    (row["id"], row["project_id"], kind, parent_id, normalized_level, row["title"],
                     "draft", None, None, row["created_at"], row["updated_at"]),
                    )

            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_nodes_project_id_unique ON spec_nodes(project_id, id)")
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_nodes_one_root_per_project ON spec_nodes(project_id) WHERE level = 0 AND parent_id IS NULL")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_spec_nodes_project ON spec_nodes(project_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_spec_nodes_parent ON spec_nodes(project_id, parent_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_spec_nodes_kind ON spec_nodes(project_id, kind)")
            if planning_rows is not None:
                conn.execute(
                    """
                    CREATE TABLE planning_items (
                        id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL,
                        spec_node_id TEXT NOT NULL,
                        title TEXT NOT NULL,
                        status TEXT NOT NULL CHECK(status IN ('backlog','ready','in_progress','done','cancelled')),
                        estimate INTEGER NOT NULL CHECK(estimate IN (1,2,3,5,8,13)),
                        sprint INTEGER NOT NULL CHECK(sprint BETWEEN 1 AND 100000),
                        created_at REAL NOT NULL,
                        updated_at REAL NOT NULL,
                        UNIQUE(project_id, id),
                        FOREIGN KEY(project_id, spec_node_id) REFERENCES spec_nodes(project_id, id)
                            ON DELETE RESTRICT ON UPDATE CASCADE
                    ) STRICT
                    """
                )
                conn.executemany(
                    "INSERT INTO planning_items "
                    "(id, project_id, spec_node_id, title, status, estimate, sprint, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    planning_rows,
                )
                conn.execute(
                    "CREATE INDEX idx_planning_items_project "
                    "ON planning_items(project_id, sprint, status, created_at, id)"
                )
            conn.execute("PRAGMA user_version = 12")
            conn.commit()
        except Exception:
            conn.rollback()
            raise


_PLANNING_STATUSES = ("backlog", "ready", "in_progress", "done", "cancelled")
_PLANNING_ESTIMATES = (1, 2, 3, 5, 8, 13)


def _planning_constraint(message: str) -> BoundaryError:
    return BoundaryError("constraint", message)


def _preflight_planning(conn: sqlite3.Connection, *, require_sprint_check: bool = False) -> None:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'planning_items'"
    ).fetchone()
    if row is None:
        return
    columns = [tuple(item) for item in conn.execute("PRAGMA table_info(planning_items)")]
    expected = [
        ("id", "TEXT", 1, None, 1),
        ("project_id", "TEXT", 1, None, 0),
        ("spec_node_id", "TEXT", 1, None, 0),
        ("title", "TEXT", 1, None, 0),
        ("status", "TEXT", 1, None, 0),
        ("estimate", "INTEGER", 1, None, 0),
        ("sprint", "INTEGER", 1, None, 0),
        ("created_at", "REAL", 1, None, 0),
        ("updated_at", "REAL", 1, None, 0),
    ]
    actual = [(item[1], item[2].upper(), item[3], item[4], item[5]) for item in columns]
    if actual != expected:
        raise _planning_constraint("planning_items has non-canonical columns")
    table_sql = "".join((row[0] or "").lower().split())
    canonical_sqls = tuple(
        "".join(
            """
            CREATE TABLE planning_items (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                spec_node_id TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('backlog','ready','in_progress','done','cancelled')),
                estimate INTEGER NOT NULL CHECK(estimate IN (1,2,3,5,8,13)),
                {sprint_definition}
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                UNIQUE(project_id, id),
                FOREIGN KEY(project_id, spec_node_id) REFERENCES spec_nodes(project_id, id)
                    ON DELETE RESTRICT ON UPDATE CASCADE
            ) STRICT
            """.format(sprint_definition=sprint_definition).lower().split()
        )
        for sprint_definition in (
            "sprint INTEGER NOT NULL,",
            "sprint INTEGER NOT NULL CHECK(sprint BETWEEN 1 AND 100000),",
        )
    )
    if table_sql not in canonical_sqls[1 if require_sprint_check else 0:]:
        raise _planning_constraint("planning_items constraints are non-canonical")
    foreign_keys = {
        (item[2], item[3], item[4], item[5], item[6], item[7])
        for item in conn.execute("PRAGMA foreign_key_list(planning_items)")
    }
    expected_fk = {("spec_nodes", "project_id", "project_id", "CASCADE", "RESTRICT", "NONE"),
                   ("spec_nodes", "spec_node_id", "id", "CASCADE", "RESTRICT", "NONE")}
    if foreign_keys != expected_fk:
        raise _planning_constraint("planning_items foreign key is non-canonical")
    for item in conn.execute("SELECT * FROM planning_items"):
        if item["status"] not in _PLANNING_STATUSES:
            raise _planning_constraint("planning_items contains an invalid status")
        if type(item["estimate"]) is not int or item["estimate"] not in _PLANNING_ESTIMATES:
            raise _planning_constraint("planning_items contains an invalid estimate")
        if type(item["sprint"]) is not int or not 1 <= item["sprint"] <= 100000:
            raise _planning_constraint("planning_items contains an invalid sprint")
        node = conn.execute(
            "SELECT 1 FROM spec_nodes WHERE project_id = ? AND id = ?",
            (item["project_id"], item["spec_node_id"]),
        ).fetchone()
        if node is None:
            raise _planning_constraint("planning_items contains an orphan or cross-project spec node")


def _migrate_v13_scrum_planning(conn: sqlite3.Connection) -> None:
    """Create or repair the strict, project-scoped Scrum Planning table."""
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    _preflight_planning(conn, require_sprint_check=version >= 13)
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'planning_items'"
    ).fetchone()
    if version >= 13 and exists is None:
        raise _planning_constraint("partial v13 Scrum Planning migration is unsupported")
    table_sql = ""
    if exists is not None:
        table_sql = "".join(
            (conn.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'planning_items'"
            ).fetchone()[0] or "").lower().split()
        )
    needs_rebuild = exists is not None and "check(sprintbetween1and100000)" not in table_sql
    if version >= 13 and not needs_rebuild:
        _preflight_planning(conn, require_sprint_check=True)
        return
    planning_rows = None
    try:
        conn.execute("BEGIN IMMEDIATE")
        if needs_rebuild:
            planning_rows = conn.execute(
                "SELECT id, project_id, spec_node_id, title, status, estimate, sprint, created_at, updated_at "
                "FROM planning_items"
            ).fetchall()
            conn.execute("DROP INDEX IF EXISTS idx_planning_items_project")
            conn.execute("DROP TABLE planning_items")
        if exists is None or needs_rebuild:
            conn.execute(
                """
                CREATE TABLE planning_items (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    spec_node_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('backlog','ready','in_progress','done','cancelled')),
                    estimate INTEGER NOT NULL CHECK(estimate IN (1,2,3,5,8,13)),
                    sprint INTEGER NOT NULL CHECK(sprint BETWEEN 1 AND 100000),
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    UNIQUE(project_id, id),
                    FOREIGN KEY(project_id, spec_node_id) REFERENCES spec_nodes(project_id, id)
                        ON DELETE RESTRICT ON UPDATE CASCADE
                ) STRICT
                """
            )
            if planning_rows is not None:
                conn.executemany(
                    "INSERT INTO planning_items "
                    "(id, project_id, spec_node_id, title, status, estimate, sprint, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    planning_rows,
                )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_planning_items_project "
            "ON planning_items(project_id, sprint, status, created_at, id)"
        )
        conn.execute("PRAGMA user_version = 13")
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _migrate_v14_observation_checkpoints(conn: sqlite3.Connection) -> None:
    """Add the human-confirmed checkpoints that anchor the observation log's hash chain."""
    if conn.execute("PRAGMA user_version").fetchone()[0] >= 14:
        return
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS observation_checkpoints (
                id TEXT PRIMARY KEY,
                seq INTEGER NOT NULL CHECK(seq >= 1),
                head_hash TEXT NOT NULL,
                confirmed_by TEXT NOT NULL,
                created_at REAL NOT NULL,
                UNIQUE(seq, head_hash)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_observation_checkpoints_seq "
            "ON observation_checkpoints(seq, created_at)"
        )
        conn.execute("PRAGMA user_version = 14")
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _migrate_v15_days(conn: sqlite3.Connection) -> None:
    """Add the day / block / hour tables behind the daily cadence clock."""
    if conn.execute("PRAGMA user_version").fetchone()[0] >= 15:
        return
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS days (
                id TEXT PRIMARY KEY,
                date TEXT NOT NULL,
                hours_available INTEGER NOT NULL CHECK(hours_available BETWEEN 3 AND 24),
                status TEXT NOT NULL CHECK(status IN ('active', 'ended')),
                started_at REAL NOT NULL,
                ended_at REAL
            )
            """
        )
        # At most one day can be active: the cadence belongs to the person, not a project.
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_days_one_active ON days(status) WHERE status = 'active'")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS blocks (
                id TEXT PRIMARY KEY,
                day_id TEXT NOT NULL REFERENCES days(id) ON DELETE RESTRICT,
                idx INTEGER NOT NULL CHECK(idx >= 1),
                work_hours INTEGER NOT NULL CHECK(work_hours BETWEEN 2 AND 6),
                UNIQUE(day_id, idx)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS hours (
                id TEXT PRIMARY KEY,
                block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE RESTRICT,
                idx INTEGER NOT NULL CHECK(idx >= 1),
                kind TEXT NOT NULL CHECK(kind IN ('retro', 'work')),
                start_ts REAL NOT NULL,
                end_ts REAL NOT NULL CHECK(end_ts > start_ts),
                UNIQUE(block_id, idx)
            )
            """
        )
        conn.execute("PRAGMA user_version = 15")
        conn.commit()
    except Exception:
        conn.rollback()
        raise


_SPEC_ESTIMATES = (1, 2, 3, 5, 8, 13)


def _migrate_v16_spec_readiness(conn: sqlite3.Connection) -> None:
    """Add the Kanban card link and the point estimate to spec nodes."""
    if conn.execute("PRAGMA user_version").fetchone()[0] >= 16:
        return
    try:
        conn.execute("BEGIN IMMEDIATE")
        columns = {row[1] for row in conn.execute("PRAGMA table_info(spec_nodes)")}
        if "kanban_task_id" not in columns:
            conn.execute("ALTER TABLE spec_nodes ADD COLUMN kanban_task_id TEXT")
        if "estimate" not in columns:
            conn.execute(
                "ALTER TABLE spec_nodes ADD COLUMN estimate INTEGER "
                f"CHECK (estimate IS NULL OR estimate IN {_SPEC_ESTIMATES})"
            )
        # A card is linked to at most one node in a project.
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_nodes_kanban_task "
            "ON spec_nodes(project_id, kanban_task_id) WHERE kanban_task_id IS NOT NULL"
        )
        conn.execute("PRAGMA user_version = 16")
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _migrate_v17_spec_node_order(conn: sqlite3.Connection) -> None:
    """Add sort_index to spec_nodes so siblings have an explicit, user-movable
    order instead of relying on created_at/id. Backfills existing rows in
    their current (level, created_at, id) order, grouped by parent, so
    pre-v17 trees keep their visible order after upgrade."""
    if conn.execute("PRAGMA user_version").fetchone()[0] >= 17:
        return
    try:
        conn.execute("BEGIN IMMEDIATE")
        columns = {row[1] for row in conn.execute("PRAGMA table_info(spec_nodes)")}
        if "sort_index" not in columns:
            conn.execute("ALTER TABLE spec_nodes ADD COLUMN sort_index INTEGER NOT NULL DEFAULT 0")
            rows = conn.execute(
                "SELECT id, project_id, parent_id FROM spec_nodes ORDER BY level, created_at, id"
            ).fetchall()
            next_index: dict[tuple[str, str | None], int] = {}
            for row in rows:
                key = (row["project_id"], row["parent_id"])
                idx = next_index.get(key, 0)
                conn.execute("UPDATE spec_nodes SET sort_index = ? WHERE id = ?", (idx, row["id"]))
                next_index[key] = idx + 1
        conn.execute("PRAGMA user_version = 17")
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def init_db(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys=ON")
    if conn.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
        raise RuntimeError("SQLite foreign-key enforcement is required")
    initial_version = conn.execute("PRAGMA user_version").fetchone()[0]
    _preflight_roadmap(conn, version=initial_version)
    _preflight_planning(conn, require_sprint_check=initial_version >= 13)
    if initial_version == 10:
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='architecture_diagrams'"
        ).fetchone()
        if exists is None:
            raise BoundaryError("constraint", "partial v10 architecture migration is unsupported")
    _preflight_architecture_legacy(conn)
    _preflight_risk_tradeoff_legacy(conn)
    _migrate_v6_project_id(conn)  # must run BEFORE CREATE TABLE IF NOT EXISTS below:
    _migrate_v7_hierarchy(conn)
    # a pre-v6 db already has a `decisions` table (old `project` schema), so
    # IF NOT EXISTS would otherwise leave it untouched forever. This drops it
    # first when found, so the CREATE TABLE below always lands the current
    # (project_id) schema on any db that reaches this point.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS decisions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            question TEXT NOT NULL,
            choices_json TEXT NOT NULL,
            recommended TEXT,
            urgency TEXT NOT NULL DEFAULT 'normal',
            created_at REAL NOT NULL,
            resolved_choice TEXT,
            resolved_at REAL
        )
        """
    )
    _migrate_v2_columns(conn)
    _migrate_v3_columns(conn)
    _migrate_v4_columns(conn)
    _migrate_v5_columns(conn)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_decisions_pending ON decisions(resolved_at, created_at)")
    # Real column (not just a computed index on json_extract(card_payload_json,
    # '$.batch_id')) for portability/clarity — see _migrate_v4_columns. NULLs
    # are distinct under SQLite UNIQUE semantics, so non-batch_approval rows
    # (batch_id always NULL) never collide with each other or with a real
    # batch_id; only two rows sharing the same (project_id, batch_id) collide,
    # which is exactly the F3 fix.
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_batch_id_unique "
        "ON decisions(project_id, batch_id) WHERE batch_id IS NOT NULL"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS problem_reports (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            problem TEXT NOT NULL,
            context TEXT,
            reporter TEXT,
            created_at REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            decision_id TEXT,
            triage_error TEXT,
            triaged_at REAL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reports_pending ON problem_reports(status, created_at)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS spec_nodes (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('theme','epic','feature','story')),
            parent_id TEXT,
            level INTEGER NOT NULL DEFAULT 0,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            note TEXT,
            description TEXT,
            rationale TEXT,
            criteria_json TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            decision_id TEXT,
            sort_index INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            UNIQUE(project_id, id),
            FOREIGN KEY(project_id, parent_id) REFERENCES spec_nodes(project_id, id),
            FOREIGN KEY(project_id, decision_id) REFERENCES decisions(project_id, id)
        )
        """
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_project_id_unique ON decisions(project_id, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_spec_nodes_project ON spec_nodes(project_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_spec_nodes_parent ON spec_nodes(project_id, parent_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_spec_nodes_kind ON spec_nodes(project_id, kind)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_nodes_project_id_unique ON spec_nodes(project_id, id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS hud_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )
    _migrate_v8_stage2_risk_tradeoffs(conn)
    _migrate_v9_flowcharts(conn)
    _migrate_v10_architecture(conn)
    _migrate_v11_roadmap(conn)
    _migrate_v12_mindmap(conn)
    _migrate_v13_scrum_planning(conn)
    _migrate_v14_observation_checkpoints(conn)
    _migrate_v15_days(conn)
    _migrate_v16_spec_readiness(conn)
    _migrate_v17_spec_node_order(conn)
    conn.commit()


def get_setting(conn: sqlite3.Connection, key: str, default: Optional[str] = None) -> Optional[str]:
    row = conn.execute("SELECT value FROM hud_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO hud_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()


def _migrate_v2_columns(conn: sqlite3.Connection) -> None:
    """Idempotently add the v2 card_type/card_payload_json/resolved_payload_json
    columns to a pre-existing decisions table (sqlite has no ALTER TABLE ADD
    COLUMN IF NOT EXISTS, so check PRAGMA table_info first).

    Also repairs PRAGMA user_version, which was never bumped when these
    columns were originally added live (found reporting 0 against an
    already-v2 schema — the DDL succeeded, the version bookkeeping just never
    ran). Version is derived from actual column presence, not incremented
    blindly, so this is safe to run against a db in any real state."""
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(decisions)").fetchall()}
    for col in ("card_type", "card_payload_json", "resolved_payload_json"):
        if col not in existing:
            conn.execute(f"ALTER TABLE decisions ADD COLUMN {col} TEXT")
    conn.commit()
    post = {row["name"] for row in conn.execute("PRAGMA table_info(decisions)").fetchall()}
    if {"card_type", "card_payload_json", "resolved_payload_json"} <= post:
        current_version = conn.execute("PRAGMA user_version").fetchone()[0]
        if current_version < 2:
            conn.execute("PRAGMA user_version = 2")
            conn.commit()


def _migrate_v3_columns(conn: sqlite3.Connection) -> None:
    """Idempotently add the v3 defer columns to a pre-existing decisions
    table, matching _migrate_v2_columns's exact pattern (PRAGMA table_info
    check first, since sqlite has no ADD COLUMN IF NOT EXISTS). Column types
    differ per-column here (TEXT/REAL/INTEGER) unlike v2's all-TEXT set, so
    each gets its own ALTER TABLE statement with the right type/default."""
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(decisions)").fetchall()}
    if "defer_log_json" not in existing:
        conn.execute("ALTER TABLE decisions ADD COLUMN defer_log_json TEXT")
    if "last_deferred_at" not in existing:
        conn.execute("ALTER TABLE decisions ADD COLUMN last_deferred_at REAL")
    if "defer_count" not in existing:
        conn.execute("ALTER TABLE decisions ADD COLUMN defer_count INTEGER NOT NULL DEFAULT 0")
    conn.commit()
    post = {row["name"] for row in conn.execute("PRAGMA table_info(decisions)").fetchall()}
    if {"defer_log_json", "last_deferred_at", "defer_count"} <= post:
        current_version = conn.execute("PRAGMA user_version").fetchone()[0]
        if current_version < 3:
            conn.execute("PRAGMA user_version = 3")
            conn.commit()


def _migrate_v4_columns(conn: sqlite3.Connection) -> None:
    """Idempotently add the v4 columns (F2/F3 remediation), matching
    _migrate_v2_columns/_migrate_v3_columns's exact pattern:

    - batch_id: a REAL column (not just json_extract(card_payload_json,
      '$.batch_id')) extracted at insert time by push_batch_approval(),
      so a plain UNIQUE index can enforce (project, batch_id) durably at
      the database layer instead of relying on an app-level
      check-then-insert (the F3 TOCTOU race). NULL for every non-
      batch_approval row.
    - resolved_by: the actor identity recorded by resolve_decision() on
      every successful resolution (F2 authorization requirement) —
      resolved_at already carries the timestamp half.

    Any pre-existing batch_approval rows are backfilled from their
    card_payload_json so the new UNIQUE index (created in init_db, after
    this migration runs) doesn't silently exempt old data from the
    duplicate-batch_id guarantee.
    """
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(decisions)").fetchall()}
    if "batch_id" not in existing:
        conn.execute("ALTER TABLE decisions ADD COLUMN batch_id TEXT")
    if "resolved_by" not in existing:
        conn.execute("ALTER TABLE decisions ADD COLUMN resolved_by TEXT")
    conn.commit()
    if "batch_id" not in existing:
        # Backfill from the pre-v4 source of truth (card_payload_json) for
        # rows that predate this column.
        conn.execute(
            "UPDATE decisions SET batch_id = json_extract(card_payload_json, '$.batch_id') "
            "WHERE card_type = 'batch_approval' AND batch_id IS NULL"
        )
        conn.commit()
    post = {row["name"] for row in conn.execute("PRAGMA table_info(decisions)").fetchall()}
    if {"batch_id", "resolved_by"} <= post:
        current_version = conn.execute("PRAGMA user_version").fetchone()[0]
        if current_version < 4:
            conn.execute("PRAGMA user_version = 4")
            conn.commit()


def _migrate_v5_columns(conn: sqlite3.Connection) -> None:
    """v5 adds NO new columns to `decisions` — the existing card_type/
    card_payload_json/resolved_payload_json/batch_id columns (from v2/v4)
    are sufficient to carry a card_type='missing_constraint' row (Rule 4's
    PO-escalation-on-2nd-failure mechanism; see push_missing_constraint/
    require_constraint_resolved below). Per critique_08's hard cap of 3
    schema-fragmentation mechanisms, this rides on the SAME decisions table
    exactly like batch_approval (v4) and escalation_necessity (piggybacked
    on resolved_payload_json) do — no new table, no new column.

    Still follows the exact _migrate_v2_columns/_migrate_v3_columns/
    _migrate_v4_columns pattern for consistency and so PRAGMA user_version
    stays a reliable single source of truth for "which migrations have run"
    even when a migration is schema-inert: version only advances past 4 once
    the v4 prerequisite columns it depends on (card_type, batch_id) are
    confirmed present, and only once, matching the idempotent style used
    throughout this file.
    """
    post = {row["name"] for row in conn.execute("PRAGMA table_info(decisions)").fetchall()}
    if {"card_type", "card_payload_json", "resolved_payload_json", "batch_id"} <= post:
        current_version = conn.execute("PRAGMA user_version").fetchone()[0]
        if current_version < 5:
            conn.execute("PRAGMA user_version = 5")
            conn.commit()


def _migrate_v6_project_id(conn: sqlite3.Connection) -> None:
    """v6 breaking cutover (owner decision, 2026-09-12): the free-text
    `project` column is REPLACED by `project_id`, which every push now
    validates against the real projects.db (see _resolve_project). Per the
    owner's explicit instruction, this is NOT a backfill — any pre-v6
    `decisions`/`problem_reports` rows are disposable test data and are
    dropped by recreating the tables, not migrated column-by-column. A
    fresh install (no `project` column present) is a no-op here; only a
    genuinely pre-v6 db pays the drop-and-recreate cost, and only once
    (guarded by PRAGMA user_version like every other migration in this
    file)."""
    current_version = conn.execute("PRAGMA user_version").fetchone()[0]
    if current_version >= 6:
        return
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(decisions)").fetchall()}
    if "project" in existing:
        conn.execute("DROP TABLE IF EXISTS decisions")
        conn.execute("DROP TABLE IF EXISTS problem_reports")
        conn.commit()
    conn.execute("PRAGMA user_version = 6")
    conn.commit()


def _actor_token_dir() -> Path:
    d = _hermes_home() / "decision_hud" / "actor_tokens"
    d.mkdir(parents=True, exist_ok=True)
    return d


_ACTOR_TOKEN_DEFAULT_TTL_SECONDS = 8 * 60 * 60  # one desktop-pane session's worth


class NotAuthorized(RuntimeError):
    """Raised by resolve_decision() when the caller lacks a valid actor_token
    or is running in a delegated-child process context (see module
    docstring). Distinct from returning None (not-found) or raising
    ValueError (bad input) so a caller can't mistake a rejected resolution
    for either of those."""


def _actor_token_path(token_hash: str) -> Path:
    return _actor_token_dir() / f"{token_hash[:32]}.json"


def issue_actor_token(actor: str, *, ttl_seconds: int = _ACTOR_TOKEN_DEFAULT_TTL_SECONDS) -> str:
    """Mint a new per-session capability token for the interactive resolution
    path (desktop pane on startup, or a human at the CLI). This is the
    minimal-but-real auth mechanism required by F2: resolve_decision()
    refuses to run without a currently-valid token from here.

    Returns the raw token string — this is the ONLY time the raw value is
    ever available; only its SHA-256 hash is persisted to disk, in a file
    created with mode 0600 (owner read/write only) so only processes
    running as the same OS user (the desktop pane / its cliExec children,
    or an interactive CLI session) can read it back. This is a real,
    file-permission-enforced restriction against OTHER OS users on a
    shared machine; within the single OS user Hermes normally runs as, the
    delegated-child-process check (see _is_delegated_child_process_context)
    is the independent gate that stops a subagent/worker from resolving
    even if it could technically read the token file.
    """
    if not actor or not actor.strip():
        raise ValueError("actor is required to issue a token")
    raw = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    now = time.time()
    record = {
        "actor": actor.strip(),
        "token_hash": token_hash,
        "issued_at": now,
        "expires_at": now + max(1, int(ttl_seconds)),
    }
    path = _actor_token_path(token_hash)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(record, f)
    return raw


def _validate_actor_token(token: Optional[str]) -> Optional[str]:
    """Return the actor identity if `token` is a currently-valid, unexpired
    token minted by issue_actor_token(); None for anything else (missing,
    malformed, unknown, or expired — resolve_decision() treats all of these
    identically: reject). An expired token's record is opportunistically
    cleaned up."""
    if not token or not token.strip():
        return None
    token_hash = hashlib.sha256(token.strip().encode("utf-8")).hexdigest()
    path = _actor_token_path(token_hash)
    if not path.exists():
        return None
    try:
        record = json.loads(path.read_text())
    except Exception:
        return None
    if record.get("token_hash") != token_hash:
        return None
    if float(record.get("expires_at", 0)) < time.time():
        try:
            path.unlink()
        except OSError:
            pass
        return None
    actor = record.get("actor")
    return actor if isinstance(actor, str) and actor else None


_OVERRIDE_AUDIT_LOG_TTL_SECONDS = 30 * 60  # short-lived: this is a break-glass mechanic


def issue_owner_override_token(reason: str, *, ttl_seconds: int = _OVERRIDE_AUDIT_LOG_TTL_SECONDS) -> str:
    """Break-glass override for resolve_decision()'s actor-token gate, for use
    ONLY when the owner (Ian) has explicitly instructed the orchestrating
    agent, in the current conversation, to resolve a decision on their behalf
    because the normal interactive path (desktop pane / `hermes decision
    issue-token`) is unavailable to them. This is not a permissions gap the
    agent may reach for on its own initiative — every call site MUST be able
    to cite the specific owner instruction that authorized it.

    Deliberately distinct from issue_actor_token(), not a wrapper around it,
    so the two paths can never be confused:
      - actor identity is ALWAYS "AGENT_OVERRIDE:<reason>" (never a plain
        human-looking name), so `resolved_by` on any row resolved this way
        is unmistakably greppable as an override, never mistaken for a real
        interactive resolution.
      - every mint is appended (never overwritten) to a standalone,
        independent audit log (override_audit.log) recording the FULL,
        unslugged reason and timestamp — recoverable even where `resolved_by`
        alone would be too terse to explain why.
      - short default TTL (30 min, vs. the normal 8-hour session TTL) since
        this is meant to authorize one specific resolution, not stand in for
        an ongoing interactive session.
      - still fully subject to resolve_decision()'s existing, UNMODIFIED
        _is_delegated_child_process_context() check — a dispatched subagent
        holding an override token is refused exactly like one holding a
        normal token; this mechanic only ever extends the top-level
        orchestrating session's own authority, never a subagent's.
    """
    if not reason or not reason.strip():
        raise ValueError("reason is required for an owner-override token (must cite the owner's explicit instruction)")
    reason = reason.strip()
    actor = f"AGENT_OVERRIDE:{reason[:80]}"
    raw = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    now = time.time()
    record = {
        "actor": actor,
        "token_hash": token_hash,
        "issued_at": now,
        "expires_at": now + max(1, int(ttl_seconds)),
    }
    path = _actor_token_path(token_hash)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(record, f)

    audit_dir = _hermes_home() / "decision_hud"
    audit_dir.mkdir(parents=True, exist_ok=True)
    audit_path = audit_dir / "override_audit.log"
    audit_entry = {"actor": actor, "reason": reason, "issued_at": now}
    with open(audit_path, "a") as f:
        f.write(json.dumps(audit_entry) + "\n")

    return raw


def revoke_actor_token(token: str) -> None:
    """Best-effort revoke (desktop pane teardown, e.g.). Missing/unknown
    tokens are a silent no-op — revoke is idempotent."""
    if not token or not token.strip():
        return
    token_hash = hashlib.sha256(token.strip().encode("utf-8")).hexdigest()
    path = _actor_token_path(token_hash)
    try:
        path.unlink()
    except OSError:
        pass


def _row_to_dict(row: sqlite3.Row, _proj: Optional[dict[str, str]] = None) -> dict[str, Any]:
    """Row -> API dict. A JSON-decode failure on a stored *_json column is a
    data-corruption event, not "this field is legitimately empty" — the two
    must stay distinguishable to a caller. Each JSON field below falls back
    to the same empty value it always did (never raises out of this
    function), but any column whose stored text was non-empty and still
    failed to parse gets its name appended to d["_corrupt_fields"] (present
    only when at least one such failure occurred, so existing callers that
    never check for it see no behavior change).

    Also joins in project_slug/project_name from the live projects.db (v6):
    display fields are never duplicated into the decisions table, so a
    project rename is reflected immediately. Pass `_proj` (already-resolved
    {"id","slug","name"}) to skip the extra lookup when the caller already
    has it (push_decision does, right after validating); otherwise this
    resolves it itself, tolerating a project that's since been deleted.
    """
    d = dict(row)
    corrupt: list[str] = []

    proj = _proj
    if proj is None and d.get("project_id"):
        try:
            proj = _resolve_project(d["project_id"])
        except ValueError:
            proj = {"id": d["project_id"], "slug": "(deleted project)", "name": "(deleted project)"}
    if proj is not None:
        d["project_slug"] = proj["slug"]
        d["project_name"] = proj["name"]

    raw_choices = d.pop("choices_json")
    try:
        d["choices"] = json.loads(raw_choices or "[]")
    except Exception:
        d["choices"] = []
        if raw_choices:
            corrupt.append("choices_json")

    raw_card_payload = d.pop("card_payload_json", None)
    try:
        d["card_payload"] = json.loads(raw_card_payload) if raw_card_payload else None
    except Exception:
        d["card_payload"] = None
        corrupt.append("card_payload_json")

    raw_resolved_payload = d.pop("resolved_payload_json", None)
    try:
        d["resolved_payload"] = json.loads(raw_resolved_payload) if raw_resolved_payload else None
    except Exception:
        d["resolved_payload"] = None
        corrupt.append("resolved_payload_json")

    raw_defer_log = d.pop("defer_log_json", None)
    try:
        d["defer_log"] = json.loads(raw_defer_log) if raw_defer_log else []
    except Exception:
        d["defer_log"] = []
        corrupt.append("defer_log_json")

    if corrupt:
        d["_corrupt_fields"] = corrupt
    return d


# --- card_type verification: makes the decision-hud-cards taxonomy load-
# bearing instead of advisory prose in a skill doc. Ported directly from
# card-type-gate's scripts/card_type_selector.py (kept in sync manually;
# see that skill's own comment mirroring this one) so push_decision() can
# enforce it server-side: a caller may no longer just assert a card_type
# string, it must also supply the bucket + discriminant answers, and the
# SAME deterministic rule engine must resolve those answers to exactly the
# claimed card_type or the push is rejected. This is the same rationale
# `require_batch_approval` applies to Rule 1 — a UI-only convention (a
# skill doc an agent can skip) was explicitly rejected as insufficient.
_CARD_TYPE_RULES: list[tuple[str, str, dict]] = [
    # v2 taxonomy (2026-10): buckets are now a value_type x cardinality cut
    # (continuous/categorical/ordinal/relational/compound x single/
    # independent/constrained) instead of 12 ad-hoc per-shape names. See
    # docs/card-type-decision-tree.md for the full rationale and flowchart.
    # `info_only` is the one bucket outside that grid -- a pre-gate checked
    # before value_type even applies ("is anything being decided at all").
    ("context_readout", "info_only", {"is_pure_context_no_decision": True}),

    # continuous x single
    ("range_slider", "continuous_single", {"is_interval_not_point": True}),
    ("confidence_rating", "continuous_single",
     {"is_interval_not_point": False, "needs_confidence_axis": True}),
    ("anchor_adjust", "continuous_single",
     {"is_interval_not_point": False, "needs_confidence_axis": False, "has_safe_defaults_to_confirm": True}),
    ("scalar_slider", "continuous_single",
     {"is_interval_not_point": False, "needs_confidence_axis": False, "has_safe_defaults_to_confirm": False}),

    # continuous x independent -- one card type, no discriminants needed
    # (an empty requires dict resolves unconditionally once this bucket is
    # chosen, same mechanism "compound_single" below uses).
    ("rating_grid", "continuous_independent", {}),

    # continuous x constrained
    ("stacked_bar_split", "continuous_constrained",
     {"is_fixed_total_split": True, "prefers_visual_segments": True}),
    ("constrained_budget_split", "continuous_constrained",
     {"is_fixed_total_split": True, "prefers_visual_segments": False}),
    ("spider_compare", "continuous_constrained",
     {"is_fixed_total_split": False, "is_multi_axis_no_dominant": True}),
    ("ranked_score", "continuous_constrained",
     {"is_fixed_total_split": False, "is_multi_axis_no_dominant": False}),

    # categorical x single
    ("binary_toggle", "categorical_single", {"is_simple_boolean": True}),
    ("quad_choice", "categorical_single",
     {"is_simple_boolean": False, "is_and_or_neither_logic": True}),
    ("zone_select", "categorical_single",
     {"is_simple_boolean": False, "is_and_or_neither_logic": False, "is_quantized_few_levels": True}),
    ("mode_radial_gauge", "categorical_single",
     {"is_simple_boolean": False, "is_and_or_neither_logic": False, "is_quantized_few_levels": False,
      "cross_card_reactive": True}),
    ("mcq_context", "categorical_single",
     {"is_simple_boolean": False, "is_and_or_neither_logic": False, "is_quantized_few_levels": False,
      "cross_card_reactive": False}),

    # categorical x independent
    ("multi_select", "categorical_independent", {"is_independent_subset": True}),
    ("tree_placement", "categorical_independent",
     {"is_independent_subset": False, "is_tree_not_flat": True}),
    ("matrix_2x2", "categorical_independent",
     {"is_independent_subset": False, "is_tree_not_flat": False, "is_two_axis_grid": True}),
    ("assemble_pieces", "categorical_independent",
     {"is_independent_subset": False, "is_tree_not_flat": False, "is_two_axis_grid": False,
      "is_one_choice_per_slot": True}),
    ("sort_to_bin", "categorical_independent",
     {"is_independent_subset": False, "is_tree_not_flat": False, "is_two_axis_grid": False,
      "is_one_choice_per_slot": False}),

    # categorical x constrained
    ("balance_scale", "categorical_constrained", {"is_exactly_two_options": True}),
    ("pairwise_duel", "categorical_constrained",
     {"is_exactly_two_options": False, "is_many_options_reduce": True}),
    ("spotlight_pick", "categorical_constrained",
     {"is_exactly_two_options": False, "is_many_options_reduce": False}),

    # ordinal x constrained (single/independent are structurally N/A --
    # ordinal needs >=2 related items by definition)
    ("timeline_placement", "ordinal_constrained", {"is_absolute_dates_not_relative": True}),
    ("sequence_order", "ordinal_constrained", {"is_absolute_dates_not_relative": False}),

    # relational x constrained (single/independent are structurally N/A --
    # relational needs >=2 related items by definition)
    ("precedence_graph", "relational_constrained", {"is_single_set_relation": True}),
    ("wire_match", "relational_constrained",
     {"is_single_set_relation": False, "one_to_one_sets": True}),
    ("venn_overlap", "relational_constrained",
     {"is_single_set_relation": False, "one_to_one_sets": False, "is_shared_vs_exclusive": True}),
    ("cluster_overlap", "relational_constrained",
     {"is_single_set_relation": False, "one_to_one_sets": False, "is_shared_vs_exclusive": False,
      "is_group_membership_not_pairing": True}),
    ("bipartite_assign", "relational_constrained",
     {"is_single_set_relation": False, "one_to_one_sets": False, "is_shared_vs_exclusive": False,
      "is_group_membership_not_pairing": False}),

    # compound x single -- a value that's several linked fields (a date
    # range, a schedule, a color), not one scalar and not one category.
    # One card type, no discriminants needed (same empty-dict mechanism as
    # continuous_independent above).
    ("field_group", "compound_single", {}),
]


def _card_type_verdict(bucket: str, answers: dict) -> dict:
    """Same contract as card-type-gate's verdict(): status in
    {resolved, ambiguous, no_match, incomplete}, matches = [(card_type, ...)].
    `answers` here is bucket-scoped (no "bucket" key inside it — the bucket
    is passed separately since push_decision already validates it)."""
    bucket_rules = [(ct, reqs) for ct, b, reqs in _CARD_TYPE_RULES if b == bucket]
    if not bucket_rules:
        return {"status": "no_match", "open_questions": [], "matches": []}
    # A rule with an empty requires dict (continuous_independent's
    # rating_grid, compound_single's field_group) resolves unconditionally
    # here -- needed/open_qs/hits below all fall out correctly for an empty
    # dict with no special-case needed (all(() for k,v in {}.items()) is
    # vacuously True), same as every other rule.
    needed = {q for _, reqs in bucket_rules for q in reqs}
    open_qs = sorted(q for q in needed if q not in answers)
    if open_qs:
        return {"status": "incomplete", "open_questions": open_qs, "matches": []}
    hits = [ct for ct, reqs in bucket_rules if all(answers.get(k) == v for k, v in reqs.items())]
    if len(hits) == 0:
        return {"status": "no_match", "open_questions": [], "matches": []}
    if len(hits) > 1:
        return {"status": "ambiguous", "open_questions": [], "matches": [(h, "") for h in hits]}
    return {"status": "resolved", "open_questions": [], "matches": [(hits[0], "")]}


def parse_json_kwarg(raw: Optional[str], field_name: str) -> Optional[dict]:
    """Parse an optional JSON-string kwarg (MCP tool params and argparse CLI
    flags both pass structured data as JSON text, never a native dict/list —
    see GAP G2). Returns None if raw is falsy. Raises ValueError with a
    field-name-qualified message on invalid JSON, so callers can surface a
    consistent {"ok": False, "error": ...} without duplicating this
    try/except at every one of the (now 4, previously 3) call sites that
    accept a JSON-bearing string field (card_payload_json, --card-payload,
    --payload, and card_type_answers_json)."""
    if not raw:
        return None
    try:
        return validate_json_text(raw, field=field_name)
    except BoundaryError as exc:
        raise ValueError(str(exc)) from exc


def _verify_card_type(card_type: Optional[str], bucket: Optional[str], answers: Optional[dict]) -> None:
    """Raises ValueError unless the deterministic engine resolves
    (bucket, answers) to exactly card_type. Called from push_decision()
    only when card_type is set; a push with no card_type at all skips this
    entirely (plain button-list decisions never needed classifying)."""
    if bucket is None or answers is None:
        raise ValueError(
            f"card_type={card_type!r} was given without card_type_bucket/card_type_answers — "
            "a card_type may no longer be asserted directly; run it through the card-type-gate "
            "discriminant engine (bucket + answers) so the classification is verifiable, not asserted")
    result = _card_type_verdict(bucket, dict(answers))
    if result["status"] == "incomplete":
        raise ValueError(
            f"card_type_answers incomplete for bucket {bucket!r}: missing {result['open_questions']} — "
            "resolve every discriminant before pushing, never push with a partial answer set")
    if result["status"] == "no_match":
        raise ValueError(
            f"card_type_bucket {bucket!r} with the given answers matched no card_type — "
            "fall back to card_type=None (plain list) or card_type='mcq_context', don't assert a guess")
    if result["status"] == "ambiguous":
        matched = [m[0] for m in result["matches"]]
        raise ValueError(
            f"card_type_bucket {bucket!r} with the given answers is ambiguous between {matched} — "
            "narrow the answers until exactly one card_type resolves")
    resolved_card_type = result["matches"][0][0]
    if resolved_card_type != card_type:
        raise ValueError(
            f"claimed card_type {card_type!r} does not match the engine's resolved card_type "
            f"{resolved_card_type!r} for bucket {bucket!r} — the discriminant answers say this "
            f"decision is a {resolved_card_type!r}, not a {card_type!r}")


def push_decision(
    conn: sqlite3.Connection, *, project_id: str, question: str, choices: list[str],
    recommended: Optional[str] = None, urgency: str = "normal",
    card_type: Optional[str] = None, card_payload: Optional[dict] = None,
    card_type_bucket: Optional[str] = None, card_type_answers: Optional[dict] = None,
) -> dict[str, Any]:
    """Insert a new pending decision. Caller (MCP server) owns write authority.

    project_id must reference a real row in the projects.db store (see
    _resolve_project) — raises ValueError otherwise. This is a v6 breaking
    change: free-text project tags are no longer accepted (owner decision,
    2026-09-12; existing free-text rows were disposable test data, dropped
    by the v6 migration, not carried forward).

    card_type/card_payload are optional rendering hints for the
    decision-hud-cards skill (e.g. card_type="balance_scale"); they never
    replace question/choices, which remain the durable plain-text fallback
    any renderer (including the built-in desktop pane) can always show.

    If card_type is set, card_type_bucket and card_type_answers are now
    REQUIRED and are run through the same deterministic engine card-type-
    gate's CLI uses — the push is rejected unless they resolve to exactly
    the claimed card_type. This is what makes card-shape selection
    load-bearing rather than a skill doc an agent could skip; see
    _verify_card_type() above.
    """
    proj = _resolve_project(project_id)
    question = validate_text(question, field="question")
    choices = validate_list(choices or [], field="choices", max_items=4,
                            max_value_chars=LIST_VALUE_LIMIT)
    if not (2 <= len(choices) <= 4):
        raise BoundaryError("invalid_input", "choices must have between 2 and 4 entries")
    if recommended is not None and recommended not in choices:
        raise ValueError("recommended must be one of choices")
    if card_type is not None:
        _verify_card_type(card_type, card_type_bucket, card_type_answers)
    # Capture the calling chat (if any) so a resolution can be delivered back
    # to whoever asked, even for a standalone push with no originating kanban
    # task — see kanban_decision_resolution_sweeper.py, which now also acts
    # on _origin_platform/_origin_chat_id. Gateway-set per-session env vars;
    # empty/absent for CLI-only or desktop-only sessions (nothing to send to).
    import os
    origin_platform = os.environ.get("HERMES_SESSION_PLATFORM", "").strip()
    origin_chat_id = os.environ.get("HERMES_SESSION_CHAT_ID", "").strip()
    if origin_platform and origin_chat_id:
        card_payload = dict(card_payload or {})
        card_payload.setdefault("_origin_platform", origin_platform)
        card_payload.setdefault("_origin_chat_id", origin_chat_id)
        thread_id = os.environ.get("HERMES_SESSION_THREAD_ID", "").strip()
        if thread_id:
            card_payload.setdefault("_origin_thread_id", thread_id)
    urgency = urgency if urgency in _VALID_URGENCY else "normal"
    did = uuid.uuid4().hex[:12]
    now = time.time()
    conn.execute(
        "INSERT INTO decisions (id, project_id, question, choices_json, recommended, urgency, created_at, "
        "card_type, card_payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (did, proj["id"], question.strip(), json.dumps(choices), recommended, urgency, now,
         card_type, json.dumps(card_payload) if card_payload is not None else None),
    )
    conn.commit()
    return _row_to_dict(conn.execute("SELECT * FROM decisions WHERE id = ?", (did,)).fetchone(), proj)


def list_pending(conn: sqlite3.Connection, *, project_id: Optional[str] = None, limit: int = 5) -> list[dict[str, Any]]:
    """Oldest-high-urgency-first pending decisions, optionally filtered to one
    project. Within the same urgency tier, a decision that was deferred at
    least once sorts AFTER every non-deferred decision of that tier (deferred
    rows are ordered among themselves oldest-deferred-first) — a defer never
    removes the row from this list, it only pushes it politely to the back of
    its urgency tier so fresher/never-looked-at items surface first."""
    urgency_rank = "CASE urgency WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END"
    deferred_rank = "CASE WHEN last_deferred_at IS NULL THEN 0 ELSE 1 END"
    if project_id:
        rows = conn.execute(
            f"SELECT * FROM decisions WHERE resolved_at IS NULL AND project_id = ? "
            f"ORDER BY {urgency_rank} ASC, {deferred_rank} ASC, created_at ASC LIMIT ?",
            (project_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            f"SELECT * FROM decisions WHERE resolved_at IS NULL "
            f"ORDER BY {urgency_rank} ASC, {deferred_rank} ASC, created_at ASC LIMIT ?",
            (limit,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def list_projects(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Every project (from the real projects.db store) that has at least one
    pending decision, with its pending count and display slug/name. Unlike
    pre-v6, this reflects the actual Project record, not a free-text tag —
    a project rename is picked up immediately since slug/name are joined in
    at read time, never duplicated into the decisions table."""
    rows = conn.execute(
        "SELECT project_id, COUNT(*) AS pending FROM decisions WHERE resolved_at IS NULL "
        "GROUP BY project_id ORDER BY project_id"
    ).fetchall()
    out = []
    for r in rows:
        try:
            proj = _resolve_project(r["project_id"])
        except ValueError:
            # A project was deleted out from under existing decisions rows —
            # surface it rather than hiding the pending count silently.
            proj = {"id": r["project_id"], "slug": "(deleted project)", "name": "(deleted project)"}
        out.append({"project_id": r["project_id"], "slug": proj["slug"], "name": proj["name"], "pending": r["pending"]})
    return out


def resolve_decision(
    conn: sqlite3.Connection, decision_id: str, choice: str,
    payload: Optional[dict] = None, *, actor_token: str,
) -> Optional[dict[str, Any]]:
    """Record the chosen answer (must match one of the stored choices, or be
    free-text if the row allows 'Other' — v1 accepts any non-empty string).

    payload, if given, is a structured result from a decision-hud-cards card
    (e.g. {"winner": "postgres", "tally": {...}} from Balance Scale). choice
    must still be a non-empty human-readable summary string even when payload
    is set, so every consumer (including plain-text-only readers) always has
    something legible.

    F2 authorization (STRICT, per owner decision): resolving ANY decision —
    including a batch_approval row, which is what actually gates dispatch —
    requires a real authenticated actor identity. Two independent,
    fail-closed gates, both must pass, checked BEFORE touching the row:

      1. Not a delegated-child process. `_is_delegated_child_process_context()`
         mirrors hermes-agent's delegate_task child signal
         (HERMES_DELEGATED_CHILD_CONTEXT); a dispatched subagent/worker (or
         any subprocess it spawns) is rejected outright, even holding a
         technically-valid actor_token — no self-approval path exists.
      2. `actor_token` validates. Must be a currently-valid, unexpired token
         from issue_actor_token() (the interactive-only resolution path: the
         desktop pane mints one at session start; `hermes decision
         issue-token` covers the interactive CLI). No token, an unknown
         token, or an expired one are all rejected identically.

    Raises NotAuthorized (never silently returns None) on either gate
    failing, so a caller can't mistake "not authorized" for "not found".
    The resolving identity is recorded on the row as `resolved_by` alongside
    the existing `resolved_at` timestamp.
    """
    if _is_delegated_child_process_context():
        raise NotAuthorized(
            "resolve_decision() refused: running in a delegated-child process context "
            f"({_DELEGATED_CHILD_ENV_MARKER} is set) — a dispatched subagent/worker may never "
            "resolve a decision (including batch_approval rows); this is not a permissions gap "
            "to route around, it is the control")
    actor = _validate_actor_token(actor_token)
    if actor is None:
        raise NotAuthorized(
            "resolve_decision() refused: missing, unknown, or expired actor_token — obtain one "
            "via the interactive resolution path (issue_actor_token(); desktop pane session start "
            "or `hermes decision issue-token`) before resolving")
    row = conn.execute("SELECT * FROM decisions WHERE id = ?", (decision_id,)).fetchone()
    if row is None:
        return None
    if row["resolved_at"] is not None:
        return _row_to_dict(row)  # idempotent re-resolve returns the existing state
    if not choice or not choice.strip():
        raise ValueError("choice is required")
    conn.execute(
        "UPDATE decisions SET resolved_choice = ?, resolved_at = ?, resolved_payload_json = ?, "
        "resolved_by = ? WHERE id = ?",
        (choice.strip(), time.time(), json.dumps(payload) if payload is not None else None,
         actor, decision_id),
    )
    conn.commit()
    return _row_to_dict(conn.execute("SELECT * FROM decisions WHERE id = ?", (decision_id,)).fetchone())


def get_decision(conn: sqlite3.Connection, decision_id: str) -> Optional[dict[str, Any]]:
    row = conn.execute("SELECT * FROM decisions WHERE id = ?", (decision_id,)).fetchone()
    return _row_to_dict(row) if row else None


def defer_decision(
    conn: sqlite3.Connection, decision_id: str, note: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Record a 'looked at it, skipping for now' signal — deliberately NOT a
    resolution: resolved_choice/resolved_at are never touched here, so the
    row stays in list_pending() forever until someone actually resolves it.

    Appends {"deferred_at": <now>, "note": note} to defer_log_json (append-
    only, so the full skip history survives repeated defers), and bumps the
    plain last_deferred_at/defer_count columns so list_pending's ORDER BY
    tiebreak doesn't need to parse JSON on every call.

    Raises ValueError if the decision is already resolved (a resolved
    decision isn't 'pending, skipped for now' — deferring it is meaningless
    since it will never surface in list_pending again regardless) or if it
    doesn't exist (returns None, matching get_decision's not-found shape)."""
    row = conn.execute("SELECT * FROM decisions WHERE id = ?", (decision_id,)).fetchone()
    if row is None:
        return None
    if row["resolved_at"] is not None:
        raise ValueError(f"decision {decision_id!r} is already resolved; defer only applies to pending decisions")
    log = []
    if row["defer_log_json"]:
        try:
            log = json.loads(row["defer_log_json"])
        except Exception:
            log = []
    now = time.time()
    log.append({"deferred_at": now, "note": note})
    conn.execute(
        "UPDATE decisions SET defer_log_json = ?, last_deferred_at = ?, defer_count = defer_count + 1 WHERE id = ?",
        (json.dumps(log), now, decision_id),
    )
    conn.commit()
    return _row_to_dict(conn.execute("SELECT * FROM decisions WHERE id = ?", (decision_id,)).fetchone())


# --- batch_approval: Rule 1 (PO backlog gate) mechanism ---------------------
#
# A batch_approval decision is a decisions row like any other (same table,
# same push/list/resolve path) with card_type="batch_approval" and a
# card_payload carrying {"batch_id": ..., "task_list": [...]}. What makes it
# load-bearing rather than cosmetic is require_batch_approval() below: any
# orchestrating session MUST call it before dispatch, and it raises (not
# just logs) when the batch isn't found or isn't resolved "approved". This
# is the "real dispatch-side enforcement" the 50-agent review required —
# a UI card alone was explicitly rejected as insufficient.

class BatchNotApproved(RuntimeError):
    """Raised by require_batch_approval() when dispatch must not proceed."""


def push_batch_approval(
    conn: sqlite3.Connection, *, project_id: str, batch_id: str, task_list: list[str],
    urgency: str = "normal",
) -> dict[str, Any]:
    """Push a batch_approval-typed decision. `batch_id` must be unique per
    project (enforced by a database-level UNIQUE index on
    (project_id, batch_id) — see _migrate_v4_columns/init_db — not just an
    app-level SELECT-then-INSERT check, which was a real TOCTOU race
    under concurrent pushes; F3): raises ValueError on a duplicate open OR
    resolved batch_id for the same project, so a caller can't silently
    re-push and fork the approval record.

    The check+insert runs inside one transaction so two concurrent callers
    racing the same (project_id, batch_id) can't both pass the pre-check; the
    UNIQUE index is the actual guarantee (sqlite3.IntegrityError from a
    losing INSERT is caught and converted to the same ValueError), the
    pre-check is only there to give a normal single-caller duplicate a
    clean message without depending on constraint-violation text.
    """
    if not batch_id or not batch_id.strip():
        raise ValueError("batch_id is required")
    batch_id = batch_id.strip()
    proj = _resolve_project(project_id)
    dup_msg = f"batch_id {batch_id!r} already has a decision row for project {proj['slug']!r}"
    question = f"Approve batch {batch_id} for dispatch? ({len(task_list)} task(s))"
    choices = ["approve", "reject"]
    card_payload = {"batch_id": batch_id, "task_list": list(task_list)}
    try:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            "SELECT id FROM decisions WHERE project_id = ? AND card_type = 'batch_approval' "
            "AND batch_id = ?",
            (proj["id"], batch_id),
        ).fetchone()
        if existing is not None:
            conn.execute("ROLLBACK")
            raise ValueError(dup_msg)
        did = uuid.uuid4().hex[:12]
        now = time.time()
        try:
            conn.execute(
                "INSERT INTO decisions (id, project_id, question, choices_json, recommended, urgency, "
                "created_at, card_type, card_payload_json, batch_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (did, proj["id"], question, json.dumps(choices), "approve", urgency, now,
                 "batch_approval", json.dumps(card_payload), batch_id),
            )
        except sqlite3.IntegrityError:
            conn.execute("ROLLBACK")
            raise ValueError(dup_msg)
        conn.commit()
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.OperationalError:
            pass  # nothing open to roll back (e.g. the ValueError path already rolled back)
        raise
    return _row_to_dict(conn.execute("SELECT * FROM decisions WHERE id = ?", (did,)).fetchone(), proj)


def get_batch_approval(conn: sqlite3.Connection, *, project_id: str, batch_id: str) -> Optional[dict[str, Any]]:
    """Look up by project id OR slug (see _resolve_project) — get/require
    callers commonly only know the human slug (e.g. kanban's
    batch_approval_gate.project), same as push_batch_approval()."""
    proj = _resolve_project(project_id)
    row = conn.execute(
        "SELECT * FROM decisions WHERE project_id = ? AND card_type = 'batch_approval' "
        "AND batch_id = ? ORDER BY created_at ASC LIMIT 1",
        (proj["id"], batch_id),
    ).fetchone()
    return _row_to_dict(row, proj) if row else None


def mark_escalation_necessity(
    conn: sqlite3.Connection, decision_id: str, *, was_necessary: bool, note: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Retro-time judgment call (MVP metric per the scoped-adoption decision):
    for an already-resolved, non-batch_approval decision, record whether the
    PO judges in retro that this escalation should have been resolved
    without reaching them. Stored in resolved_payload_json under an
    'escalation_necessity' key so it rides on the existing table/column —
    no new table, matching the review's schema-fragmentation cap."""
    row = conn.execute("SELECT * FROM decisions WHERE id = ?", (decision_id,)).fetchone()
    if row is None:
        return None
    if row["resolved_at"] is None:
        raise ValueError("cannot mark escalation necessity on an unresolved decision")
    payload = {}
    if row["resolved_payload_json"]:
        try:
            payload = json.loads(row["resolved_payload_json"])
        except Exception:
            # Distinguish "this decision never had a resolved_payload" from
            # "the stored JSON was corrupt and we're discarding it" — the
            # latter must not look like ordinary empty data (see F9).
            payload = {"_corrupt_previous_payload": row["resolved_payload_json"]}
    payload["escalation_necessity"] = {"was_necessary": bool(was_necessary), "note": note, "marked_at": time.time()}
    conn.execute(
        "UPDATE decisions SET resolved_payload_json = ? WHERE id = ?",
        (json.dumps(payload), decision_id),
    )
    conn.commit()
    return _row_to_dict(conn.execute("SELECT * FROM decisions WHERE id = ?", (decision_id,)).fetchone())


def escalation_necessity_rate(conn: sqlite3.Connection, *, project_id: Optional[str] = None) -> dict[str, Any]:
    """Fraction of retro-marked escalations judged unnecessary, plus raw
    counts. Only counts decisions that actually got a retro mark — unmarked
    resolved decisions are excluded, not assumed necessary or unnecessary."""
    if project_id:
        rows = conn.execute(
            "SELECT resolved_payload_json FROM decisions WHERE project_id = ? AND resolved_at IS NOT NULL "
            "AND (card_type IS NULL OR card_type != 'batch_approval') AND resolved_payload_json IS NOT NULL",
            (project_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT resolved_payload_json FROM decisions WHERE resolved_at IS NOT NULL "
            "AND (card_type IS NULL OR card_type != 'batch_approval') AND resolved_payload_json IS NOT NULL",
        ).fetchall()
    marked = 0
    unnecessary = 0
    for r in rows:
        try:
            payload = json.loads(r["resolved_payload_json"] or "{}")
        except Exception:
            continue
        en = payload.get("escalation_necessity")
        if not isinstance(en, dict) or "was_necessary" not in en:
            continue
        marked += 1
        if not en["was_necessary"]:
            unnecessary += 1
    rate = (unnecessary / marked) if marked else None
    return {"marked_count": marked, "unnecessary_count": unnecessary, "escalation_necessity_rate": rate}


def require_batch_approval(conn: sqlite3.Connection, *, project_id: str, batch_id: str) -> dict[str, Any]:
    """Dispatch-side gate. Call this immediately before dispatching any batch's
    work. Raises BatchNotApproved unless a batch_approval row for this exact
    (project_id, batch_id) exists AND resolved_choice == "approve". No proxy,
    no timeout — an absent or pending row fails closed, exactly like a
    rejected one. Returns the resolved decision dict on success."""
    row = get_batch_approval(conn, project_id=project_id, batch_id=batch_id)
    if row is None:
        raise BatchNotApproved(
            f"no batch_approval decision exists for project_id={project_id!r} batch_id={batch_id!r}; "
            "push one with push_batch_approval() and wait for PO resolution before dispatching")
    if row["resolved_choice"] is None:
        raise BatchNotApproved(
            f"batch {batch_id!r} (project_id={project_id!r}) is still pending PO approval; do not dispatch")
    if row["resolved_choice"] != "approve":
        raise BatchNotApproved(
            f"batch {batch_id!r} (project_id={project_id!r}) was resolved {row['resolved_choice']!r}, not 'approve'; do not dispatch")
    return row


# --- missing_constraint: Rule 4 (PO-escalation-on-2nd-failure) mechanism ----
#
# A missing_constraint decision is a decisions row like any other (same
# table, same push/list/resolve path as batch_approval) with
# card_type="missing_constraint" and a card_payload carrying
# {"task_id": ..., "question": ...}. No new table (v5 adds zero columns —
# see _migrate_v5_columns) per critique_08's hard cap of 3 schema-
# fragmentation mechanisms; this is the 3rd, after batch_approval (v4) and
# escalation_necessity (piggybacked on resolved_payload_json).
#
# Design choice — duplicate pushes for the same (project, task_id) — DOCUMENTED:
# push_missing_constraint() RAISES ValueError if an UNRESOLVED
# missing_constraint row already exists for this (project, task_id), mirroring
# push_batch_approval's raise-on-duplicate-open-batch behavior: a retried
# escalation call (e.g. a flaky caller re-invoking the same MCP tool) must
# not silently fork multiple open PO questions for one task. Once that row is
# resolved, a LATER push for the same task_id IS allowed — a task can
# legitimately hit an independent second missing-constraint escalation after
# the first was answered — and require_constraint_resolved() always gates on
# the MOST RECENT row for that task_id, so an old resolved row never masks a
# fresh unresolved escalation (fail-closed, same spirit as require_batch_approval).

class ConstraintNotResolved(RuntimeError):
    """Raised by require_constraint_resolved() when work must not proceed."""


def push_missing_constraint(
    conn: sqlite3.Connection, *, project_id: str, task_id: str, question: str,
    urgency: str = "normal",
) -> dict[str, Any]:
    """Push a missing_constraint-typed decision — Rule 4's PO-escalation
    mechanism: an agent that fails twice on the same task for lack of a
    constraint/spec answer escalates here instead of guessing or looping.

    Raises ValueError if an unresolved missing_constraint row already exists
    for this exact (project_id, task_id) — see the module-comment above for
    the documented duplicate-handling choice. The check+insert runs inside
    one transaction (matching push_batch_approval's TOCTOU-safe pattern) so
    two concurrent callers racing the same (project_id, task_id) can't both
    push.
    """
    if not task_id or not task_id.strip():
        raise ValueError("task_id is required")
    if not question or not question.strip():
        raise ValueError("question is required")
    proj = _resolve_project(project_id)
    task_id = task_id.strip()
    dup_msg = (
        f"task_id {task_id!r} (project={proj['slug']!r}) already has an unresolved "
        "missing_constraint decision; resolve it before pushing another"
    )
    choices = ["resolved", "cannot_resolve"]
    card_payload = {"task_id": task_id, "question": question.strip()}
    try:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            "SELECT id FROM decisions WHERE project_id = ? AND card_type = 'missing_constraint' "
            "AND json_extract(card_payload_json, '$.task_id') = ? AND resolved_at IS NULL",
            (proj["id"], task_id),
        ).fetchone()
        if existing is not None:
            conn.execute("ROLLBACK")
            raise ValueError(dup_msg)
        did = uuid.uuid4().hex[:12]
        now = time.time()
        conn.execute(
            "INSERT INTO decisions (id, project_id, question, choices_json, recommended, urgency, "
            "created_at, card_type, card_payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (did, proj["id"], question.strip(), json.dumps(choices), None, urgency, now,
             "missing_constraint", json.dumps(card_payload)),
        )
        conn.commit()
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.OperationalError:
            pass  # nothing open to roll back (e.g. the ValueError path already rolled back)
        raise
    return _row_to_dict(conn.execute("SELECT * FROM decisions WHERE id = ?", (did,)).fetchone(), proj)


def get_missing_constraint(conn: sqlite3.Connection, *, project_id: str, task_id: str) -> Optional[dict[str, Any]]:
    """Most recent missing_constraint row for this (project_id, task_id),
    resolved or not — see module comment: gating always looks at the
    LATEST row so an old resolved escalation never masks a fresh one.
    Looks up by project id OR slug (see _resolve_project), same as
    push_missing_constraint()."""
    proj = _resolve_project(project_id)
    row = conn.execute(
        "SELECT * FROM decisions WHERE project_id = ? AND card_type = 'missing_constraint' "
        "AND json_extract(card_payload_json, '$.task_id') = ? ORDER BY created_at DESC LIMIT 1",
        (proj["id"], task_id),
    ).fetchone()
    return _row_to_dict(row, proj) if row else None


def require_constraint_resolved(conn: sqlite3.Connection, *, project_id: str, task_id: str) -> dict[str, Any]:
    """Fail-closed gate mirroring require_batch_approval()'s exact pattern.
    Call this before proceeding with work that was blocked on a missing
    constraint. Raises ConstraintNotResolved unless a missing_constraint row
    for this exact (project_id, task_id) exists AND is resolved (any resolved
    choice counts — 'resolved' or 'cannot_resolve' — both mean the PO looked
    at it and the block is lifted; the resolved_choice value itself tells the
    caller which). No proxy, no timeout — an absent or still-pending row
    fails closed. Returns the resolved decision dict on success."""
    row = get_missing_constraint(conn, project_id=project_id, task_id=task_id)
    if row is None:
        raise ConstraintNotResolved(
            f"no missing_constraint decision exists for project_id={project_id!r} task_id={task_id!r}; "
            "push one with push_missing_constraint() and wait for PO resolution before proceeding")
    if row["resolved_choice"] is None:
        raise ConstraintNotResolved(
            f"missing_constraint for task_id={task_id!r} (project_id={project_id!r}) is still pending PO "
            "resolution; do not proceed")
    return row


# --- Raw problem reports (pre-triage) ---------------------------------------

def push_problem_report(
    conn: sqlite3.Connection, *, project_id: str, problem: str,
    context: Optional[str] = None, reporter: Optional[str] = None,
) -> dict[str, Any]:
    """Insert a raw, unstructured problem report awaiting board-agent triage."""
    proj = _resolve_project(project_id)
    if not problem or not problem.strip():
        raise ValueError("problem is required")
    rid = uuid.uuid4().hex[:12]
    now = time.time()
    conn.execute(
        "INSERT INTO problem_reports (id, project_id, problem, context, reporter, created_at, status) "
        "VALUES (?, ?, ?, ?, ?, ?, 'pending')",
        (rid, proj["id"], problem.strip(), context, reporter, now),
    )
    conn.commit()
    return dict(conn.execute("SELECT * FROM problem_reports WHERE id = ?", (rid,)).fetchone())


def list_pending_reports(conn: sqlite3.Connection, limit: int = 20) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM problem_reports WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?", (limit,)
    ).fetchall()
    return [dict(r) for r in rows]


def get_problem_report(conn: sqlite3.Connection, report_id: str) -> Optional[dict[str, Any]]:
    row = conn.execute("SELECT * FROM problem_reports WHERE id = ?", (report_id,)).fetchone()
    return dict(row) if row else None


def mark_report_triaged(conn: sqlite3.Connection, report_id: str, decision_id: str) -> None:
    conn.execute(
        "UPDATE problem_reports SET status = 'triaged', decision_id = ?, triaged_at = ? WHERE id = ?",
        (decision_id, time.time(), report_id),
    )
    conn.commit()


def mark_report_failed(conn: sqlite3.Connection, report_id: str, error: str) -> None:
    conn.execute(
        "UPDATE problem_reports SET status = 'triage_failed', triage_error = ?, triaged_at = ? WHERE id = ?",
        (error, time.time(), report_id),
    )
    conn.commit()


def _planning_project(conn: sqlite3.Connection, project_id: str) -> str:
    del conn
    return _resolve_project(validate_text(project_id, field="project_id", max_chars=ID_LIMIT))["id"]


def _planning_values(*, title: str, status: str, estimate: int, sprint: int) -> tuple[str, str, int, int]:
    title = validate_text(title, field="title", max_chars=TEXT_LIMIT)
    if status not in _PLANNING_STATUSES:
        raise BoundaryError("invalid_input", "invalid planning status")
    if type(estimate) is not int or estimate not in _PLANNING_ESTIMATES:
        raise BoundaryError("invalid_input", "estimate must be one of 1, 2, 3, 5, 8, or 13")
    if type(sprint) is not int or isinstance(sprint, bool) or sprint < 1 or sprint > 100000:
        raise BoundaryError("invalid_input", "sprint must be an integer from 1 through 100000")
    return title, status, estimate, sprint


def _planning_node(conn: sqlite3.Connection, project_id: str, spec_node_id: str) -> str:
    spec_node_id = validate_text(spec_node_id, field="spec_node_id", max_chars=ID_LIMIT)
    row = conn.execute(
        "SELECT project_id FROM spec_nodes WHERE id = ?", (spec_node_id,)
    ).fetchone()
    if row is None:
        raise BoundaryError("not_found", "resource not found")
    if row["project_id"] != project_id:
        raise BoundaryError("not_found", "resource not found")
    return spec_node_id


def create_planning_item(conn: sqlite3.Connection, *, project_id: str, spec_node_id: str,
                         title: str, status: str = "backlog", estimate: int = 1,
                         sprint: int = 1) -> dict[str, Any]:
    project = _planning_project(conn, project_id)
    spec_node = _planning_node(conn, project, spec_node_id)
    title, status, estimate, sprint = _planning_values(
        title=title, status=status, estimate=estimate, sprint=sprint
    )
    item_id = "pi_" + secrets.token_hex(6)
    now = time.time()
    conn.execute(
        "INSERT INTO planning_items "
        "(id, project_id, spec_node_id, title, status, estimate, sprint, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (item_id, project, spec_node, title, status, estimate, sprint, now, now),
    )
    conn.commit()
    return dict(conn.execute("SELECT * FROM planning_items WHERE id = ?", (item_id,)).fetchone())


def list_planning_items(conn: sqlite3.Connection, *, project_id: str) -> list[dict[str, Any]]:
    project = _planning_project(conn, project_id)
    rows = conn.execute(
        "SELECT planning_items.* "
        "FROM planning_items "
        "WHERE planning_items.project_id = ? ORDER BY sprint, created_at, id",
        (project,),
    ).fetchall()
    return [dict(row) for row in rows]


def update_planning_item(conn: sqlite3.Connection, *, project_id: str, item_id: str,
                         title: str | None = None, status: str | None = None,
                         estimate: int | None = None, sprint: int | None = None) -> dict[str, Any]:
    project = _planning_project(conn, project_id)
    item_id = validate_text(item_id, field="item_id", max_chars=ID_LIMIT)
    row = conn.execute(
        "SELECT * FROM planning_items WHERE id = ? AND project_id = ?", (item_id, project)
    ).fetchone()
    if row is None:
        raise BoundaryError("not_found", "resource not found")
    next_title = row["title"] if title is None else title
    next_status = row["status"] if status is None else status
    next_estimate = row["estimate"] if estimate is None else estimate
    next_sprint = row["sprint"] if sprint is None else sprint
    next_title, next_status, next_estimate, next_sprint = _planning_values(
        title=next_title, status=next_status, estimate=next_estimate, sprint=next_sprint
    )
    conn.execute(
        "UPDATE planning_items SET title = ?, status = ?, estimate = ?, sprint = ?, updated_at = ? "
        "WHERE id = ? AND project_id = ?",
        (next_title, next_status, next_estimate, next_sprint, time.time(), item_id, project),
    )
    conn.commit()
    return dict(conn.execute("SELECT * FROM planning_items WHERE id = ?", (item_id,)).fetchone())


def delete_planning_item(conn: sqlite3.Connection, *, project_id: str, item_id: str) -> dict[str, Any]:
    project = _planning_project(conn, project_id)
    item_id = validate_text(item_id, field="item_id", max_chars=ID_LIMIT)
    row = conn.execute(
        "SELECT * FROM planning_items WHERE id = ? AND project_id = ?", (item_id, project)
    ).fetchone()
    if row is None:
        raise BoundaryError("not_found", "resource not found")
    conn.execute("DELETE FROM planning_items WHERE id = ? AND project_id = ?", (item_id, project))
    conn.commit()
    return dict(row)


_SPEC_KINDS = ("theme", "epic", "feature", "story")
_SPEC_STATUSES = ("draft", "ready", "converted")


def _spec_validate_parent(conn: sqlite3.Connection, *, project_id: str,
                           parent_id: str | None, level: int) -> None:
    if level == 0:
        if parent_id is not None:
            raise BoundaryError("invalid_input", "level 0 root cannot have a parent")
        return
    if parent_id is None:
        raise BoundaryError("invalid_input", "non-root nodes require a parent")
    parent = conn.execute(
        "SELECT project_id, kind, level FROM spec_nodes WHERE id = ?", (parent_id,)
    ).fetchone()
    if parent is None:
        raise BoundaryError("not_found", "parent node not found")
    if parent["project_id"] != project_id:
        raise BoundaryError("not_found", "parent node belongs to another project")
    expected_kind = _SPEC_KINDS[level - 1]
    if parent["level"] != level - 1 or parent["kind"] != expected_kind:
        raise BoundaryError("invalid_input", "parent must be exactly one level above and have the compatible kind")


def _spec_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    result = dict(row)
    try:
        result["metadata"] = json.loads(result.pop("metadata_json"))
    except (TypeError, json.JSONDecodeError):
        raise ValueError(f"invalid metadata_json for spec node {result.get('id')!r}")
    return result


def _spec_project(project_id: str) -> str:
    return _resolve_project(validate_text(project_id, field="project_id", max_chars=ID_LIMIT))["id"]


def _spec_validate_decision(conn: sqlite3.Connection, project_id: str, decision_id: str | None) -> None:
    if decision_id is None:
        return
    row = conn.execute("SELECT project_id FROM decisions WHERE id = ?", (decision_id,)).fetchone()
    if row is None or row["project_id"] != project_id:
        raise BoundaryError("not_found", "decision does not belong to project")


_READY_KINDS = ("feature", "story")
MAX_READY_ESTIMATE = 5  # points; bigger than this does not fit one hour of fleet work (a hypothesis the trial tunes)


def spec_readiness(*, kind: str, criteria_json: str | None, estimate: int | None) -> dict[str, Any]:
    """Definition of Ready for a spec node: can it be committed to an hour?

    Applies to features and stories only; a theme or epic is never "ready".
    Checks acceptance criteria, an estimate, and the size rule. Not checked yet:
    dependencies (they move onto spec nodes with the Plan screen) and noted risks
    (they attach to nodes later), so a node can pass here and still need those.
    """
    if kind not in _READY_KINDS:
        return {"applies": False, "ready": True, "checks": []}
    try:
        parsed = json.loads(criteria_json) if criteria_json else []
    except (TypeError, ValueError):
        parsed = None
    valid = isinstance(parsed, list) and bool(parsed) and all(isinstance(c, str) and c.strip() for c in parsed)
    checks = [{
        "name": "criteria", "passed": valid,
        "detail": f"{len(parsed)} acceptance criteria" if valid else "needs at least one acceptance criterion",
    }, {
        "name": "estimate", "passed": estimate is not None,
        "detail": f"{estimate} points" if estimate is not None else "needs an estimate",
    }]
    if estimate is not None:
        fits = estimate <= MAX_READY_ESTIMATE
        checks.append({
            "name": "size", "passed": fits,
            "detail": f"fits one hour (at most {MAX_READY_ESTIMATE} points)" if fits
            else f"{estimate} points is too big for one hour; split it to {MAX_READY_ESTIMATE} or fewer",
        })
    return {"applies": True, "ready": all(check["passed"] for check in checks), "checks": checks}


def spec_node_readiness(conn: sqlite3.Connection, node_id: str, *, project_id: str | None = None) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM spec_nodes WHERE id = ?", (node_id,)).fetchone()
    if row is None or (project_id is not None and row["project_id"] != _spec_project(project_id)):
        raise BoundaryError("not_found", "resource not found")
    return spec_readiness(kind=row["kind"], criteria_json=row["criteria_json"], estimate=row["estimate"])


def create_spec_node(
    conn: sqlite3.Connection, *, project_id: str, kind: str, title: str,
    parent_id: str | None = None, level: int | None = None, status: str = "draft",
    note: str | None = None, description: str | None = None, rationale: str | None = None,
    criteria_json: str | None = None, metadata_json: str = "{}", decision_id: str | None = None,
) -> dict[str, Any]:
    project_id = _spec_project(project_id)
    kind = validate_text(kind, field="kind", max_chars=16)
    if kind not in _SPEC_KINDS:
        raise BoundaryError("invalid_input", "invalid spec node kind")
    title = validate_text(title, field="title")
    status = validate_text(status, field="status", max_chars=16)
    if status not in _SPEC_STATUSES:
        raise BoundaryError("invalid_input", "invalid spec node status")
    if level is None:
        level = _SPEC_KINDS.index(kind)
    if isinstance(level, bool) or not isinstance(level, int) or not 0 <= level <= 3:
        raise BoundaryError("invalid_input", "level must be an integer from 0 through 3")
    if level != _SPEC_KINDS.index(kind):
        raise BoundaryError("invalid_input", "kind and level must match")

    note = None if note is None else validate_text(note, field="note", allow_empty=True)
    description = None if description is None else validate_text(description, field="description", allow_empty=True)
    rationale = None if rationale is None else validate_text(rationale, field="rationale", allow_empty=True)
    metadata = validate_json_text(metadata_json, field="metadata_json")
    if not isinstance(metadata, dict):
        raise BoundaryError("invalid_input", "metadata_json must be an object")
    if criteria_json is not None:
        validate_json_text(criteria_json, field="criteria_json")
    _spec_validate_decision(conn, project_id, decision_id)
    node_id = "sn_" + secrets.token_hex(6)
    now = time.time()
    try:
        conn.execute("BEGIN IMMEDIATE")
        _spec_validate_parent(conn, project_id=project_id, parent_id=parent_id, level=level)
        next_sort_index = conn.execute(
            "SELECT COALESCE(MAX(sort_index), -1) + 1 FROM spec_nodes WHERE project_id = ? AND parent_id IS ?",
            (project_id, parent_id),
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO spec_nodes (id, project_id, kind, parent_id, level, title, status, note, description, rationale, criteria_json, metadata_json, decision_id, sort_index, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (node_id, project_id, kind, parent_id, level, title, status, note, description, rationale,
             criteria_json, json.dumps(metadata, separators=(",", ":"), ensure_ascii=False), decision_id,
             next_sort_index, now, now),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _spec_row(conn.execute("SELECT * FROM spec_nodes WHERE id = ?", (node_id,)).fetchone())


def update_spec_node(conn: sqlite3.Connection, node_id: str, *, project_id: str | None = None, **fields: Any) -> dict[str, Any]:
    allowed = {"title", "status", "note", "description", "rationale", "criteria_json", "metadata_json", "parent_id", "level", "kind", "decision_id", "kanban_task_id", "estimate"}
    unknown = set(fields) - allowed
    if unknown:
        raise BoundaryError("invalid_input", f"immutable or unsupported node fields: {sorted(unknown)}")
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM spec_nodes WHERE id = ?", (node_id,)).fetchone()
        if row is None or (project_id is not None and row["project_id"] != _spec_project(project_id)):
            raise BoundaryError("not_found", "resource not found")
        if "kind" in fields and fields["kind"] not in _SPEC_KINDS:
            raise BoundaryError("invalid_input", "invalid spec node kind")
        if "status" in fields and fields["status"] not in _SPEC_STATUSES:
            raise BoundaryError("invalid_input", "invalid spec node status")
        if "title" in fields:
            fields["title"] = validate_text(fields["title"], field="title")
        for name in ("note", "description", "rationale"):
            if name in fields and fields[name] is not None:
                fields[name] = validate_text(fields[name], field=name, allow_empty=True)
        if "metadata_json" in fields:
            value = validate_json_text(fields["metadata_json"], field="metadata_json")
            if not isinstance(value, dict):
                raise BoundaryError("invalid_input", "metadata_json must be an object")
            fields["metadata_json"] = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
        if "criteria_json" in fields:
            validate_json_text(fields["criteria_json"], field="criteria_json")
        if "level" in fields and (isinstance(fields["level"], bool) or not isinstance(fields["level"], int) or not 0 <= fields["level"] <= 3):
            raise BoundaryError("invalid_input", "level must be an integer from 0 through 3")
        if "decision_id" in fields:
            _spec_validate_decision(conn, row["project_id"], fields["decision_id"])
        if "estimate" in fields and fields["estimate"] is not None and (
            isinstance(fields["estimate"], bool) or not isinstance(fields["estimate"], int)
            or fields["estimate"] not in _SPEC_ESTIMATES
        ):
            raise BoundaryError("invalid_input", f"estimate must be one of {list(_SPEC_ESTIMATES)}")
        if "kanban_task_id" in fields and fields["kanban_task_id"] is not None:
            fields["kanban_task_id"] = validate_text(fields["kanban_task_id"], field="kanban_task_id", max_chars=ID_LIMIT)
            holder = conn.execute(
                "SELECT id, title FROM spec_nodes WHERE project_id = ? AND kanban_task_id = ? AND id != ?",
                (row["project_id"], fields["kanban_task_id"], node_id),
            ).fetchone()
            if holder is not None:
                raise BoundaryError("conflict", f"that Kanban task is already linked to {holder['title']!r} ({holder['id']})")
        effective_kind = fields.get("kind", row["kind"])
        if fields.get("status") == "ready" and row["status"] != "ready":
            readiness = spec_readiness(
                kind=effective_kind,
                criteria_json=fields.get("criteria_json", row["criteria_json"]),
                estimate=fields.get("estimate", row["estimate"]),
            )
            if not readiness["ready"]:
                failed = "; ".join(f"{c['name']}: {c['detail']}" for c in readiness["checks"] if not c["passed"])
                raise BoundaryError("constraint", f"not ready: {failed}")
        effective_level = fields.get("level", row["level"])
        if effective_level != _SPEC_KINDS.index(effective_kind):
            raise BoundaryError("invalid_input", "kind and level must match")
        effective_parent = fields.get("parent_id", row["parent_id"])
        _spec_validate_parent(
            conn,
            project_id=row["project_id"],
            parent_id=effective_parent,
            level=effective_level,
        )
        if "parent_id" in fields and fields["parent_id"] is not None:
            current = fields["parent_id"]
            seen = set()
            while current is not None:
                if current in seen or current == node_id:
                    raise BoundaryError("constraint", "cycle in spec tree")
                seen.add(current)
                parent_row = conn.execute("SELECT parent_id FROM spec_nodes WHERE id = ?", (current,)).fetchone()
                current = parent_row["parent_id"] if parent_row else None
        if fields:
            assignments = ", ".join(f"{key} = ?" for key in fields)
            conn.execute(f"UPDATE spec_nodes SET {assignments}, updated_at = ? WHERE id = ?", (*fields.values(), time.time(), node_id))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _spec_row(conn.execute("SELECT * FROM spec_nodes WHERE id = ?", (node_id,)).fetchone())


def reparent_spec_node(conn: sqlite3.Connection, node_id: str, *, project_id: str, new_parent_id: str | None) -> dict[str, Any]:
    """Move a node to a different parent, appended after that parent's
    existing children. Unlike move_spec_node (which only reorders siblings
    under the SAME parent), this changes parent_id itself, so it re-validates
    the kind/level relationship exactly like create_spec_node, rejects cycles
    (new_parent_id being node_id or one of its own descendants), and — for
    new_parent_id=None — respects the one-root-per-project unique index
    instead of letting sqlite raise a raw IntegrityError. Sibling sort_index
    values under the OLD parent are left untouched (gaps are fine)."""
    project_id = _spec_project(project_id)
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM spec_nodes WHERE id = ?", (node_id,)).fetchone()
        if row is None or row["project_id"] != project_id:
            raise BoundaryError("not_found", "resource not found")
        if new_parent_id == node_id:
            raise BoundaryError("invalid_input", "a node cannot be its own parent")
        if new_parent_id is not None:
            descendant = conn.execute("SELECT parent_id FROM spec_nodes WHERE id = ?", (new_parent_id,)).fetchone()
            if descendant is None:
                raise BoundaryError("not_found", "parent node not found")
            current = descendant["parent_id"]
            seen = {node_id}
            for _ in range(1000):
                if current is None:
                    break
                if current in seen:
                    raise BoundaryError("invalid_input", "cannot reparent a node under one of its own descendants")
                seen.add(current)
                parent_row = conn.execute("SELECT parent_id FROM spec_nodes WHERE id = ?", (current,)).fetchone()
                current = parent_row["parent_id"] if parent_row else None
            else:
                raise BoundaryError("internal_error", f"ancestor chain from {new_parent_id!r} exceeds max depth 1000; refusing to trust malformed hierarchy")
        if new_parent_id is None and row["level"] != 0:
            raise BoundaryError("invalid_input", "only a theme (level 0) can become a root")
        if new_parent_id is None:
            existing_root = conn.execute(
                "SELECT id FROM spec_nodes WHERE project_id = ? AND parent_id IS NULL AND level = 0 AND id != ?",
                (project_id, node_id),
            ).fetchone()
            if existing_root is not None:
                raise BoundaryError("conflict", f"project {project_id!r} already has a root theme ({existing_root['id']})")
        else:
            _spec_validate_parent(conn, project_id=project_id, parent_id=new_parent_id, level=row["level"])
        next_sort_index = conn.execute(
            "SELECT COALESCE(MAX(sort_index), -1) + 1 FROM spec_nodes WHERE project_id = ? AND parent_id IS ?",
            (project_id, new_parent_id),
        ).fetchone()[0]
        conn.execute(
            "UPDATE spec_nodes SET parent_id = ?, sort_index = ?, updated_at = ? WHERE id = ?",
            (new_parent_id, next_sort_index, time.time(), node_id),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _spec_row(conn.execute("SELECT * FROM spec_nodes WHERE id = ?", (node_id,)).fetchone())


def move_spec_node(conn: sqlite3.Connection, node_id: str, *, project_id: str | None = None, direction: str) -> dict[str, Any]:
    """Swap a node's sort_index with its nearest sibling in the given
    direction ('up' or 'down'), reordering only among siblings that share
    the same parent_id. A no-op at either end of the sibling list (e.g.
    moving the first sibling up) returns the node unchanged rather than
    raising, so callers can disable the button instead of handling an error."""
    if direction not in ("up", "down"):
        raise BoundaryError("invalid_input", "direction must be 'up' or 'down'")
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM spec_nodes WHERE id = ?", (node_id,)).fetchone()
        if row is None or (project_id is not None and row["project_id"] != _spec_project(project_id)):
            raise BoundaryError("not_found", "resource not found")
        siblings = conn.execute(
            "SELECT id, sort_index FROM spec_nodes WHERE project_id = ? AND parent_id IS ? ORDER BY sort_index, created_at, id",
            (row["project_id"], row["parent_id"]),
        ).fetchall()
        index = next((i for i, sib in enumerate(siblings) if sib["id"] == node_id), None)
        if index is None:
            raise BoundaryError("internal_error", "node missing from its own sibling list")
        neighbor_index = index - 1 if direction == "up" else index + 1
        if 0 <= neighbor_index < len(siblings):
            neighbor = siblings[neighbor_index]
            conn.execute("UPDATE spec_nodes SET sort_index = ? WHERE id = ?", (neighbor["sort_index"], node_id))
            conn.execute("UPDATE spec_nodes SET sort_index = ? WHERE id = ?", (siblings[index]["sort_index"], neighbor["id"]))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _spec_row(conn.execute("SELECT * FROM spec_nodes WHERE id = ?", (node_id,)).fetchone())


def get_spec_tree(conn: sqlite3.Connection, *, project_id: str) -> dict[str, Any] | None:
    project_id = _spec_project(project_id)
    rows = conn.execute("SELECT * FROM spec_nodes WHERE project_id = ? ORDER BY level, sort_index, created_at, id", (project_id,)).fetchall()
    by_id = {row["id"]: row for row in rows}
    for row in rows:
        parent_id = row["parent_id"]
        if parent_id is not None and parent_id not in by_id:
            raise ValueError(f"orphan spec node {row['id']!r}")
        seen = set()
        current = row["id"]
        while current is not None:
            if current in seen:
                raise ValueError(f"cycle in spec tree at {row['id']!r}")
            seen.add(current)
            current = by_id[current]["parent_id"] if current in by_id else None
    roots = [row for row in rows if row["level"] == 0 and row["parent_id"] is None]
    if len(roots) > 1:
        raise ValueError(f"project {project_id!r} has multiple spec roots")
    if not roots:
        return None
    children: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        if row["parent_id"] is not None:
            children.setdefault(row["parent_id"], []).append(row)
    def build(row: sqlite3.Row) -> dict[str, Any]:
        result = _spec_row(row)
        result["children"] = [build(child) for child in children.get(row["id"], [])]
        return result
    return build(roots[0])


def _hierarchy_row(row: sqlite3.Row) -> dict[str, Any]:
    return dict(row)


def _hierarchy_project(project_id: str) -> dict[str, str]:
    return _resolve_project(project_id)


def create_node(
    conn: sqlite3.Connection, *, project_id: str, parent_id: Optional[str], level: int,
    title: str, sort_order: int = 0, kanban_task_id: Optional[str] = None,
) -> dict[str, Any]:
    raise BoundaryError("constraint", "hierarchy_nodes is read-only after v12; use spec nodes")
    """Create one hierarchy node, enforcing the fixed parent-depth tree."""
    proj = _hierarchy_project(project_id)
    if not isinstance(level, int) or isinstance(level, bool) or not 0 <= level <= 5:
        raise ValueError("level must be an integer from 0 through 5")
    if not title or not title.strip():
        raise ValueError("title is required")
    if level == 0:
        if parent_id is not None:
            raise ValueError("level 0 root cannot have a parent")
    else:
        if not parent_id:
            raise ValueError("non-root nodes require a parent")
        parent = conn.execute(
            "SELECT project_id, level, archived FROM hierarchy_nodes WHERE id = ?", (parent_id,)
        ).fetchone()
        if parent is None or parent["archived"]:
            raise ValueError("parent node does not exist or is archived")
        if parent["project_id"] != proj["id"] or parent["level"] != level - 1:
            raise ValueError("parent must belong to the project and be exactly one level above the node")
    if level not in (4, 5) and kanban_task_id is not None:
        raise ValueError("kanban_task_id is only valid for Story or Task nodes")
    node_id = "n_" + secrets.token_hex(4)
    now = int(time.time())
    try:
        conn.execute(
            "INSERT INTO hierarchy_nodes "
            "(id, project_id, parent_id, level, title, sort_order, kanban_task_id, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (node_id, proj["id"], parent_id, level, title.strip(), int(sort_order), kanban_task_id, now, now),
        )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        conn.rollback()
        if level == 0:
            raise ValueError(f"project {proj['id']!r} already has a hierarchy root") from exc
        raise
    return _hierarchy_row(conn.execute("SELECT * FROM hierarchy_nodes WHERE id = ?", (node_id,)).fetchone())


def list_nodes(conn: sqlite3.Connection, *, project_id: str, parent_id: Optional[str] = None) -> list[dict[str, Any]]:
    proj = _hierarchy_project(project_id)
    rows = conn.execute(
        "SELECT * FROM hierarchy_nodes WHERE project_id = ? AND archived = 0 "
        "AND parent_id IS ? ORDER BY sort_order, created_at, id",
        (proj["id"], parent_id),
    ).fetchall()
    return [_hierarchy_row(row) for row in rows]


def _kanban_statuses(task_ids: set[str]) -> dict[str, str]:
    if not task_ids:
        return {}
    path = os.environ.get("HERMES_KANBAN_DB", "").strip()
    kanban_path = Path(path) if path else _hermes_home() / "kanban.db"
    if not kanban_path.exists():
        return {}
    kconn: Optional[sqlite3.Connection] = None
    try:
        kconn = _connect_sqlite(kanban_path)
        rows = kconn.execute(
            f"SELECT id, status FROM tasks WHERE id IN ({','.join('?' for _ in task_ids)})",
            tuple(task_ids),
        ).fetchall()
        return {row[0]: row[1] for row in rows}
    except sqlite3.Error:
        return {}
    finally:
        if kconn is not None:
            kconn.close()


def get_subtree(
    conn: sqlite3.Connection, project_id: str, *, include_tasks: bool = False,
) -> dict[str, Any]:
    """Return the active tree from its level-0 root, with Story roll-ups."""
    proj = _hierarchy_project(project_id)
    rows = conn.execute(
        "SELECT * FROM hierarchy_nodes WHERE project_id = ? AND archived = 0 ORDER BY level, sort_order, created_at, id",
        (proj["id"],),
    ).fetchall()
    if not rows:
        raise ValueError(f"project {proj['id']!r} has no hierarchy root")
    by_parent: dict[Optional[str], list[sqlite3.Row]] = {}
    for row in rows:
        by_parent.setdefault(row["parent_id"], []).append(row)
    roots = [row for row in rows if row["level"] == 0 and row["parent_id"] is None]
    if not roots:
        raise ValueError(f"project {proj['id']!r} has no hierarchy root")
    root = roots[0]
    story_ids = {row["kanban_task_id"] for row in rows if row["level"] == 4 and row["kanban_task_id"]}
    statuses = _kanban_statuses(story_ids)

    def build(row: sqlite3.Row) -> dict[str, Any]:
        children = [child for child in by_parent.get(row["id"], []) if include_tasks or child["level"] < 5]
        result = _hierarchy_row(row)
        result["children"] = [build(child) for child in children]
        done = 1 if row["level"] == 4 and row["kanban_task_id"] else 0
        total = done
        if done:
            done = 1 if statuses.get(row["kanban_task_id"]) == "done" else 0
        for child in result["children"]:
            done += child["done_count"]
            total += child["total_count"]
        result["done_count"] = done
        result["total_count"] = total
        return result

    return build(root)


def update_node(conn: sqlite3.Connection, node_id: str, **fields: Any) -> dict[str, Any]:
    raise BoundaryError("constraint", "hierarchy_nodes is read-only after v12; use spec nodes")
    allowed = {"title", "sort_order", "kanban_task_id"}
    unknown = set(fields) - allowed
    if unknown:
        raise ValueError(f"immutable or unsupported node fields: {sorted(unknown)}")
    row = conn.execute("SELECT * FROM hierarchy_nodes WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        raise ValueError(f"node {node_id!r} not found")
    if "title" in fields and (not fields["title"] or not str(fields["title"]).strip()):
        raise ValueError("title is required")
    if "kanban_task_id" in fields and row["level"] not in (4, 5) and fields["kanban_task_id"] is not None:
        raise ValueError("kanban_task_id is only valid for Story or Task nodes")
    if "kanban_task_id" in fields and fields["kanban_task_id"]:
        duplicate = conn.execute(
            "SELECT id FROM hierarchy_nodes WHERE kanban_task_id = ? AND id != ? AND archived = 0",
            (fields["kanban_task_id"], node_id),
        ).fetchone()
        if duplicate:
            raise ValueError(f"kanban task {fields['kanban_task_id']!r} is already linked to another node")
    if fields:
        assignments = ", ".join(f"{key} = ?" for key in fields)
        values = [str(value).strip() if key == "title" else value for key, value in fields.items()]
        conn.execute(
            f"UPDATE hierarchy_nodes SET {assignments}, updated_at = ? WHERE id = ?",
            (*values, int(time.time()), node_id),
        )
        conn.commit()
    return _hierarchy_row(conn.execute("SELECT * FROM hierarchy_nodes WHERE id = ?", (node_id,)).fetchone())


def archive_node(conn: sqlite3.Connection, node_id: str, *, cascade: bool = True) -> dict[str, Any]:
    raise BoundaryError("constraint", "hierarchy_nodes is read-only after v12; use spec nodes")
    row = conn.execute("SELECT * FROM hierarchy_nodes WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        raise ValueError(f"node {node_id!r} not found")
    ids = [node_id]
    if cascade:
        pending = [node_id]
        while pending:
            children = conn.execute(
                "SELECT id FROM hierarchy_nodes WHERE parent_id IN ({})".format(",".join("?" for _ in pending)),
                pending,
            ).fetchall()
            pending = [child["id"] for child in children]
            ids.extend(pending)
    placeholders = ",".join("?" for _ in ids)
    conn.execute(
        f"UPDATE hierarchy_nodes SET archived = 1, updated_at = ? WHERE id IN ({placeholders})",
        (int(time.time()), *ids),
    )
    conn.commit()
    return _hierarchy_row(conn.execute("SELECT * FROM hierarchy_nodes WHERE id = ?", (node_id,)).fetchone())


def link_node_to_kanban(conn: sqlite3.Connection, node_id: str, kanban_task_id: str) -> dict[str, Any]:
    raise BoundaryError("constraint", "hierarchy_nodes is read-only after v12; use spec nodes")
    if not kanban_task_id or not kanban_task_id.strip():
        raise ValueError("kanban_task_id is required")
    row = conn.execute("SELECT * FROM hierarchy_nodes WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        raise ValueError(f"node {node_id!r} not found")
    if row["level"] not in (4, 5):
        raise ValueError("only Story or Task nodes may link to Kanban tasks")
    duplicate = conn.execute(
        "SELECT id FROM hierarchy_nodes WHERE kanban_task_id = ? AND id != ? AND archived = 0",
        (kanban_task_id.strip(), node_id),
    ).fetchone()
    if duplicate:
        raise ValueError(f"kanban task {kanban_task_id!r} is already linked to another node")
    conn.execute(
        "UPDATE hierarchy_nodes SET kanban_task_id = ?, updated_at = ? WHERE id = ?",
        (kanban_task_id.strip(), int(time.time()), node_id),
    )
    conn.commit()
    return _hierarchy_row(conn.execute("SELECT * FROM hierarchy_nodes WHERE id = ?", (node_id,)).fetchone())


def _flow_row(row: sqlite3.Row) -> dict[str, Any]:
    return dict(row)


def _flow_for_project(conn: sqlite3.Connection, flow_id: str, project_id: str) -> sqlite3.Row:
    project = _resolve_project(project_id)
    row = conn.execute("SELECT * FROM flows WHERE id = ? AND project_id = ?", (flow_id, project["id"])).fetchone()
    if row is None:
        raise BoundaryError("not_found", "flow not found")
    return row


def create_flow(conn: sqlite3.Connection, *, project_id: str, name: str) -> dict[str, Any]:
    project = _resolve_project(project_id)
    name = validate_text(name, field="name", max_chars=TEXT_LIMIT)
    flow_id = "flow_" + secrets.token_hex(4)
    now = int(time.time())
    conn.execute(
        "INSERT INTO flows (id, project_id, name, steps_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (flow_id, project["id"], name, "[]", now, now),
    )
    conn.commit()
    return _flow_row(_flow_for_project(conn, flow_id, project_id))


def list_flows(conn: sqlite3.Connection, *, project_id: str) -> list[dict[str, Any]]:
    project = _resolve_project(project_id)
    return [_flow_row(row) for row in conn.execute(
        "SELECT * FROM flows WHERE project_id = ? ORDER BY updated_at DESC, id", (project["id"],)
    ).fetchall()]


def get_flow(conn: sqlite3.Connection, flow_id: str, *, project_id: str) -> dict[str, Any]:
    return _flow_row(_flow_for_project(conn, flow_id, project_id))


def update_flow(conn: sqlite3.Connection, flow_id: str, *, project_id: str, name: str) -> dict[str, Any]:
    _flow_for_project(conn, flow_id, project_id)
    name = validate_text(name, field="name", max_chars=TEXT_LIMIT)
    conn.execute("UPDATE flows SET name = ?, updated_at = ? WHERE id = ?", (name, int(time.time()), flow_id))
    conn.commit()
    return _flow_row(_flow_for_project(conn, flow_id, project_id))


def _validate_flow_steps(steps: Any) -> list[dict[str, Any]]:
    if not isinstance(steps, list):
        raise BoundaryError("invalid_input", "steps must be an array")
    if len(steps) > _MAX_FLOW_STEPS:
        raise BoundaryError("invalid_input", "steps exceeds its size limit")
    ids: set[str] = set()
    normalized: list[dict[str, Any]] = []
    edge_count = 0
    for step in steps:
        if not isinstance(step, dict) or set(step) != {"id", "label", "next"}:
            raise BoundaryError("invalid_input", "each step must have only id, label, and next")
        step_id = validate_text(step["id"], field="step id", max_chars=ID_LIMIT)
        label = validate_text(step["label"], field="step label", max_chars=TEXT_LIMIT, allow_empty=True)
        if step_id in ids:
            raise BoundaryError("invalid_input", "duplicate step id")
        ids.add(step_id)
        targets = step["next"]
        if not isinstance(targets, list):
            raise BoundaryError("invalid_input", "step next must be an array")
        if len(targets) > _MAX_FLOW_EDGES:
            raise BoundaryError("invalid_input", "step has too many outgoing edges")
        clean_targets = [validate_text(target, field="step target", max_chars=ID_LIMIT) for target in targets]
        if len(set(clean_targets)) != len(clean_targets):
            raise BoundaryError("invalid_input", "duplicate step edge")
        edge_count += len(clean_targets)
        if edge_count > _MAX_FLOW_EDGES:
            raise BoundaryError("invalid_input", "graph has too many edges")
        normalized.append({"id": step_id, "label": label, "next": clean_targets})
    for step in normalized:
        if any(target not in ids for target in step["next"]):
            raise BoundaryError("invalid_input", "step references missing target")
    encoded = json.dumps(normalized, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) > _MAX_FLOW_GRAPH_BYTES:
        raise BoundaryError("invalid_input", "graph exceeds its size limit")
    return normalized


def set_flow_steps(conn: sqlite3.Connection, flow_id: str, *, project_id: str, steps: Any) -> dict[str, Any]:
    _flow_for_project(conn, flow_id, project_id)
    normalized = _validate_flow_steps(steps)
    conn.execute(
        "UPDATE flows SET steps_json = ?, updated_at = ? WHERE id = ?",
        (json.dumps(normalized, separators=(",", ":"), ensure_ascii=False), int(time.time()), flow_id),
    )
    conn.commit()
    return _flow_row(_flow_for_project(conn, flow_id, project_id))


def _risk_project(project_id: str) -> dict[str, str]:
    return _resolve_project(project_id)


def _optional_risk_text(value: Any, field: str) -> Optional[str]:
    if value is None:
        return None
    return validate_text(value, field=field, max_chars=TEXT_LIMIT)


def _risk_decision_project(conn: sqlite3.Connection, project_id: str,
                           decision_id: Optional[str]) -> str:
    project = _risk_project(project_id)["id"]
    if decision_id is not None:
        decision = conn.execute("SELECT project_id FROM decisions WHERE id = ?", (decision_id,)).fetchone()
        if decision is None or decision["project_id"] != project:
            raise BoundaryError("not_found", "resource not found")
    return project


def add_risk(conn: sqlite3.Connection, *, project_id: str, title: Any,
             description: Any = None, breaks_when: Any = None,
             status: str = "open", decision_id: Optional[str] = None) -> dict[str, Any]:
    project = _risk_decision_project(conn, project_id, decision_id)
    title = validate_text(title, field="title")
    description = _optional_risk_text(description, "description")
    breaks_when = _optional_risk_text(breaks_when, "breaks_when")
    if not isinstance(status, str) or status not in _RISK_STATUSES:
        raise BoundaryError("invalid_input", "invalid risk status")
    risk_id = "risk_" + secrets.token_hex(4)
    now = time.time()
    conn.execute(
        "INSERT INTO risks (id, project_id, decision_id, title, description, breaks_when, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (risk_id, project, decision_id, title, description, breaks_when, status, now, now),
    )
    conn.commit()
    return dict(conn.execute("SELECT * FROM risks WHERE id = ?", (risk_id,)).fetchone())


def list_risks(conn: sqlite3.Connection, *, project_id: str) -> list[dict[str, Any]]:
    project = _risk_project(project_id)["id"]
    return [dict(row) for row in conn.execute("SELECT * FROM risks WHERE project_id = ? ORDER BY created_at, id", (project,)).fetchall()]


def update_risk_status(conn: sqlite3.Connection, *, project_id: str, risk_id: str, status: str) -> dict[str, Any]:
    project = _risk_project(project_id)["id"]
    if not isinstance(status, str) or status not in _RISK_STATUSES:
        raise BoundaryError("invalid_input", "invalid risk status")
    row = conn.execute("SELECT * FROM risks WHERE id = ? AND project_id = ?", (risk_id, project)).fetchone()
    if row is None:
        raise BoundaryError("not_found", "resource not found")
    conn.execute("UPDATE risks SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?", (status, time.time(), risk_id, project))
    conn.commit()
    return dict(conn.execute("SELECT * FROM risks WHERE id = ?", (risk_id,)).fetchone())


def add_tradeoff(conn: sqlite3.Connection, *, project_id: str, kind: str, title: Any, choice: Any,
                  alt_label: Any = None, cost: Any = None, gain: Any = None,
                  decision_id: Optional[str] = None) -> dict[str, Any]:
    project = _risk_decision_project(conn, project_id, decision_id)
    if not isinstance(kind, str) or kind not in _RISK_TRADEOFF_KINDS:
        raise BoundaryError("invalid_input", "invalid tradeoff kind")
    title = validate_text(title, field="title")
    choice = validate_text(choice, field="choice")
    alt_label = _optional_risk_text(alt_label, "alt_label")
    cost = _optional_risk_text(cost, "cost")
    gain = _optional_risk_text(gain, "gain")
    tradeoff_id = "tradeoff_" + secrets.token_hex(4)
    now = time.time()
    conn.execute(
        "INSERT INTO tradeoffs (id, project_id, decision_id, kind, title, choice, alt_label, cost, gain, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (tradeoff_id, project, decision_id, kind, title, choice, alt_label, cost, gain, now, now),
    )
    conn.commit()
    return dict(conn.execute("SELECT * FROM tradeoffs WHERE id = ?", (tradeoff_id,)).fetchone())


def list_tradeoffs(conn: sqlite3.Connection, *, project_id: str) -> list[dict[str, Any]]:
    project = _risk_project(project_id)["id"]
    return [dict(row) for row in conn.execute("SELECT * FROM tradeoffs WHERE project_id = ? ORDER BY created_at, id", (project,)).fetchall()]


def set_prioritized_side(conn: sqlite3.Connection, *, project_id: str, tradeoff_id: str, side: Optional[str]) -> dict[str, Any]:
    project = _risk_project(project_id)["id"]
    if side is not None and side not in ("a", "b"):
        raise BoundaryError("invalid_input", "invalid prioritized side")
    row = conn.execute("SELECT * FROM tradeoffs WHERE id = ? AND project_id = ?", (tradeoff_id, project)).fetchone()
    if row is None:
        raise BoundaryError("not_found", "resource not found")
    conn.execute("UPDATE tradeoffs SET prioritized_side = ?, updated_at = ? WHERE id = ? AND project_id = ?", (side, time.time(), tradeoff_id, project))
    conn.commit()
    return dict(conn.execute("SELECT * FROM tradeoffs WHERE id = ?", (tradeoff_id,)).fetchone())

# --- observation log checkpoints ---------------------------------------------
# The log itself lives in observation_log.py (a JSONL file beside queue.db).
# A checkpoint records "the log's head was (seq, hash) when a human looked", and
# is stored here, outside that file, so a rewritten or truncated log can be
# caught. Creating one is gated exactly like resolving a decision.

def add_observation_checkpoint(
    conn: sqlite3.Connection, *, seq: int, head_hash: str, actor_token: str
) -> dict[str, Any]:
    """Record a human-confirmed checkpoint of the observation log head.
    Idempotent for an identical (seq, head_hash)."""
    if _is_delegated_child_process_context():
        raise NotAuthorized(
            "add_observation_checkpoint() refused: running in a delegated-child process context "
            f"({_DELEGATED_CHILD_ENV_MARKER} is set); only the interactive owner may confirm a checkpoint")
    actor = _validate_actor_token(actor_token)
    if actor is None:
        raise NotAuthorized(
            "add_observation_checkpoint() refused: missing, unknown, or expired actor_token; obtain "
            "one via `hermes decision issue-token` before confirming a checkpoint")
    if isinstance(seq, bool) or not isinstance(seq, int) or seq < 1:
        raise BoundaryError("invalid_input", "seq must be a positive integer")
    prefix = "sha256:"
    digest = head_hash[len(prefix):] if isinstance(head_hash, str) and head_hash.startswith(prefix) else ""
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise BoundaryError("invalid_input", "head_hash must be sha256:<64 lowercase hex characters>")
    existing = conn.execute(
        "SELECT * FROM observation_checkpoints WHERE seq = ? AND head_hash = ?", (seq, head_hash)
    ).fetchone()
    if existing is not None:
        return dict(existing)
    checkpoint_id = "ocp_" + secrets.token_hex(6)
    conn.execute(
        "INSERT INTO observation_checkpoints (id, seq, head_hash, confirmed_by, created_at) VALUES (?, ?, ?, ?, ?)",
        (checkpoint_id, seq, head_hash, actor, time.time()),
    )
    conn.commit()
    return dict(conn.execute("SELECT * FROM observation_checkpoints WHERE id = ?", (checkpoint_id,)).fetchone())


def list_observation_checkpoints(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    return [
        dict(row)
        for row in conn.execute("SELECT * FROM observation_checkpoints ORDER BY seq, created_at, id").fetchall()
    ]


# --- daily cadence: days, blocks, hours -----------------------------------------
# Layout and clock logic live in day_schedule.py (pure). These functions only
# persist a laid-out day and read it back.

def _day_hours(conn: sqlite3.Connection, day_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT h.id AS id, b.idx AS block, h.idx AS hour, h.kind AS kind,
               h.start_ts AS start_ts, h.end_ts AS end_ts
        FROM hours h JOIN blocks b ON b.id = h.block_id
        WHERE b.day_id = ? ORDER BY b.idx, h.idx
        """,
        (day_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def get_active_day(conn: sqlite3.Connection) -> Optional[dict[str, Any]]:
    """The active day with its hours in order, or None."""
    row = conn.execute("SELECT * FROM days WHERE status = 'active'").fetchone()
    if row is None:
        return None
    day = dict(row)
    day["hours"] = _day_hours(conn, day["id"])
    return day


def create_day(
    conn: sqlite3.Connection, *, date: str, hours_available: int, slots: list[dict[str, Any]]
) -> dict[str, Any]:
    """Persist a laid-out day (slots from day_schedule.hour_slots) as the active
    day. Rejects with `conflict` while another day is still active (the unique
    index on active days is the single source of that rule)."""
    if not slots:
        raise BoundaryError("invalid_input", "a day needs at least one hour")
    day_id = "day_" + secrets.token_hex(6)
    try:
        conn.execute(
            "INSERT INTO days (id, date, hours_available, status, started_at) VALUES (?, ?, ?, 'active', ?)",
            (day_id, date, hours_available, slots[0]["start_ts"]),
        )
        block_ids: dict[int, str] = {}
        for slot in slots:
            block = slot["block"]
            if block not in block_ids:
                block_ids[block] = "blk_" + secrets.token_hex(6)
                work_hours = sum(1 for s in slots if s["block"] == block and s["kind"] == "work")
                conn.execute(
                    "INSERT INTO blocks (id, day_id, idx, work_hours) VALUES (?, ?, ?, ?)",
                    (block_ids[block], day_id, block, work_hours),
                )
            conn.execute(
                "INSERT INTO hours (id, block_id, idx, kind, start_ts, end_ts) VALUES (?, ?, ?, ?, ?, ?)",
                ("hr_" + secrets.token_hex(6), block_ids[block], slot["hour"], slot["kind"], slot["start_ts"], slot["end_ts"]),
            )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        conn.rollback()
        if "days.status" in str(exc):
            raise BoundaryError("conflict", "a day is already active; end it first") from exc
        raise
    except Exception:
        conn.rollback()
        raise
    return get_active_day(conn)


def end_active_day(conn: sqlite3.Connection, *, ended_at: float) -> dict[str, Any]:
    day = get_active_day(conn)
    if day is None:
        raise BoundaryError("not_found", "no active day")
    conn.execute("UPDATE days SET status = 'ended', ended_at = ? WHERE id = ?", (ended_at, day["id"]))
    conn.commit()
    return {**day, "status": "ended", "ended_at": ended_at}
