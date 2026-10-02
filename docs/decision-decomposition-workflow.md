# Decomposing fuzzy multi-part decisions into well-fitted cards

## Problem
The user rarely sees the full 23-card palette because agents push one
big, messy, multi-part decision as a single card — usually landing on
`mcq_context` or a vaguely-related card that doesn't match any part of
the question's actual shape. The fix isn't a better single-card
classifier; it's **splitting the decision before classifying**.

## Does `sidecar_service` help with the splitting step?

Investigated directly: `sidecar_dispatch` exposes 90 operations,
including one named exactly for this — `request_decomposition` — plus
`decision_extraction`, `dependency_graph_construction`, and
`task_priority_extraction`, which look adjacent.

Tested `request_decomposition` (and `decision_extraction`) against this
repo's live sidecar with several task-envelope shapes (varying
`input`/`input_schema`/`routing_hint`). Every call returned:

```json
{"status": "escalate", "reason_code": "unsupported", "payload": null}
```

`provenance.execution_path: "deterministic"` — no model was even
invoked; the operation name exists in the enum but the server has no
handler wired up for it in this environment (or it requires an
`input_schema`/`routing_hint` contract not discoverable from the tool
description alone). **Conclusion: `sidecar_dispatch` cannot currently
do this decomposition** — it's a dispatch surface for narrow,
schema'd sub-tasks (context ranking, dedup, extraction), not a general
task-splitting planner, and the one operation that sounds like a fit
isn't actually implemented/routed yet.

