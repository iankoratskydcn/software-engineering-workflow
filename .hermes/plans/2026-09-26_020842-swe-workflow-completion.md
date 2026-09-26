# Software Engineering Workflow Completion Plan

> **For Hermes:** Use `parallel-subagent-contract` and `requesting-code-review` to implement this plan task-by-task. Treat every adversarial finding as a proof obligation, not as a suggestion.

**Goal:** Finish the Software Engineering Workflow extension on top of the approved Stage 1 Spec Digest commit, with all seven Stage 2 surfaces hardened, integrated, adversarially verified, and released without regressing existing Decision HUD behavior.

**Architecture:** Keep `spec_nodes` as the authority for hierarchical requirements and MindMap. Keep existing `decisions` and Agent Matrix/telemetry behavior intact. Add only the agreed new tables for Roadmap, Risk & Tradeoffs, Flowcharts, Architecture, and Scrum Planning. Integrate all work onto one canonical branch descended from `fed6d22`; never review a dirty or unrelated worktree.

**Tech Stack:** Python 3 backend with SQLite, CLI contracts in `backend-plugin/cli.py` and `backend-plugin/cli_spec_cmds.py`, single-file frontend in `plugin.js`, Node test runner (`node --test`), pytest, and `npm run test`.

### Repository authority

- Canonical repository root: `/home/ian-koratsky/GitHub/decision-hud`.
- Canonical remote: `https://github.com/iankoratskydcn/software-engineering-workflow.git`.
- Canonical integration branch/worktree: choose and record one dedicated branch/path before Task 0; the current dirty `main` checkout and `/home/ian-koratsky/GitHub/decision-hud-kanban-triage` are not integration targets.
- One integrator owns the canonical branch. Other workers may prepare commits in isolated worktrees but may not advance the canonical branch or review it while dirty.
- Record the plan's SHA-256 hash in the baseline manifest so all workers execute the same plan revision.

---

## Current truth and lessons learned

### Approved baseline

- Stage 1 adversarial gate passed: `fed6d22`.
- Retrospective implementation and adversarial gate passed: `25bcae9` / `t_f90762bf`.
- Stage 2 implementations exist, but most are not accepted for integration because adversarial review found defects.

### Stage 2 implementation commits

| Surface | Initial/approved implementation | Current state |
|---|---:|---|
| Risk & Tradeoffs | `723514d` | remediation required |
| Flowcharts | `4a423c8` | remediation required |
| Architecture | `27afff4` | remediation required |
| Roadmap | `91ff8b8` | remediation required |
| MindMap | `adf525c` | remediation required |
| Scrum Planning | `a6960b8` | remediation required |
| Retrospective | `25bcae9` | independent report PASS bound to the exact committed SHA |

### Failure patterns that are now mandatory proof obligations

1. **Commit provenance:** A passing worker report is not evidence unless the reviewed SHA is committed, reachable from the canonical integration base, and present in the review worktree.
2. **Project authorization:** Every read, write, update, delete, and reverse-ID lookup must receive and verify project scope. A globally guessable row ID is never sufficient authorization. Project scope must be explicit at the command/API boundary; do not silently fall back to a mutable UI "current project".
3. **Resource bounds:** Every text, ID, list, graph, and JSON payload needs explicit type, count, per-value, and aggregate limits before SQLite writes.
4. **Database authority:** API validation is not enough. SQLite FK/CHECK/trigger constraints must protect alternate callers and raw writes.
5. **No mutation on rejection:** Failed validation, stale updates, cross-project access, and failed deletes must leave rows unchanged.
6. **Closed schemas:** Reject unknown keys unless extensibility is explicitly part of the contract and tested.
7. **UI mutation semantics:** On failure, preserve user drafts, surface an error, clear loading state, do not refresh, and avoid unhandled promise rejections. Clear drafts only after confirmed success.
8. **Complete read/write parity:** If a backend field is writable, the UI must expose a minimum edit/clear path or the contract must explicitly remove it.
9. **Migration reconciliation:** Stage 2 branches all touch shared `backend-plugin/db.py` and migration/version logic. Do not cherry-pick blindly; reconcile schema versions and migrations once on the canonical branch.
10. **Baseline separation:** Freeze the known unrelated `npm run test` failures at the pre-Stage-2 baseline. Any changed failure signature is new until disproven.

