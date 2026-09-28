# Decision HUD Prototype Restoration Plan

Date: 2026-09-28
Target repository: `/home/ian-koratsky/GitHub/software-engineering-workflow`
Target SHA: `96016a704cdb5096f23fc75f74a77f9f766310d0`
Working tree at planning time: clean
Canonical visual reference: `/home/ian-koratsky/.hermes/attachments/swe.html`
Reference SHA-256: `4af716ce9fd23d162cf229a4c446366ab81de133dbe4410a573548d34bf30cb6`

## Authority and non-goals

- `plugin.js` remains the UI integration target.
- Existing backend-plugin CLI/database contracts remain authoritative.
- `spec_nodes` is the current specification/mindmap authority.
- `hierarchy_nodes` remains a separate legacy Map authority; it must not silently fall back to `spec_nodes`.
- Agent Dashboard REST and `agent-metrics-snapshot` remain separate retrospective authorities.
- No new database schema, persistence layer, or runtime dependency.
- No cleanup of existing worktrees or generated residue without explicit owner approval.

## Current live evidence

Read-only inspection of `/home/ian-koratsky/.hermes/decision_hud/queue.db` found:

- `decisions`: 227
- `problem_reports`: 27
- `spec_nodes`: 14
- `hierarchy_nodes`: 0
- `flows`: 3
- `architecture_diagrams`: 2
- `risks`: 2
- `tradeoffs`: 2
- `roadmap_lanes`: 2
- `roadmap_items`: 2
- `planning_items`: 2

Historical `.hermes/evidence/stage2/*` reports are not acceptance evidence for this task until regenerated against the target SHA. The checked-in frontend report references older SHAs.

## Contract freeze before implementation

Freeze a machine-readable contract matrix covering each command's:

- exact CLI argv root and arguments;
- success envelope and payload key/type;
- `{ok:false}` error envelope;
- malformed/missing payload behavior;
- decoded JSON fields and bounds;
- project-scope and mutation rules;
- valid empty versus unavailable/error state.

Critical boundaries:

- `spec_nodes` and `hierarchy_nodes` are not interchangeable.
- `spec_nodes.decision_id`, `risks.decision_id`, `tradeoffs.decision_id`, and legacy `_hierarchy_node_id` card markers are distinct associations until an owner-approved canonicalization exists.
- Roadmap writes must preserve `expected_updated_at` conflict semantics.
- Planning items must reference same-project `spec_nodes` and preserve status/estimate/sprint constraints.
- Malformed or wrong-type responses must render an error, not a successful empty view.

## Staged implementation

### Stage 0 — Instrument and establish current-SHA baseline

No behavior change.

- Add development/test instrumentation around CLI, REST, mount, first meaningful content, refresh completion, and render boundaries.
- Add deterministic delayed responders and a request ledger to the test harness.
- Capture duplicate calls, overlapping refreshes, stale response writes, and unmount cleanup.
- Regenerate baseline test/evidence artifacts at `96016a7` before changing behavior.

Gate: exact-SHA baseline, no unresolved provenance mismatch, and a reproducible startup call graph.

### Stage 1 — Correct scheduling and fail-closed parsing

- Share board/project data within the mounted workflow surface.
- Eliminate duplicate `decision projects` reads.
- Prevent polling overlap with single-flight or generation guards.
- Pause inactive-surface polling; refresh on activation, board change, mutation completion, and retry.
- Make all list parsers validate `ok`, payload key, and payload type.
- Preserve visible distinction between loading, valid empty, unavailable, malformed, and transport error.
- Add stale board/project response protection.

Gate: delayed-response tests prove no stale project display/mutation, no duplicate intervals, and no overlapping requests.

### Stage 2 — Restore the unified prototype shell and top-level tabs

Adapt the existing pane implementations rather than creating a second store.

Top-level order and default:

1. MindMap
2. Roadmap
3. Risk & Tradeoffs
4. Flowcharts
5. Architecture
6. Spec Digest
7. Scrum Planning

Restore the supplied prototype's dark shell, title, compact tab strip, active underline, typography, panel colors, borders, padding, fixed side rails, responsive overflow, and section-local state preservation. Keep legacy routes/palette entries as compatibility aliases.

