# Daily Cadence Plan: Scrum of Scrums for a Solo Dev + AI Fleet

Status: draft plan (brainstorm output, 2026-10-01). Nothing here is built yet.

## 1. Problem

Building with AI without structure ("vibing") produces code that drifts into a mess:
specs live in prompts, work is never sized, review happens whenever, and nothing
measures what actually worked. The human ends up live-prompting the very thing being
built.

AI agents are not tired by ceremonies. The human needs them. This plan uses Scrum/SAFe
ceremonies as the structure that lets one developer run a fleet of agents like a
small company, at an hourly cadence, across a workday of variable length.

## 2. Goals

1. **A schedule for the day.** Given the hours available, produce a concrete plan of
   blocks, hours, and ceremonies, plus a forecast of what will land.
2. **Correct estimation.** Every hour produces estimate-vs-actual data; the forecast
   is driven by measured velocity, not hope.
3. **Spec before build.** The human specs work ahead of the fleet; agents build in the
   background from what was specified.
4. **Measured improvement.** An append-only observation log feeds a retro that changes
   the process, not just reports on it.
5. **One holistic set of screens** driven by the clock, not a menu of unrelated tabs.

Non-goals: multi-human teams, time tracking for billing, replacing Kanban/Decision HUD
(they are reused).

## 3. Core principles

- **The human is the bottleneck, by design.** Throughput is capped by the human's
  comprehension and approval. All flow control (WIP, review buffer, feature size) is
  set relative to review capacity, not fleet capacity.
- **Pipeline, don't pair.** The human never works on the feature the fleet is
  building. In any hour: fleet builds N, human specs N+1 and reviews N-1.
- **Timebox is the anti-vibe guardrail.** At :60 a feature is done or it carries over.
  No "one more prompt."
- **Observations are facts, never edited.** Corrections are new appended records.
- **Run it manually before automating it.** Each ceremony is exercised by hand (timer +
  checklist) before its screen or agent is built.

## 4. The cadence

### 4.1 Units

| Unit | Length | SAFe analogue |
|---|---|---|
| Sprint | 1 hour | Iteration |
| Block | 1 retro/plan hour + N work hours, N = 2..6 | Program Increment (PI) |
| Day | 1+ blocks, sized to hours available | — |

### 4.2 Block shape: retro first

Each block **opens** with its retro/plan hour, then runs N work hours:

```
Block = [R: retro of previous block + plan this block] [W1] [W2] ... [WN]
```

- The day's first R reviews the **previous day's** last block. The day starts with
  yesterday's retro.
- Opening with R also primes the pipeline: R ends with W1's feature(s) spec'd and Ready.
- Later blocks in the same day open with an R covering the block just finished.

### 4.3 Day planner

Input: hours available today. Output: block layout + forecast.

| Hours | Layout (R+N) |
|---|---|
| 3 | 1+2 |
| 5 | 1+4 |
| 7 | 1+6 |
| 12 | (1+5) x2, or (1+6)+(1+4) |

Rules: N between 2 and 6; prefer fewer, longer blocks; the human can override.
Forecast = rolling accepted-points-per-hour x remaining work hours, applied down the
ranked roadmap, showing which features realistically land today.

### 4.4 Inside a work hour

| Minute | Ceremony | Human | Fleet |
|---|---|---|---|
| :00-:05 | Sprint planning | Commit Ready feature(s) for this hour, within review capacity | Team leads decompose into Kanban cards, dispatch |
| :05-:35 | Refinement | Spec N+1: map, criteria, diagrams, risks | Build N |
| every 20 min | Standup (scrum of scrums) | Read one standup report | Observer gathers status across all teams (section 5.1) |
| :35-:50 | Review / demo | Accept or reject N-1 against criteria + PR | QA agent pre-verified criteria |
| :50-:55 | Decision sweep | Clear any decision cards not already handled | — |
| :55-:60 | Mini retro | Log estimate vs actual; mark carryovers | Scrum master writes hour summary to log |

Minute boundaries are a starting hypothesis; the first manual trial will adjust them.
Blockers do **not** wait for :50 (see section 7).

### 4.5 Inside the R hour