### Required evidence artifacts

Each gate must write machine-readable evidence under `.hermes/evidence/stage2/` (or the equivalent task workspace):

- `baseline.json`: exact base SHA, worktree path, schema/user version, command, exit code, and normalized failure signatures for **both** pytest and `npm run test`;
- one manifest per surface: reviewed implementation SHA, parent/base SHA, changed-file list, focused test commands/results, and reviewer verdict;
- `integration.json`: final SHA, migration version, fresh/upgraded database results, full-suite results, and unresolved baseline failures.

Evidence is valid only when generated from the clean worktree and exact SHA named in the manifest. A prose report or Kanban status alone is not acceptance evidence.

### Owner decisions required before Task 1

Task 1 is blocked until these decisions are recorded in the contract manifest. Workers may not invent policy values:

| Decision | Required contract | Recommended default if approved | Evidence/owner |
|---|---|---|---|
| Resource limits | Maximum text, ID, list, graph, JSON, nesting depth, and coordinate ranges | Define per-field constants in the contract manifest; reject raw oversized input before parsing | Owner decision |
| Flowchart schema | Exact step keys/types, `next` representation, empty/cyclic/disconnected graph policy | Closed object schema; empty graph explicitly allowed or rejected | Owner decision |
| Architecture schema | Exact node/edge keys, required fields, label rules, coordinate bounds, unknown-key policy | Closed node/edge schemas with finite bounded coordinates | Owner decision |
| Scrum enums | Exact status set and estimate range; sprint null/empty semantics | Explicit enum and finite non-negative estimate range | Owner decision |
| MindMap root | Scope of uniqueness and whether invariant is at-most-one or exactly-one | At most one root per project; unique partial index | Owner decision |
| Legacy rows | Backfill/refuse/quarantine policy for missing `tradeoff.kind` and invalid existing rows | Fail migration with a report unless deterministic backfill is approved | Owner decision |
| Links/deletes | ID vs URL semantics, missing-target behavior, cycle policy, and delete action for each relationship | Same-project IDs; restrict destructive deletes unless explicitly approved | Owner decision |
| Baseline failures | Exact non-blocking signatures and environment/setup requirements | Only unchanged signatures from the committed baseline manifest | Owner decision |

### Canonical data and migration contract

Before implementation, create a committed contract manifest containing, for every new table and JSON field: exact DDL, column types, nullability, defaults, indexes, composite ownership keys, foreign-key actions, CHECK/trigger invariants, request/response shapes, enum values, unknown-key policy, per-field limits, and authoritative reader/writer. The manifest must also define:

| Source database | Expected input version | Ordered migration path | Existing invalid data | Rollback |
|---|---:|---|---|---|
| Fresh | explicit final version | create schema in canonical order | none | documented restore/stop procedure |
| Stage 1 (`fed6d22`) | record actual version from baseline | ordered vN migrations | explicit reject/quarantine/backfill policy | tested restore |
| Other supported deployed versions | enumerate explicitly or mark unsupported | exact path or refusal | explicit policy | tested restore |
| Partially migrated Stage 2 database | enumerate supported states | deterministic reconciliation or refusal | never silently discard data | tested restore |

`PRAGMA user_version` must have one monotonic owner and one final value. Independently authored v8/v9 migrations must be renamed/reconciled before any surface remediation is accepted.

### Non-goals

- Do not redesign the existing Decision HUD.
- Do not modify or duplicate the `decisions` table.
- Do not create duplicate Agent Matrix telemetry or a new Retrospective schema.
- Do not fix unrelated baseline npm failures during this workflow unless a failure is proven newly introduced.
- Do not add speculative abstractions or future-facing fields.

---

## Execution rules for the next agent

1. Start from a fresh canonical worktree based on `fed6d22`; do not use the currently dirty checkout for implementation or review. Record the canonical branch/path and integrator lease before any write.
2. Before every implementation or review task, verify:
   ```bash
   git rev-parse HEAD
   git merge-base --is-ancestor fed6d22 HEAD
   git status --short --branch
   ```
   Expected: intended SHA/ancestor, exit code 0 for ancestry, clean tree.
