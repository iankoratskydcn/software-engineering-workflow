# Mind-Map Hierarchy in Decision HUD — Plan

Sep 24, 2026 · @Ian Koratsky

> **Superseded.** `spec_nodes` is the single tree (MindMap and Spec Digest are two views of it). The
> `hermes decision node *` CLI, the hierarchy map pane and its route described below were removed; use
> `hermes decision spec ...` (including `link-kanban`). Kept for history.

## Origin

Started as a standalone plugin idea (`docs/mindmap.md` per project, rendered as a
markmap tree, `plugins/mindmap/` in hermes-agent). Decision: absorb it into
**Decision HUD** instead of building a second plugin. Design chosen: **B** —
the hierarchy becomes native Decision HUD schema in `decisions.db`.
`docs/mindmap.md` (if it ever existed for a project) becomes optional/secondary;
the HUD pane is the source of truth going forward.

This intentionally reverses two of the original mindmap doc's non-goals
("not a second task store", "map never creates/edits tasks") — see
**Consequences** below. That reversal is accepted, not accidental.

## Scope

Extend Decision HUD with a real hierarchy: **Project → Theme → Epic → Feature →
Story → Task**, where **Task nodes may link 1:1 to a Kanban card** (`_kanban_task_id`
in `card_payload`, same mechanism already used for blocker escalation — see
`decision-hud-integration` skill, "link a pushed decision card back to the
external record" bullet). Decisions (existing `decisions` table) attach to
any node in the tree, not just Tasks.

### Levels (locked)

| Level | Depth | Kanban link? | Notes |
|---|---|---|---|
| Project | 0 | no | existing `projects` table (hermes-agent `projects_db.py`), reused by reference, not duplicated |
| Theme | 1 | no | strategic area |
| Epic | 2 | no | outcome inside a theme |
| Feature | 3 | no | user-visible capability |
| Story | 4 | optional | sized for one kanban card |
| Task | 5 | optional | map-only detail OR linked to a real card; **not** a duplicate of Kanban subtasks — a Task node with no `_kanban_task_id` is pure scope detail, one with it is a live pointer |

Each node: exactly one parent (except Project, which is root), no cross-branch
links (mirrors original mindmap doc's tree invariant). Order within a parent is
explicit (`sort_order INTEGER`), not insertion-order-implicit.

## Schema (new tables, `_migrate_v7_hierarchy`)

```sql
CREATE TABLE IF NOT EXISTS hierarchy_nodes (
    id            TEXT PRIMARY KEY,        -- 'n_' + secrets.token_hex(4), same convention as kanban 't_'
    project_id    TEXT NOT NULL,           -- FK to hermes-agent projects.id (not enforced cross-DB; validated at write time via _resolve_project)
    parent_id     TEXT,                    -- NULL only for level=0 (the project's own root row)
    level         INTEGER NOT NULL,        -- 0=Project (one synthetic root row per project) .. 5=Task
    title         TEXT NOT NULL,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    kanban_task_id TEXT,                   -- only meaningful at level=4 (Story) or 5 (Task); NULL otherwise
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    archived      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_hierarchy_parent ON hierarchy_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_hierarchy_project ON hierarchy_nodes(project_id, level);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hierarchy_one_root_per_project
    ON hierarchy_nodes(project_id) WHERE level = 0;  -- enforces exactly one level-0 row per project
```

Existing `decisions.card_payload` gains a convention (no schema change needed,
same pattern as `_kanban_task_id`): `_hierarchy_node_id` links a decision to a
tree node. A tree node can have zero or many attached decisions.

No cross-database foreign key to hermes-agent's `projects.db` (separate SQLite
file, separate process boundary) — `_resolve_project(project_id)` (already in
`db.py`) is called at node-create time to validate the id is real; the id
itself is stored as plain TEXT, same non-enforced-FK pattern `decisions.project_id`
already uses.

## Backend (`backend-plugin/db.py`)

New functions, same shape as existing `push_decision`/`list_pending`:

- `create_node(conn, *, project_id, parent_id, level, title, sort_order=0, kanban_task_id=None) -> dict`
  — validates level is 1-5, validates parent exists and `parent.level == level - 1`
  (or parent_id is None and level == 1), validates project_id via `_resolve_project`.
- `list_nodes(conn, *, project_id, parent_id=None) -> list[dict]` — one level at a
  time (lazy tree, not a full recursive dump) OR `get_subtree(conn, project_id) ->
  dict` (full nested tree, for the pane's initial render). Decide at implementation
  time based on real project size (see Open Q2).
- `update_node(conn, node_id, **fields)` — title/sort_order/kanban_task_id only;
  level and parent_id are immutable after create (moving a node is a v2 feature,
  not v1 — matches original doc's "read-only in v1" caution, just applied to
  structure instead of content).
- `archive_node(conn, node_id, *, cascade=True)` — soft delete; cascade archives
  descendants (never hard-delete; mirrors decisions' own no-delete posture).
- `link_node_to_kanban(conn, node_id, kanban_task_id)` — sets `kanban_task_id`,
  validates level is 4 or 5, validates no other node already holds that
  `kanban_task_id` (one card, one node — reject silent double-linking).

CLI bridge (`backend-plugin/cli.py`), same `hermes decision <verb>` pattern
already used for `settings-get`/`settings-set`:

```
hermes decision node create --project <id> --parent <node_id|null> --level <1-5> --title "..."
hermes decision node list --project <id> [--parent <node_id>]
hermes decision node tree --project <id>          # full nested JSON
hermes decision node link-kanban <node_id> <task_id>
hermes decision node archive <node_id>
```

## Frontend (`plugin.js`)

New pane (or a mode within the existing Decision HUD pane — TBD, see Open Q3):
tree view, collapsible per level, matching the original mindmap doc's UX intent
(collapsible mind map) but native React instead of markmap. Reuses existing
`CardErrorBoundary` and settings-popover patterns already established in this
repo. Node click surfaces: title, level, linked Kanban task (if any, with status
dot — reusing the **VALID_STATUSES → color** table from the original mindmap
doc, since that mapping is unaffected by the design change), attached decisions
(if any, rendered via existing `DefaultChoiceCard`/native renderers).

No new `card_type` — a hierarchy node is not itself a decision; only decisions
*attached to* a node use the existing `card_type` system unchanged.

TDD discipline applies exactly per `decision-hud-integration` skill: RED test
per new function/component → GREEN → full `test/*.test.mjs` regression → commit
checkpoint. Backend gets equivalent pytest coverage in `backend-plugin/tests/`.

## Kanban card linking workflow (reuses existing skill)

The `mindmap-kanban-task-linking` skill (built earlier this session) already
covers "create a Kanban card, write its id back" — update it once this ships to
call `hermes decision node link-kanban <node_id> <task_id>` instead of patching
a markdown bullet. Same procedure, new sink.

## Consequences (explicitly accepted)

- **"Not a second task store" is now false.** The hierarchy is real persisted
  state Hermes creates/edits, not a read-only view over a file. Accepted per
  your choice of Design B.
- **`docs/mindmap.md` becomes optional.** If a project already has one (none do
  yet — this was still a proposal), it is not read by this feature; a future
  one-time import script (`hermes decision node import-markdown <path>`) could
  seed nodes from an existing file, but is out of scope for v1 unless requested.
- **No git-reviewable diff for the tree shape.** Structure changes happen
  through the pane/CLI, not a PR. Individual decision/content nodes are still
  auditable via the existing `decisions` table's normal history.

## Open questions — LOCKED (Sep 24, 2026, re-decided)

1. **Root convention: LOCKED — explicit level-0 Project row.** `hierarchy_nodes`
   gets one row per Project (`level=0`, `parent_id=NULL`, `title`=project name),
   created alongside/lazily from the real Project row (`_resolve_project`).
   Every Theme's `parent_id` points at this row. Reverses the earlier default —
   chosen for a uniform single-root ancestor per project, which makes recursive
   queries (subtree fetch, cascade archive, status-dot roll-up in Q4) a plain
   "walk down from one root" instead of a `level=1 AND parent_id IS NULL` special
   case. **Schema impact**: `level` constraint widens from 1-5 to 0-5; `create_node`
   must special-case level=0 as auto-created-once-per-project (reject a second
   level-0 row for the same `project_id`); `get_subtree` starts from the level-0
   row, not from a `WHERE parent_id IS NULL` scan.
2. **Tree fetch strategy: LOCKED — full-tree fetch through Story, Task-level
   children lazy-load on Story expand.** Unchanged from first pass.
3. **Pane placement: LOCKED — separate 'Map' pane/tab**, alongside the existing
   Decision HUD tabs. Unchanged from first pass.
4. **Status dot roll-up: LOCKED — ship in v1.** Reverses the earlier default
   (defer). Feature/Epic/Theme (and now the level-0 Project row) show a
   "N/M done" count computed by walking descendants to Story-level
   `kanban_task_id` links and joining Kanban's own status. **Schema/build
   impact**: this is no longer a "maybe later" — wave 1 (schema+backend) must
   include the roll-up query (`get_subtree` response carries a computed
   `done_count`/`total_count` per node, not just raw rows), and wave 3
   (tree pane skeleton) must render the dots/counts from day one instead of
   after a later wave. The color mapping reuses `VALID_STATUSES` from
   `hermes_cli/kanban_db.py:104` exactly as originally specified (grey/blue/red/green).

## Build plan (once opens above are answered)

Broken into Kanban cards, gated waves per the `decision-hud-integration` skill's
own procedure (freeze contract → RED tests → implement → hostile review →
layered verify):

1. **Schema + backend functions** (`_migrate_v7_hierarchy`, `create_node`/
   `list_nodes`/`get_subtree`/`update_node`/`archive_node`/`link_node_to_kanban`)
   + pytest coverage. Includes the level-0 root-row auto-create-once logic and
   the status-dot roll-up computation in `get_subtree` (done_count/total_count
   per node, joined against Kanban's own status column) — **not deferred**, per
   Q4. No UI yet.
2. **CLI bridge** (`hermes decision node ...` subcommands) + tests, wired to #1.
3. **Frontend: tree pane skeleton** (empty state, one project, collapsible
   Theme→Task levels, status dots + N/M counts rendered from day one per Q4)
   + RED/GREEN `test/*.test.mjs`. No decision attachment yet.
4. **Frontend: decision attachment** (show/attach decisions on a node via
   existing `_hierarchy_node_id` card_payload convention) + tests.
5. **Kanban linking UI** (link/unlink a Story or Task to a card) + tests.
6. **Update `mindmap-kanban-task-linking` skill** to target the new CLI instead
   of markdown patching.

Each wave: RED tests committed first, full regression run before checkpoint
commit, per this repo's TDD+checkpoint discipline (see `decision-hud-integration`
skill, "Editing plugin.js" section).