1. Read the observation log for the block under review (or the previous day).
2. Deduce what did and did not work: estimate error, carryovers, rework, blockers and
   the spec gaps behind them, review load, interruptions.
3. Decide process changes (each one is logged as a `process_change` observation).
4. Re-rank the roadmap; update velocity; plan the block's hours.
5. Spec W1 to Definition of Ready.

### 4.6 Carryover

Unfinished work carries to the next hour. It is never silently extended. Each carryover
is logged with original estimate and hours consumed; it feeds the next forecast
("what is feasible in the next round").

## 5. Roles: the company

| Role | Who | Responsibility |
|---|---|---|
| Product owner / architect | Human | Spec, rank, accept/reject, decide |
| Scrum master | Agent | Runs the clock, nudges phase changes, writes hour summaries, enforces DoR/DoD |
| Observer | Agent (read-only) | Every 20 minutes, gathers a standup report on sprint progress (section 5.1) |
| Team lead | Agent per feature | Decomposes a feature into cards, coordinates workers |
| Dev workers | Subagents | Implement cards |
| QA | Agent | Verifies acceptance criteria before human review |
| Reviewer | Agent | First-pass PR review; attaches a diff explainer for the human |

Existing Hermes plumbing to reuse: Kanban dispatch, `auto_decompose_enabled`,
`review_dispatch_enabled`, Kanban-block to Decision-card escalation, `host.notify`.
New: the scrum master and observer roles, and the clock they run on.

### 5.1 Observer: standup reports

A read-only agent that gathers a report on how the sprint is progressing.

- **When:** every 20 minutes while the human is online. Paused during the R
  (retro/plan) hour.
- **Online switch:** a manual on/off toggle on the Day screen. It turns off
  automatically after 1 hour with no interaction in the app. Toggling on, toggling off,
  and auto-off are each appended to the log as `presence` records.
- **Reads:** Kanban cards per team, the current hour's committed features, elapsed time,
  open blockers, the review buffer, and the observation log.
- **Reports, per team:** feature, cards done / in progress / blocked, on-track vs the
  hour (progress against time elapsed), open blockers, and anything at risk of
  carryover. Plus fleet-wide: review buffer depth and forecast impact.
- **Delivery:** one low-priority digest card plus a quiet desktop notification. It
  never preempts a blocker ping.
- **Read-only:** it never dispatches, reassigns, unblocks, or edits. Its only write is
  appending the report to the observation log as a `standup` record, which the retro
  can later compare against what actually happened.

## 6. Estimation

- **Points are kept** (Fibonacci 1,2,3,5,8,13, already in `planning_items`).
- **Points size the human's cost**, chiefly review/comprehension load (diff size,
  novelty, files touched), plus spec effort. Fleet build effort is secondary.
- **Velocity = accepted points per work hour**, rolling. Built-but-unreviewed work does
  not count.
- **Feature size rule (for now):** one feature = one hour of fleet work, reviewable in
  about 10 minutes. Larger features must be split during refinement.
- Every hour logs estimate, actual (accepted / carried), and review minutes spent.

## 7. Flow control

### 7.1 Definitions

- **Definition of Ready** (to commit at :00): acceptance criteria present, estimate
  present, fits the size rule, dependencies resolved, risks noted.
- **Definition of Done** (to accept): criteria verified by QA agent and human, tests
  pass, PR reviewed, merged.

### 7.2 Parallelism and the review buffer

Multiple features may build in parallel, one team lead each. Planning at :00 commits
only as much as the human can review. A **review buffer** caps features awaiting human
review (starting cap: 2).

### 7.3 When the buffer is full: open decision

| Option | Gains | Costs |
|---|---|---|
| **A. Stop and polish**: idle teams improve work already pending review (tests, diff explainers, diagrams, QA) | Makes the bottleneck faster; no inventory pile-up; estimates stay clean | Fleet capacity sits partly idle; polish can become gold-plating |
| **B. Pull ahead**: idle teams start the next Ready feature | Uses fleet capacity; helps if the human speeds up | Builds unreviewed inventory (lean waste); rework cascades when review feedback changes shared code or spec; merge churn as accepted work lands; spends tokens on work that may be rejected; adds pressure on the human; muddies velocity data |
| **C. Guarded pull**: B only for features with no shared files or spec ancestry with anything in review, max 1, labeled at-risk, no PR until the buffer frees | Captures most of B's upside while containing rework | More rules to enforce; independence checks can be wrong |