3. Never treat a Kanban summary as proof. Inspect the actual commit and diff.
4. Use TDD for every remediation: write a failing hostile regression, run it, implement the minimum fix, rerun focused tests, then full tests.
5. Commit every completed remediation before requesting review; record the exact SHA and changed-file manifest in the evidence artifact. Each task evidence record must include `reviewed_sha`, `canonical_parent_sha`, `worktree_path`, `git status`, ancestry result, `git diff --check`, reviewer identity, and report reference.
6. A reviewer must inspect the exact committed SHA, not a parent, sibling worktree, or dirty tree.
7. Keep implementation and adversarial review separate. The implementer never self-approves a gate; the reviewer must independently check out or inspect the exact committed SHA in a clean worktree. A PASS without a report bound to that SHA is invalid.
8. Do not start the integrated Stage 2 adversarial gate until every Stage 2 surface has a PASS gate and a committed SHA manifest.

---

## Task 0: Freeze baseline and create the canonical integration branch

**Objective:** Establish one source of truth for all remaining work and record the exact pre-Stage-2 baseline.

**Files:**
- Read: `.hermes/plans/2026-09-26_020842-swe-workflow-completion.md` (this approved plan)
- Read: `backend-plugin/db.py`, `backend-plugin/cli.py`, `backend-plugin/cli_spec_cmds.py`, `plugin.js`, `package.json`
- Test inventory: `backend-plugin/tests/`, `test/`

**Steps:**

1. Create a fresh integration worktree from `fed6d22`; leave unrelated changes in the user's current checkout untouched.
2. Record the exact baseline commit, plan hash, runtime/setup versions, SQLite `PRAGMA user_version`, and **both** pytest and `npm run test` results, including every failing test name and normalized failure signature.
3. Record the Stage 2 implementation SHAs and their changed-file manifests as historical source inputs. For every remediation, record `source_sha`, `remediation_sha`, and `canonical_parent_sha`; only the remediation commit descended from `fed6d22` may enter integration. Do not cherry-pick an off-base vertical-slice commit without a reviewed port.
4. Do not merge code yet.
5. Write and commit `.hermes/evidence/stage2/baseline.json` plus referenced immutable test logs. Do not make baseline evidence optional or leave it only in a card/log.

**Exit criteria:**

- One canonical integration worktree exists.
- `fed6d22` is an ancestor.
- Baseline test output is reproducible.
- Baseline pytest and frontend failure signatures are frozen separately.
- Every Stage 2 branch is identified by exact SHA.
- Every Stage 2 source/remediation mapping is recorded with full 40-character SHAs.

---

## Task 1: Define shared boundary helpers and test contracts

**Objective:** Prevent each surface from repeating the same trust-boundary defects.

**Likely files:**
- Modify: `backend-plugin/db.py`
- Modify: `backend-plugin/cli.py`
- Modify: `backend-plugin/cli_spec_cmds.py` only if command parsing needs shared validation
- Create/modify: `backend-plugin/tests/test_boundary_contracts.py`
- Modify: `plugin.js` only if a shared UI mutation helper already exists and can be safely reused

**Required behavior:**

- Implement only boundary helpers duplicated by at least two remediated surfaces; keep one-off validation local. For every extracted helper, record the helper-to-surface map in the contract manifest. Helpers cover:
  - strict string/type validation before `.strip()`;
  - maximum text length;
  - maximum list length and per-value length;
  - maximum serialized JSON size;
  - finite numeric coordinate validation;
  - project ownership checks;
  - consistent missing-row errors;
  - no-mutation transaction assertions in tests;
  - raw byte/character limits before JSON parsing;
  - stable boundary error mapping for validation, authorization/not-found, stale/conflict, busy/lock, constraint, and internal failures.