**Decision: use plain LLM decomposition (the agent's own reasoning),
not sidecar, for the split step.** This is also just simpler — ladder
rung 3 (stdlib/native capability, here "the agent's own judgment")
beats standing up a new dependency on an unsupported sidecar op.
Revisit sidecar for this if `request_decomposition` ever returns
`resolved` instead of `escalate`.

## The workflow (agent-side, no new tooling required)

1. **Detect fan-out before picking any card_type.** Signal: the
   question text contains multiple independent nouns-with-choices
   joined by "and", covers unrelated axes (money + people + time),
   or a first pass through `card-type-gate` returns `ambiguous`/
   `no_match` because two+ unrelated shapes are tangled together.
2. **Split into 2-4 sub-decisions, each single-shaped.** Rule of
   thumb: a sub-decision is small enough when you can name its bucket
   (scalar / discrete_choice / compare_tradeoff / rank_sequence / …)
   in one word without an "and". Keep splits *independent* where
   possible; if one genuinely gates another (e.g. "pick vendor" before
   "set budget for that vendor"), note the dependency in the pushed
   question text ("assumes CMS migration is approved") rather than
   building new DAG infrastructure — decision_hud has no
   inter-card dependency field, so don't invent one.
3. **Run `card-type-gate`'s discriminant engine per sub-decision**
   (`card_type_selector.py --answers`), not vibes. Only push a
   `card_type` on `status == "resolved"`.
4. **Push each sub-decision as its own `decision_push` call**, one
   `tool_call` per push (batching multiple local pushes in one
   `tool_call` is rejected — see decision-hud-cards skill). Reuse the
   parent question's context in each sub-question's text so each card
   stands alone if the user resolves them out of order or on separate
   days.
5. **Reassembly**: nothing to build — `decision_list`/`decision_check`
   already return `resolved_choice`/`resolved_payload` per id. When
   summarizing back to the user (or acting on the results), just read
   all N sub-decision ids and combine their `resolved_payload`s in
   prose. No new aggregation feature needed (ladder rung 1: this
   doesn't need to exist as new code).

## Worked example

**Messy source decision (Bellini webmaster-flavored):**

> "We need to sort out Q4 for the Bellini site redesign: how to split
> the $18,000 remaining budget across paid ads / dev contractor hours
> / stock photography, which of the six shortlisted freelance
> webmaster candidates to bring in, and when the CMS migration to the
> new platform should actually go live."

This is three unrelated shapes glued together — split it:

| # | Sub-decision | Bucket | Discriminant answers | card_type |
|---|---|---|---|---|
| 1 | "How should the remaining $18,000 Q4 budget split across paid ads / dev contractor hours / stock photography?" | scalar | `is_interval_not_point=false`, `is_fixed_total_split=true`, `prefers_visual_segments=true`, `needs_confidence_axis=false` | **stacked_bar_split** — exactly 3 categories, one fixed total, wants the "one bar, two dividers" visual, not independent sliders |
| 2 | "Which freelance webmaster candidate should we bring in?" (6 shortlisted) | compare_tradeoff | `is_exactly_two_options=false`, `is_many_options_reduce=true`, `is_multi_axis_no_dominant=false` | **pairwise_duel** — 6 candidates is too many to rank/compare at once; single-elimination bracket reduces it cleanly |
| 3 | "When should the CMS migration go live?" | rank_sequence | `is_absolute_dates_not_relative=true` | **timeline_placement** — needs an actual calendar date/position, not just relative ordering vs. other tasks |

Verified against the live `card_type_selector.py` engine (not asserted by
eyeballing the table) — all three `status: "resolved"`:

```
stacked_bar_split    => resolved  (Exactly-3-segment visual bar...)
pairwise_duel        => resolved  (5+ options, too many to rank at once...)
timeline_placement   => resolved  (Absolute date/position on a schedule...)
```

### The three pushes

```python
# 1. Budget split — stacked_bar_split
decision_push(
  project_id=<bellini_project_id>,
  question="How should the remaining $18,000 Q4 site-redesign budget "
           "split across paid ads, dev contractor hours, and stock photography?",
  choices=["Even split (~$6k each)", "Weight dev hours heaviest", "Weight ads heaviest", "Custom split"],
  recommended="Weight dev hours heaviest",
  card_type="stacked_bar_split",
  card_type_bucket="continuous_constrained",
  card_type_answers_json=json.dumps({
      "is_fixed_total_split": True, "prefers_visual_segments": True}),
  card_payload_json=json.dumps({"segments": [
      {"key": "ads", "label": "Paid ads"},
      {"key": "dev", "label": "Dev contractor hours"},
      {"key": "photo", "label": "Stock photography"}]}),
)

# 2. Webmaster candidate — pairwise_duel
decision_push(
  project_id=<bellini_project_id>,
  question="Which of the six shortlisted freelance webmasters should we bring on for the redesign?",
  choices=["Candidate A", "Candidate B", "Let bracket decide", "None — reopen search"],
  card_type="pairwise_duel",
  card_type_bucket="categorical_constrained",
  card_type_answers_json=json.dumps({
      "is_exactly_two_options": False, "is_many_options_reduce": True}),
  card_payload_json=json.dumps({"options": [
      {"key": "cand_a", "label": "Alex R."}, {"key": "cand_b", "label": "Priya K."},
      {"key": "cand_c", "label": "Sam T."}, {"key": "cand_d", "label": "Jordan M."},
      {"key": "cand_e", "label": "Devon L."}, {"key": "cand_f", "label": "Mika S."}]}),
)

# 3. CMS go-live date — timeline_placement
decision_push(
  project_id=<bellini_project_id>,
  question="When should the CMS migration to the new platform go live?",
  choices=["Early Nov (pre-Black Friday freeze)", "Late Nov", "Mid Dec", "Push to Jan"],
  recommended="Early Nov (pre-Black Friday freeze)",
  card_type="timeline_placement",
  card_type_bucket="ordinal_constrained",
  card_type_answers_json=json.dumps({"is_absolute_dates_not_relative": True}),
  card_payload_json=json.dumps({"ticks": [
      {"key": "nov_early", "label": "Nov 3"}, {"key": "nov_late", "label": "Nov 24"},
      {"key": "dec_mid", "label": "Dec 15"}, {"key": "jan", "label": "Jan 12"}],
      "default_tick_key": "nov_early"}),
)
```

Each `tool_call` is issued separately per the "one local tool per
`tool_call`" constraint. Result: the user opens the Decision HUD pane
and sees three distinct, correctly-shaped cards — a budget bar, a
bracket, a timeline — instead of one flattened MCQ that mushes budget
dollars, a hiring choice, and a launch date into four generic buttons.

### Reassembly

No new code: once all three resolve, `decision_list(project_id=...)`
returns each row with `resolved_choice`/`resolved_payload`. Combine in
the summary sent back to the user, e.g. "$X to ads / $Y to dev / $Z to
photo, hired <candidate>, migration live <date>." If any sub-decision
depends on another's outcome, say so in that card's question text at
push time (already recommended in step 2 above) rather than blocking
on a DAG structure decision_hud doesn't have.

## What NOT to build
- No new "decomposition" MCP tool or sidecar operation — plain agent
  reasoning does the split; `request_decomposition` in sidecar is not
  wired up, and even if it were, splitting 1 question into 2-4 is well
  within an agent's own judgment, not a task needing a dedicated
  sub-model round trip.
- No dependency/DAG field on `decision_push` — encode ordering in the
  question text; decision_hud's schema has no dependency column and
  adding one is unjustified for a 2-4 card fan-out.
- No new aggregation/rollup tool — `decision_list`/`decision_check`
  already return everything needed to reassemble sub-decision results.