**Recommendation:** A for the manual trial and first blocks. Log fleet idle time. Move
to C only if retro data shows idle capacity is costing real throughput. B is rejected:
it optimizes the non-bottleneck.

### 7.4 Blockers ping immediately

- An agent blocker raises a Decision card **and** a desktop notification at once,
  regardless of the human's current hat (Spec / Review / Decide / Retro).
- The card must be answerable in under 2 minutes: feature, failing criterion, options,
  agent recommendation, links.
- One click returns the human to the exact screen they left.
- Each ping is logged (raised, answered, time-to-unblock). In R, every blocker is
  traced to the spec gap that caused it, and the Definition of Ready is tightened.
  Fewer gaps, fewer pings, more flow.

## 8. Observation log

Append-only record of everything the retro reads.

- **Format:** JSONL, one record per line.
- **Write path:** only via an append command (`hermes decision observe add ...`) used by
  the human UI and agents. No edit or delete commands exist.
- **Corrections:** a new record with `supersedes: <id>`. The original stays.
- **Single writer:** `observe add` takes an exclusive interprocess file lock (flock /
  Windows `msvcrt.locking`) around read-tail, seq allocation, append, and fsync, so
  concurrent writers (human UI + many agents) cannot emit duplicate `seq` values.
- **Tamper evidence:** each record carries a monotonic `seq` and `prev_hash` (SHA-256 of
  the previous line), forming a hash chain. In-place edits, deletions, and reordering
  break the chain. Truncation or a full rewrite with a fresh valid chain is caught by
  **checkpoints**: each retro records the log head (`seq`, hash) in the Decision HUD
  database via a human-confirmed action, and the reader verifies the log still
  extends the last checkpoint.
- **Threat model:** this detects accidental or careless agent writes, not a determined
  adversary with full filesystem and DB access, and records written after the last
  checkpoint can still be truncated undetected. True write isolation is out of scope.

Record shape:

```json
{"id": "obs_...", "seq": 412, "prev_hash": "sha256:...", "ts": "2026-10-01T14:55:02Z",
 "day": "2026-10-01", "block": 2, "hour": 3,
 "kind": "estimate_actual", "feature_id": "spec_node_id or null",
 "author": "human | scrum_master | team_lead | qa | reviewer",
 "data": {"estimate": 3, "accepted": 0, "carried": true, "review_minutes": 12},
 "supersedes": null}
```

Kinds (initial): `plan`, `estimate_actual`, `carryover`, `accept`, `reject`, `rework`,
`blocker_raised`, `blocker_answered`, `standup`, `presence`, `hat_switch`, `fleet_idle`, `note`,
`retro_finding`, `process_change`.

## 9. Screens

The clock drives navigation. Tabs become destinations the current phase sends you to.