- Establish the connection invariant: every SQLite connection executes `PRAGMA foreign_keys=ON` immediately after opening and before any schema/data statement; add a test that proves a fresh connection cannot write with FK enforcement disabled.
- Use explicit constants. Keep limits conservative and documented in code/tests.
- Do not force unrelated legacy tables through a broad rewrite.
- Add tests proving invalid inputs fail before writes and raw DB constraints remain authoritative where required.
- Define one shared error taxonomy (validation, not-found, authorization, stale-write, constraint) and require CLI/API tests to assert stable machine-readable error identity, not only message text.
- For project-scoped reads, reverse lookups, updates, and deletes, nonexistent, unauthorized, orphaned, and inaccessible IDs must produce the same external status/error shape; do not disclose row existence, project ownership, SQL, or filesystem details.
- Define one CLI contract for all new commands: success envelope, error envelope, exit-code mapping, stdout/stderr policy, missing-row behavior, and payload key. Add parser-level tests for every command.

**Exit criteria:**

- Helpers are reused by at least the remediated surfaces.
- Tests cover type, per-field, count, and aggregate bounds.
- No helper silently coerces invalid types.
- Every accepted JSON object has a closed key set at every nesting level.
- Raw input bounds are checked before parsing; decoded type/depth/count/per-value/aggregate bounds are checked before writes.

---

## Shared surface acceptance contract

Before any surface is accepted, its contract manifest must contain one row per writable field and relationship:

| Surface | Backend field/relationship | Add | Update | Clear/delete | CLI/API signature | UI control/read rendering | Failure test |
|---|---|---|---|---|---|---|---|

Omitted fields require an explicit “not user-editable by design” decision. Every surface must also specify route ID/path, sidebar/tab label/order, palette/open command if applicable, project-scope source, success/empty/error response shape, loading cleanup, stale-response guard, refresh/invalidation rule, and named runtime tests. Missing UI coverage is a blocking failure, not an optional slice.

Every mutable surface (Risk, Flowcharts, Architecture, Roadmap, MindMap, Scrum) must include raw SQLite hostile tests for each mutable table and relationship: malformed/oversized input, cross-project link, orphan/missing target, invalid status/enum, raw insert/update/delete, and no-mutation assertions. Any invariant that cannot be enforced in SQLite must be explicitly marked API-only with a reason and race/failure test.

All relationship contracts must define: target table, ID format, same-project rule, missing-target result, null/empty semantics, delete/update action, cycle policy, and whether the value is an ID, URL, or label. All stored or derived status/order fields must define their authoritative columns, computation query, tie-break ordering, missing-row behavior, and whether writes persist or recompute the value.

---

## Task 2: Remediate Risk & Tradeoffs

**Objective:** Make Risk & Tradeoffs complete, bounded, project-scoped, and failure-safe.

**Historical source:** `723514d` (off-base vertical slice; source context only). **Canonical remediation:** `de09bb21a2aee53172b6aa39e0da0effd656b8c7` / card `t_703b562c`, subject to fresh review from `fed6d22`. Record source→remediation→canonical-parent mapping; do not cherry-pick the off-base source directly.

**Likely files:**
- Modify: `backend-plugin/db.py`
- Modify: `backend-plugin/cli.py`
- Modify: `plugin.js`
- Modify/create: `backend-plugin/tests/test_risk_tradeoff.py`
- Modify/create: `backend-plugin/tests/test_risk_tradeoff_cli.py`
- Modify/create: `test/risk-tradeoffs-tab.test.mjs`

**Required behavior:**

- Add `tradeoff.kind` end-to-end with allowed values: `scale`, `duel`, `anchor`.
- Enforce kind in schema/API/CLI/UI and reject missing/invalid values before writes.
- Bound every risk/tradeoff text field, including title, description, breaks_when, choice, alt_label, cost, and gain.
- Verify oversized input is rejected and row count/content is unchanged.
- Guard status and prioritized-side mutations with the same error/loading semantics as add operations.
- Reject cross-project/orphan decision links.
- Preserve the `decisions` table.
- Define the canonical representation and migration semantics for `kind`, including valid fields by kind, legacy-row backfill/refusal policy, and old-caller compatibility.
- Add raw SQLite hostile tests for every mutable table/link and controlled error mapping.

**Verification:**

```bash
python3 -m pytest -q backend-plugin/tests/test_risk_tradeoff.py backend-plugin/tests/test_risk_tradeoff_cli.py
node --test test/risk-tradeoffs-tab.test.mjs
python3 -m pytest -q backend-plugin/tests
npm run test

git diff --check fed6d22..HEAD
git status --short --branch
```