Gate: mounted runtime test proves tab order/default/dispatch and visual/browser check proves shell geometry at representative widths.

### Stage 3 — Vertical slices in dependency order

#### 3A. MindMap

- Use `spec_nodes` for the canonical current mindmap/spec tree.
- Implement search, result selection, drill-in/back, child selection, story preview/detail, criteria, and choice/rank/scalar controls.
- Preserve selection-before-confirm behavior and existing Decision HUD authorization/resolution contracts.
- Render explicit unavailable state for legacy hierarchy Map data when `hierarchy_nodes` has no root.

#### 3B. Flowcharts

- Preserve `flows` authority and decoded `steps_json` validation.
- Port searchable rail, add/remove, cascading hierarchy links, title/description edits, four view modes, step editing/reorder/removal, service-blueprint editing, and task-flow branches.

#### 3C. Roadmap

- Preserve roadmap lane/item authorities and conflict checks.
- Port Value x Complexity, Eisenhower Matrix, Gantt Chart, and Release Plan sub-tabs.
- Port backlog rail, drag/drop, selection/detail, importance/intent/task controls, notes, add-lane validation, and delete confirmation.

#### 3D. Architecture

- Add a unified pane over `architecture_diagrams` authority.
- Support Context, Container, Component, Data Flow levels; search; diagram/code modes; editable labels/boxes/steps; drill-down/back; Numbered/Sequence/Swimlane views.
- Do not infer a UI contract solely from seed data; freeze the architecture payload contract first.

#### 3E. Spec Digest

- Preserve current criteria parsing and `spec_nodes` authority.
- Add Tree, Flat, Wiki modes; All/Needs input filters; searchable page rail; title/body editing; formatting; criteria toggles; related pages/history; status; cascading hierarchy links.

#### 3F. Risk & Tradeoffs

- Add panes over `risks` and `tradeoffs` authorities.
- Support both risk matrix tabs, severity/status filtering, risk selection/detail, status breakdown drill-down, and Scale/Duel/Anchor cards.
- Keep risk/tradeoff records distinct from rich Decision HUD card payloads.

#### 3G. Scrum Planning

- Preserve `planning_items` CRUD and constraints.
- Add prototype-compatible readiness/changelog presentation only where backed by real data.
- Show explicit unavailable state rather than fabricate changelog data.

Gate after each slice: focused contract tests, hostile malformed/error tests, mutation round trips in disposable fixtures, then assembled-tree suite.

### Stage 4 — Adversarial and visual verification

Hostile cases:

- malformed JSON, trailing noise, `{ok:false}`, missing/wrong payloads;
- stale board/project selection and delayed old responses;
- empty hierarchy roots and mixed legacy/current data;
- oversized strings/arrays/deep JSON/duplicate IDs;
- prompt-like text, markup-looking text, ANSI/control characters, malicious URLs;
- stale mutation conflicts, authorization failures, transport failures, retry paths;
- repeated mounts, unmounts, inactive tabs, and slow backend calls.

Visual cases:

- desktop and narrow widths;
- loading, valid empty, error, and populated states;
- long labels and many records;
- keyboard focus and overflow;
- exact colors, typography, spacing, side-rail widths, borders, dialogs, and active states against the hashed reference.

Gate: browser-level or screenshot/computed-layout evidence plus current-SHA functional suite. Text-presence-only tests are insufficient.

### Stage 5 — Release hygiene

- Run complete repository tests from the assembled tree.
- Run `git diff --check`.
- Reconcile changed paths, commit hashes, test commands, exit codes, evidence hashes, and DB pre/post hash for read-only verification.
- Verify remote state only if a later owner-authorized push is requested.
- Do not remove worktrees or generated residue without explicit confirmation.

## Acceptance summary

The work is complete only when:

- the seven prototype tabs and shell are restored;
- each tab is wired to the correct existing authority;
- malformed data cannot silently become a successful empty state;
- stale project responses cannot display or mutate the wrong project;
- inactive polling and duplicate startup work are controlled;
- the live populated data is visible where its authority supports it;
- legacy hierarchy absence is explicit and non-destructive;
- browser/visual evidence proves layout parity, not merely source-text similarity;
- full tests and hostile boundary checks pass at the exact current SHA;
- no unapproved schema, dependency, or cleanup change is introduced.
