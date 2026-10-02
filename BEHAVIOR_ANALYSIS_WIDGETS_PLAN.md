# Agent Matrix behavior-analysis extension — implementation plan

**Status:** owner decisions resolved; Wave 0a contract implementation may be unblocked. Downstream implementation remains gated on RED contract tests and live producer evidence.

**Target:** extend the existing Agent Matrix inside Decision HUD. Do not rebuild existing widgets or create a duplicate route. The attached HTML mockup is a reference for interaction ideas, not a production route.

## 1. Existing system

`plugin.js` already has six real-data widgets with shared selection state:

| Widget | Existing implementation | Source |
|---|---|---|
| Heatmap | `AgentMetricsHeatmap` | `agent_metrics_snapshot.py` |
| Scatter | `AgentMetricsScatter` | same |
| Parallel coordinates | `AgentMetricsParallelCoordinates` | same |
| Treemap | `AgentMetricsTreemap` | same |
| Radar | `AgentMetricsRadar` | same |
| Sankey | `AgentMetricsSankey` | `task_links` parent/child assignee links |

Do not rebuild these six from the mockup. `task_links` is a structural parent/child source, not a dedicated handoff log; `task_events` is the durable task-lifecycle log. The raw-link count must not be reported as rendered handoff volume because same-assignee links are excluded by the current snapshot adapter.

Keep `assignee`, `profile`, `agent`, `model`, `provider`, `task`, and `session` distinct. No implicit fallback between identities.

## 2. Four candidate views and validity boundary

The missing views are multi-baseline, ABC alluvial, Fogg B=MAP, and COM-B. Current data can support operational telemetry, but field relabeling does not prove behavioral constructs or causal intervention effects.

Owner decision: the familiar ABC/Fogg/COM-B names may appear in the UI as **experimental proxies**, with a visible experimental/proxy badge and explanatory text. They must not claim validated construct measurement or causality. Neutral operational source labels remain mandatory in details and API payloads.

- **Multi-baseline:** event-aligned outcome view; blocked until verified live intervention events exist.
- **ABC:** descriptive task-state/run-flow view unless ordered antecedent/behavior/consequence events are later instrumented.
- **Fogg:** failure/completion diagnostic unless an owner-approved bounded scoring model defines cap, clipping, denominator, window, and missing-data rules.
- **COM-B:** operational factor profile unless each axis has a defensible source, normalization, and run/model join.

Inferred observations may appear in the main views with a lower-confidence badge, but they are never eligible for intervention-window or causal calculations. Live and inferred provenance must remain separate in data, UI, and tests.

## 3. Source authority, identity, and time contract

| Dimension | Source | Constraint |
|---|---|---|
| Task/run outcome | Kanban `tasks`, `task_runs` | query with an explicit time window; no silent all-history default |
| Block reason | `tasks.block_kind` | current/post-hoc state, not an antecedent event |
| Retry/failure | ordered `task_runs`, `block_recurrences`, `consecutive_failures` | counters are mutable; expose raw semantics and denominator |
| Model | `task_runs`/`tasks.model_override` plus Hermes usage | no proven one-to-one mapping to assignee/profile |
| Profile/assignee | `task_runs.profile`, `tasks.assignee` | distinct from model/provider |
| Usage/cost | Hermes `sessions`, `session_model_usage` | session-linkage and Codex-cost gaps remain |
| Intervention | deliberate producer event only | absent until live capture is observed |

Every read contract includes typed `subject_type` and `subject_id`, authenticated project scope, source timestamp, provenance, freshness/coverage, and status: `ready`, `empty`, `stale`, `unavailable`, or `insufficient_sample`.

Windows are UTC, `since` inclusive and `until` exclusive. Task/run event timestamps define inclusion. Running/incomplete rows are excluded by default. Each metric states unit of analysis, numerator, denominator, minimum sample count, and treatment of missing data.

Cross-source joins require a stable correlation key and matching window. If a join is not defensible, return `unavailable`; never blend unrelated project/session/model rows.

## 4. Candidate payload semantics

### Event-aligned outcome view

The backend must return subject identity, event identity/kind/time, live versus inferred provenance, baseline and post-event windows with numerator/denominator, coverage gaps, and status. Inferred events may be displayed as context but cannot satisfy live intervention acceptance.

### ABC proxy

`block_kind` is a task-state reason, not an antecedent. `COUNT(task_runs)>1` is not automatically retry behavior because runs have different outcomes and step keys. If shipped, label the view descriptive and expose `state_reason`, ordered run outcomes, terminal outcome, and denominators.

### Fogg proxy

Do not use `1 - consecutive_failures/cap` until `cap`, clipping, reset behavior, window, denominator, and minimum sample are fixed. Initial implementation should expose raw failure/completion statistics, not claim ability or motivation.

### COM-B proxy

Block causes are operational causes, not capability. Session cost is not opportunity, and session totals must not be copied onto every task/run in a multi-model session. Until valid axes and joins exist, expose a neutral operational profile with explicit source names.

## 5. Live intervention seam

No dedicated intervention/change-event stream currently exists. `kanban.db.task_events` is lifecycle history, not an explicit before/after routing-change log. `state.db.gateway_routing` and `context_events` have no usable history. Rotated agent logs and `usage_audit.jsonl` are not authoritative event sources.

Owner decision: use **Option B**. Canonical live events are deliberate model/config interventions only:

- explicit user/admin model or provider switch;
- explicit persisted routing-policy/config mutation;
- other owner-authorized route assignment changes with before/after state.

Automatic fallback/failover, retries, credential rotation, routine route resolution, and inferred history are separate non-causal telemetry. They may be added later as operational event classes but cannot be treated as interventions.

First test whether a typed marker fits existing `telemetry_snapshots` plus `metric_history`. Add a separate event table only if a contract spike proves reuse insufficient.

If a separate store is approved, require: stable idempotency key; canonical project scope; typed subject; allowlisted kind; producer/source; actor/system identity; before/after state; bounded reason; UTC `occurred_at`; server `created_at`; `provenance=live|inferred`; derivation version/evidence interval; bounded redacted object payload; deterministic bounded reads; retention policy; authenticated project-scoped HTTP access; fresh-database-safe migration.

Producer ownership is cross-repository:

- Hermes core: deliberate model-switch/config seams are separate from fallback recovery; actual checkout is `/home/ian-koratsky/hermes-agent`.
- Sidecars: retain `sidecar.measurement` telemetry. It becomes intervention telemetry only when an operation actually changes an authoritative route/result/state; prediction or shadow output is not an intervention.

Producer scope must derive server-side from canonical project/board context or a scoped capability. Never trust arbitrary task payload scope. Capture must be non-blocking, bounded, and loss-accounted; a telemetry failure must not block the primary operation or make an incomplete analysis look complete.

Inferred backfill, if retained, joins `session_model_usage.session_id` to `sessions.id`, obtains `sessions.profile_name`, records gap bounds and derivation version, carries `inferred=true`, and displays a lower-confidence badge. It cannot generate an intervention window.

## 6. TDD delivery waves

### Wave 0a — contract seam

Implement the owner-approved source, identity, UTC-window, status-envelope, experimental-label, provenance, and selection contracts. Write RED tests first; observe expected failures; implement minimally; run focused GREEN tests. Do not finalize DDL until telemetry-snapshot reuse versus a new table is proven.

### Wave 0b — producer prerequisite

Instrument deliberate model/config interventions in Hermes core at the actual successful state-mutation chokepoints. Emit before/after identity, source, actor, reason code, correlation/idempotency key, and provenance. Add Sidecars only if the frozen contract requires applied sidecar effects. Add RED tests for exactly-once event emission, no event on failed/rolled-back changes, secret redaction, and non-blocking failure behavior. Verify a live canary reaches the authorized Decision-HUD read path.

### Wave 1 — backend read models

Build bounded task/run descriptive aggregates, failure/completion diagnostics, and event-aligned outcome payloads only when live event evidence exists. Reuse existing `metric_history` unless a failing test proves it insufficient. Preserve explicit unavailable/empty/stale/insufficient states. No heuristic causal backfill.

### Wave 2 — frontend integration

Use one shared integration lane for `plugin.js`, selection state, status envelopes, experimental badges, and regression tests. Each view declares its grain. Cross-filter only through canonical common keys: project scope plus subject/task/run identity. Do not coerce model/profile/assignee. Each view owns its own status state and renders no fabricated zero geometry.

### Wave 3 — merge and acceptance gate

Merge one lane at a time. Verify backend, frontend, Hermes core, and any Sidecars changes independently. Run focused RED/GREEN tests, full suites, fresh/populated database migration/read-back canaries, authenticated scope tests, producer live canary, route/reference scan, `compileall`, `git diff --check`, and exact remote SHA read-back. No push or merge beyond repository policy without authorization.

## 7. Acceptance gate

- [ ] Experimental ABC/Fogg/COM-B labels have visible proxy/experimental treatment and no unsupported causal claim.
- [ ] Every metric has source, identity grain, scope, UTC window, timestamp, numerator, denominator, provenance, and status.
- [ ] Live and inferred observations are distinguishable; inferred rows cannot drive intervention windows.
- [ ] Model/profile/assignee/provider identities remain distinct and tested.
- [ ] Fresh and populated database migration/read-back behavior is proven if new storage is approved.
- [ ] Event writes are idempotent; same-key/different-content conflicts fail closed.
- [ ] Reads are bounded, deterministic, authenticated, and server-scope-derived.
- [ ] Producer failures preserve the primary operation and expose capture loss/incomplete state.
- [ ] Each view has ready/empty/stale/unavailable/insufficient rendering with no fabricated zeros.
- [ ] Cross-filter tests assert matching/nonmatching DOM state, clear, partial selections, and stale-selection reset.
- [ ] The attached mockup is not a live route; canonical Agent Matrix remains registered.
- [ ] Full relevant suites pass and all unresolved evidence is documented.

## 8. Owner decisions recorded

1. ABC/Fogg/COM-B names are allowed as experimental proxies, not validated claims.
2. Identities remain typed and distinct; no implicit fallback.
3. Windows are UTC `[since, until)`; running rows excluded; minimum samples yield `insufficient_sample`.
4. Reuse `telemetry_snapshots`/`metric_history` first; new storage requires proof.
5. Canonical live events are deliberate model/config interventions; fallback/retry/failover are non-causal operational telemetry. Sidecars remain measurement telemetry unless they apply an authoritative effect.
6. Inferred observations may appear in main views with a lower-confidence badge, but never drive intervention-window or causal calculations.

Wave 0a may now be unblocked. Downstream cards remain dependency-gated until the contract tests and live producer evidence pass.