**Exit criteria:** committed SHA, clean tree, exact ancestry, focused tests green, full backend green, and independent report PASS bound to the exact committed SHA.

---

## Task 3: Remediate Flowcharts

**Objective:** Make flow graph storage bounded, closed-schema, project-scoped, and UI-safe.

**Historical source:** `4a423c8` (off-base vertical slice; source context only). **Canonical remediation:** `f1038bba7a35533520d183814c4e04e79030dc7e` / card `t_95e078ad`, subject to fresh review from `fed6d22`. Record source→remediation→canonical-parent mapping; do not cherry-pick the off-base source directly.

**Likely files:**
- Modify: `backend-plugin/db.py`
- Modify: `backend-plugin/cli.py`
- Modify: `plugin.js`
- Modify/create: `backend-plugin/tests/test_flows.py`
- Modify: `test/flowcharts-pane.test.mjs`

**Required behavior:**

- Bound total serialized `steps_json` size.
- Bound step count, label length, ID length, and outgoing edge count.
- Reject unknown step keys; accepted step shape is explicitly documented and tested.
- Reject duplicate IDs, dangling `next` targets, malformed JSON, invalid types, and oversized payloads before SQLite writes.
- Apply the owner-approved empty graph behavior recorded in the contract manifest; conditional/unspecified behavior is not acceptable.
- Define the exact closed step schema, `next` shape, empty/cyclic/disconnected graph policy, and duplicate-edge policy in the contract manifest.
- Keep project scope on add/list/update/set-steps, including reverse-ID lookup.
- Preserve guarded UI writes, rename/update, error display, loading cleanup, and refresh-only-on-success behavior.
- Add raw SQLite hostile tests for every mutable graph table and relationship.

**Verification:**

```bash
python3 -m pytest -q backend-plugin/tests/test_flows.py
node --test test/flowcharts-pane.test.mjs
python3 -m pytest -q backend-plugin/tests
npm run test

git diff --check fed6d22..HEAD
git status --short --branch
```

**Exit criteria:** named hostile tests for raw 10 MB input rejection before parsing, unknown keys at each nesting level, dangling/duplicate/cyclic graph policy, no row mutation, and clean exact-SHA diff; independent report PASS.

---

## Task 4: Remediate Architecture

**Objective:** Make architecture diagrams project-authorized and semantically validated.

**Historical source:** `27afff4`; **canonical remediation/card:** must be verified and recorded before dispatch. Do not use an unverified “or equivalent” card. The remediation must descend from `fed6d22` and include the source→remediation→canonical-parent mapping.

**Likely files:**
- Modify: `backend-plugin/db.py`
- Modify: `backend-plugin/cli.py`
- Modify: `backend-plugin/cli_spec_cmds.py`
- Modify/create: `backend-plugin/tests/test_architecture_diagrams.py`
- Add mandatory UI tests for the architecture route/tab if the surface is exposed; if it is intentionally backend/CLI-only, record that owner decision and omit the route from the acceptance matrix.

**Required behavior:**

- Require project scope on `get_diagram`, `set_diagram`, CLI `arch set-diagram`, and every reverse-ID path.
- Reject cross-project reads and writes without mutation or data disclosure.
- Validate nodes as objects with required fields and finite numeric `x`/`y` coordinates.
- Enforce unique node IDs and valid labels.
- Validate edges as objects whose endpoints reference existing nodes.
- Bound node count, edge count, ID/label sizes, and aggregate JSON size.
- Validate `drill_to_diagram_id` as same-project when present.
- Apply identical validation to add and set.
- Add raw DB hostile tests and no-mutation assertions.
- Define the exact closed node/edge schemas, required fields, label/coordinate bounds, delete behavior, and same-project `drill_to_diagram_id` contract.
- Add mandatory route/tab consumer tests, including loading, error, empty, stale-response, and failed-mutation behavior; architecture UI coverage is not optional if the surface is exposed.

**Exit criteria:** all hostile probes from the blocked gate are rejected; migration is safe; independent report PASS bound to the exact committed SHA.

---

## Task 5: Remediate Roadmap

**Objective:** Make Roadmap payloads bounded and preserve failed user drafts.