| Screen | Purpose | Replaces / absorbs |
|---|---|---|
| **Day** (home) | Block/hour timeline, current phase + countdown, "you should be doing X now", fleet status, forecast | new |
| **Refine** | Map view + Spec view of one tree; typed diagrams; risks/tradeoffs on the node | MindMap, Spec Digest, Flowcharts, Architecture, Risk & Tradeoffs |
| **Plan** | Roadmap (ranked features, today's cut line) + Day plan (hour slots, carryovers) | Roadmap, Scrum Planning |
| **Review** | Review buffer queue; per feature: criteria checklist, QA result, diff explainer, PR link, accept/reject | new |
| **Decide** | Decision queue (blocker pings land here) | Decision HUD (kept) |
| **Retro** | Log-driven view of a block or day: estimate error, carryovers, blockers to spec gaps, review load, idle time; record findings and process changes | Retrospective |
| Kanban | Card execution (unchanged) | — |

## 10. Data model changes

| Change | Detail |
|---|---|
| **One tree** | `spec_nodes` is the single tree for Map and Spec views. Add `kanban_task_id`. Retire `hierarchy_nodes`, the `decision node *` CLI, `HierarchyMapPane`, and the `/decision-hud/map` route. |
| **Typed diagrams** | One `diagrams(id, project_id, kind, title, source, spec_node_id, ...)` table replaces `flows` and `architecture_diagrams`. `kind` is chosen at creation and drives template, validation, and rendering. Start with `component` (code) and `process` (concept). Stored source: Mermaid (pending spike, section 13). |
| **Roadmap** | Rank lives on feature-level `spec_nodes` (`rank`, depends-on). Retire `roadmap_lanes` / `roadmap_items`. |
| **Cadence** | New `days`, `blocks(day_id, index, work_hours)`, `hours(block_id, index, kind retro/work, start, end)`. `planning_items.sprint` becomes `hour_id`. |
| **Risks/tradeoffs** | Attach to `spec_node_id`. |
| **Observations** | JSONL log (section 8). |

## 11. Build sequence (thin slices)

Each slice is end-to-end: CLI, screen, link to its neighbors, one test path. CI comes
first so every later slice is verified.

| # | Slice | Acceptance |
|---|---|---|
| 0 | **CI** for this repo; frontend test deps pinned so a fresh clone is green | Fresh clone, `npm test` and `pytest` pass in CI |
| 1 | **Observation log** | `observe add` appends; no edit path exists; `supersedes` works; concurrent writers yield unique, gap-free `seq`; edited, deleted, reordered, or truncated records fail verification against the hash chain and last checkpoint |
| 2 | **Day screen + planner** | Enter hours, get the R+N layout; live phase countdown; phase transitions logged |
| 2b | **Observer standups** | Fires every 20 min only while the online switch is on; switch turns off after 1 h without interaction; silent during R; report appended as `standup`; makes no other writes |
| **Manual trial** | Run one 1+2 block with slices 1-2b and Claude/Hermes sessions as the fleet | Log contains a full block; R produces at least one process change |
| 3 | **One tree + Kanban link + DoR check** | Story created in Map shows in Spec; links to a Kanban card; commit blocked unless DoR passes |
| 4 | **Plan screen** | Ranked features; hour slots; carryover moves work forward and logs it; forecast reads velocity from log |
| 5 | **Blocker pings** | Kanban block becomes a context-complete Decision card plus a desktop notification; return-to-context works; ping logged |
| 6 | **Review screen + buffer cap** | Accept/reject logged; dispatch refuses new work when buffer is full (policy A) |
| 7 | **Scrum master agent** | Phase nudges; hour summary written to log |
| 8 | **Retro screen** | Reads log for a block or day; shows estimate error, carryovers, blockers to spec gaps; records findings |
| 9 | **Typed diagrams** | Create with kind; template per kind; renders; attaches to a node |
| 10 | **Risks/tradeoffs on nodes** | Shown in Refine on the selected node |

Dogfooding: once slices 0-2 exist, all later slices are built using the cadence itself.

## 12. Risks

- **Ceremony overhead exceeds an hour's value.** Mitigation: the minute map is a
  hypothesis; the trial and early retros tune it.
- **One-hour features are too small to be useful.** Mitigation: carryover data will
  show it; the size rule is explicitly "for now."
- **Ping storms break focus.** Mitigation: ping count is logged; retro attacks the spec
  gaps behind them.
- **Log tampering by agents.** Mitigation: locked append-only command, hash chain, retro checkpoints.
- **Scope of the consolidation itself.** Mitigation: thin slices; nothing is deleted
  before its replacement slice lands.

## 13. Open questions / spikes

1. **Desktop notifications:** `host.notify` shows in-app toasts. Can a plugin raise an
   OS-level notification when the app is unfocused? Spike before slice 5.
2. **Mermaid in plugins:** the desktop app bundles Mermaid for chat embeds. Is it
   reachable from the plugin SDK, or must the plugin load its own? Spike before slice 9.
3. **Log location:** Hermes home (no git conflicts from parallel agents) vs project repo
   (edits visible in git). Leaning: Hermes home, with the retro exporting a snapshot.
4. **Hidden callers of `decision node`:** any local Hermes skills that call it must move
   to the spec-tree equivalent before slice 3 retires it.
5. **Existing data:** whether any real rows in `hierarchy_nodes`, `flows`,
   `architecture_diagrams`, or `roadmap_*` need migration, or can be dropped.
6. **Review buffer cap:** start at 2; retro adjusts.