**Historical source:** `91ff8b8`; **canonical remediation/card:** must be verified and recorded before dispatch. Do not use an unverified “or equivalent” card. The remediation must descend from `fed6d22` and include the source→remediation→canonical-parent mapping.

**Likely files:**
- Modify: `backend-plugin/db.py`
- Modify: `backend-plugin/cli.py`
- Modify: `plugin.js`
- Modify/create: `backend-plugin/tests/test_roadmap.py`
- Modify: `test/roadmap-route.test.mjs`

**Required behavior:**

- Bound title/text fields.
- Bound per-link and per-dependency lengths, list counts, and aggregate encoded JSON size in `_roadmap_json` and every write path.
- Reject a 1,000,000-character link before DB write; assert no row mutation.
- Preserve project/stale mutation rejection and explicit clear flags.
- Make `runUpdate` return a success result or throw.
- Clear lane/item drafts only after confirmed success.
- On failure: preserve draft, show error, clean loading state, and do not refresh.
- Add mandatory route/tab registration and runtime tests for delayed responses after project switching; stale responses must not overwrite the active project.

**Exit criteria:** oversized-link and rejected-CLI UI tests pass; independent report PASS bound to the exact committed SHA.

---

## Task 6: Remediate MindMap

**Objective:** Make `spec_nodes` root integrity and text boundaries fail closed before mutation.

**Historical source:** `adf525c`; **canonical remediation/card:** must be verified and recorded before dispatch. Do not use an unverified “or equivalent” card. The remediation must descend from `fed6d22` and include the source→remediation→canonical-parent mapping.

**Likely files:**
- Modify: `backend-plugin/db.py`
- Modify: `backend-plugin/cli.py`
- Modify: `backend-plugin/cli_spec_cmds.py`
- Modify/create: `backend-plugin/tests/test_mindmap_spec_tree.py`
- Modify: `plugin.js`
- Modify: `test/mindmap-pane.test.mjs`, `test/mindmap-decision-attachment.test.mjs`, `test/mindmap-spec-authority.test.mjs`

**Required behavior:**

- Enforce the invariant “at most one `(project_id, level=0, parent_id IS NULL)` row per project” with the existing or newly verified unique partial index.
- Reject a second root before insertion/update commit.
- Preserve the original root and row count after rejection.
- Perform authorization, preconditions, and mutation in one transaction (`BEGIN IMMEDIATE` or equivalent). Add a two-writer race test: exactly one succeeds, the other receives a controlled integrity/conflict error, and the final root count is one. A preflight count in application code alone is insufficient.
- Keep read-time multiple-root detection as defense in depth.
- Bound the explicitly listed spec-node fields (title, description/body, rationale, acceptance/criteria, metadata JSON, and any other writable field in the contract manifest); reject a 1 MiB title with no mutation.
- Preserve canonical `spec_nodes.decision_id` linkage and UI attachment through `decision spec link-decision`.
- Preserve cycle/orphan/project validation.
- Add mandatory UI tests for attach/read-back after reload and project switch, failed attachment draft/state preservation, loading cleanup, no refresh on failure, and no unhandled rejection.

**Exit criteria:** duplicate-root and oversized-title hostile tests pass; independent report PASS bound to the exact committed SHA.

---

## Task 7: Remediate Scrum Planning

**Objective:** Make planning integrity enforceable by SQLite, not only by supported API paths.

**Historical source:** `a6960b8`; **canonical remediation/card:** must be verified and recorded before dispatch. Do not use an unverified “or equivalent” card. The remediation must descend from `fed6d22` and include the source→remediation→canonical-parent mapping.

**Likely files:**
- Modify: `backend-plugin/db.py`
- Modify: `backend-plugin/cli.py`
- Modify: `backend-plugin/cli_spec_cmds.py`
- Modify/create: `backend-plugin/tests/test_scrum_planning.py`
- Modify/create: `backend-plugin/tests/test_scrum_planning_cli.py`
- Modify: `plugin.js`
- Modify: migration tests such as `backend-plugin/tests/test_v5_missing_constraint.py`

**Required behavior:**

- Add DB-level FK enforcement for `planning_items(project_id, spec_node_id)` referencing a declared UNIQUE `(project_id, id)` key on `spec_nodes`, with explicit `ON DELETE`/`ON UPDATE` actions recorded in the contract manifest. Every connection factory enables and verifies `PRAGMA foreign_keys=ON`; triggers are required for any invariant not covered by the composite FK.
- Add CHECK constraints for allowed status and estimate bounds.
- Ensure migration works on existing databases and preserves valid data.
- Before adding constraints, run an explicit preflight that reports/quarantines invalid existing rows; never silently delete, reassign, or weaken the constraint to make migration pass. Migration must be atomic and rerunnable.
- Prove raw INSERT/DELETE/cross-project attempts fail and preserve rows.
- Preserve transactional rejection of deleting linked spec nodes using the declared FK action; test both FK-enabled configured connections and document that an intentionally raw FK-disabled connection is outside the application trust boundary.
- Validate sprint type before string operations and enforce a maximum length on add/update.
- Reject 200,000-character and non-string sprint values with controlled errors and no mutation.
- Add mandatory route/tab registration and runtime UI tests for loading/error/empty states, failed mutation draft preservation, loading cleanup, no refresh on failure, stale project-switch responses, and no unhandled rejection.

**Exit criteria:** raw DB hostile tests pass, migration tests pass, independent report PASS bound to the exact committed SHA.

---

## Task 8: Retrospective confirmation

**Objective:** Preserve the already-cleared Retrospective result while integrating it with the final branch.

**Starting point:** `25bcae9`.

**Required behavior:**

- User-facing Retrospective labels remain intact.
- Internal Agent Matrix route/constants, telemetry command, legacy aliases, and section isolation remain intact.
- Do not create a new schema.

**Verification:** rerun the focused Retrospective/combined-page/pinned-pane tests after integration. Do not rework this surface unless integration causes a real regression.

---

## Task 9: Canonical Stage 2 integration

**Objective:** Assemble all accepted surfaces into one branch without migration, CLI, or UI regression.

**Order:**

1. Start from `fed6d22` and record the exact canonical branch/worktree.
2. Freeze and land the contract manifest and one canonical migration allocation before surface work.
3. Build a changed-file overlap matrix. Shared `db.py`, `cli.py`, `plugin.js`, migration code, and common fixtures are serially owned by the integrator; surface workers may not independently overwrite them.
4. Integrate schema/migrations first. Reconcile all `user_version` changes and table creation paths manually; define one monotonic target version, one transaction per upgrade path, and an idempotent fresh-database path.
5. After each schema merge, run migration tests and record the result. Reconcile one canonical implementation per shared function/table/migration; record discarded hunks and rationale.
6. Integrate backend helpers/constraints, then CRUD/validation, CLI contracts, UI routes/tabs, and tests in that order. Run surface tests after each shared-file merge.
7. Run full backend/frontend suites, migration rollback probes, and cross-surface hostile tests.
8. Commit one canonical Stage 2 integration SHA and write the acceptance manifest mapping every surface's reviewed SHA/report to the final tree.

**Required cross-surface checks:**

- Existing Decision HUD card stack unchanged.
- Existing Agent Matrix/Retrospective telemetry unchanged.
- `decisions` schema unchanged.
- Project switching never leaks rows between surfaces.
- No shared SQLite connection executes statements before FK activation.
- A direct connection test verifies `PRAGMA foreign_keys` is `1` before any application statement; a deliberately unconfigured connection is rejected by the connection factory rather than silently accepted.
- Every rejected mutation leaves rows and UI drafts unchanged.
- Route transitions produce no new warnings/errors.
- One migration path works from a fresh DB and from a DB at the Stage 1 schema version.
- A failed migration rolls back schema/data changes and leaves the pre-migration database reopenable.
- `backend-plugin/tests/test_stage2_migrations.py` proves fresh creation, Stage 1 upgrade, every supported partially migrated state, schema/user-version snapshot, preserved rows, second-run idempotence, and midway-failure rollback.
- `backend-plugin/tests/test_stage2_integration.py` proves `decisions` schema snapshot equality, project-switch isolation, FK activation before writes, route warning capture, and rejected-mutation row/draft snapshots.

**Exit criteria:** one clean committed integration SHA, complete changed-file manifest, reproducible test output, and no unclassified failures.

---

## Task 10: Integrated Stage 2 adversarial gate

**Objective:** Independently attack the fully integrated workflow, not individual branches.

**Review lanes:**

1. **Provenance lane:** exact SHA, ancestry, clean tree, diff check, migration history.
2. **Authorization lane:** project switching, reverse-ID reads/writes, decision/spec/planning links.
3. **Resource lane:** text, list, graph, JSON, coordinate, and aggregate size boundaries.
4. **Database lane:** raw INSERT/UPDATE/DELETE, FK/CHECK/trigger behavior, transaction atomicity.
5. **UI lane:** rejected mutations, draft preservation, loading cleanup, no unhandled rejections, no refresh on failure.
6. **Regression lane:** Decision HUD, Spec Digest, Retrospective/Agent Matrix isolation.
7. **Baseline lane:** compare npm failures to the frozen parent baseline.

**Exit criteria:** every lane emits a committed report containing lane, reviewed SHA, worktree, commands, result, findings, reviewer, and evidence paths. All report SHAs must equal the canonical integration SHA. Baseline findings are non-blocking only when their normalized signatures exactly match `baseline.json`; any new or changed failure blocks release.

---

## Task 11: Release verification

**Objective:** Verify the final artifact and hand off a reproducible release state.

**Required output:**

- Final commit SHA
- Parent/base SHA
- Migration version and upgrade path
- Changed-file manifest
- Backend focused/full test counts
- Frontend focused/full test counts
- Baseline comparison
- Known limitations
- Rollback instructions
- Exact command sequence for a fresh checkout and an upgraded existing DB
- Evidence artifact paths or attachment IDs for each claim above
- Surface-by-surface acceptance matrix mapping backend/CLI/UI tests to every contract row

**Release gate:**

```bash
python3 -m pytest -q backend-plugin/tests
npm run test
python3 -m py_compile backend-plugin/db.py backend-plugin/cli.py backend-plugin/cli_spec_cmds.py
git diff --check <parent>..HEAD
git status --short --branch
```

Also run the migration rollback probe against a copy of a Stage 1 database and assert the post-failure schema version and row hashes match the pre-migration snapshot.

The release commands must run in the declared canonical worktree and assert:

```bash
test "$(git rev-parse HEAD)" = "$FINAL_SHA"
git merge-base --is-ancestor "$PARENT_SHA" "$FINAL_SHA"
test -z "$(git status --porcelain)"
```

Save command output and parsed passed/failed/skipped/errored/total counts to the release manifest. Counts must come from the named command output; parametrized tests and focused/full overlap must be reported consistently.

Rollback is forward-only: stop the service, restore the validated pre-migration SQLite backup, verify schema version and row hashes, then deploy the prior commit. No downgrade migration is promised unless separately specified and tested.

The release cannot be called complete if any named acceptance criterion is unverified.

---

## Handoff prompt for the next agent

> Implement `.hermes/plans/2026-09-26_020842-swe-workflow-completion.md` from top to bottom. Start with Task 0 and inspect the actual repository and exact commit SHAs before changing code. Do not trust prior worker summaries. Use a canonical integration worktree descended from `fed6d22`. Complete each remediation with RED → GREEN tests, commit it, and obtain an independent adversarial review of the exact committed SHA. Do not start the integrated Stage 2 adversarial gate until all seven Stage 2 surfaces have PASS gates. Preserve the existing `decisions` table, Decision HUD behavior, and Agent Matrix telemetry. Treat project authorization, resource bounds, DB-level constraints, no-mutation-on-failure, UI error semantics, commit provenance, and migration reconciliation as mandatory proof obligations. Report blockers explicitly rather than waiving them.

---

## Definition of done

The workflow is done only when:

- All seven Stage 2 surfaces are implemented and adversarially cleared.
- Every accepted implementation is reachable from one canonical integration SHA.
- Fresh and upgraded SQLite databases migrate successfully.
- All project-scoping and raw-database hostile tests pass.
- Oversized and malformed inputs fail before mutation.
- Failed UI mutations preserve drafts and clean state.
- Existing Decision HUD, Spec Digest, and Retrospective behavior passes regression tests.
- Integrated Stage 2 adversarial and release gates pass.
- The final report contains exact commit, tests, baseline comparison, and rollback details.
