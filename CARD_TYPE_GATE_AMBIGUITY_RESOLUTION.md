# Proposal: deterministic resolution for `card_type_selector.py`'s `incomplete` / `ambiguous` gate outcomes

**v2 superseded this doc's bucket names.** The 12 ad-hoc buckets this doc
reasons about (`scalar`, `discrete_choice`, `none_of_these`, etc.) were
replaced by a value_type × cardinality grid — see
`docs/card-type-decision-tree.md`. The structural argument below
(`_CARD_TYPE_RULES` partitions each bucket with no overlap, proven
exhaustively now in
`test_card_type_enforcement.py::test_every_bucket_rule_set_is_total_and_partitioned`)
and the tie-break procedure still apply to the new buckets; only the names
changed. Kept as the original design record.

Status: proposal (no code changed by this doc). Source gate:
`~/.hermes/skills/decision-hud-cards/card-type-gate/scripts/card_type_selector.py`
(23 card types, forward-chaining `RULES` list, `verdict()` returns
`resolved | incomplete | ambiguous | no_match`).

## Problem

`incomplete` and `ambiguous` are currently dead ends: the gate skill says
"resolve the open_questions" / "narrow by asking which force dominates" but
gives no procedure. In practice the agent either guesses (defeats the whole
point of having a gate) or bails to `mcq_context` every time (loses the rich
card entirely, and is why card_type selection keeps converging on the same
few types). Both failure modes need a scripted procedure, same discipline as
the rest of the gate.

## 1. `incomplete` — answer discriminants from the question text, don't ask Ian

**Ladder check (rung 1): does this need new code?** No. `unresolved_questions()`
already returns exactly which keys are missing. The fix is a *procedure* the
agent follows, not a code change — the discriminants are already
evidence-answerable per the gate skill's own autonomy-gate section ("An
agent... should almost always be able to answer every discriminant itself by
re-reading the question").

**Procedure:**

1. Take `open_questions` from the `incomplete` verdict.
2. For each question id, pull its full text from `QUESTIONS` (`--questions`).
3. Re-read the actual decision copy (the card's question text being pushed —
   not the taxonomy table) and answer using the lexical/structural signal
   table below. This is pattern-matching on the request's own wording, not a
   judgment call.
4. Re-run `verdict()` with the completed answers.
5. If a question still can't be pinned from the text after step 3, **default
   it to `False`** (every `RULES` entry is written so `False` on a
   discriminant routes toward the plainer/cheaper card in that bucket —
   e.g. not-interval, not-fixed-total, not-tree, not-two-axis, no-safe-default).
   Apply the default, get a verdict, and note the defaulted key in the
   push's classification note (per gate skill step 5, "record which verdict
   produced it").
6. Escalate to Ian **only** if, after defaulting, the resulting card_type
   would visibly misrepresent the decision's own structure (e.g. defaulting
   collapses a genuine two-axis grid into a flat bucket sort) — that's a
   judgment call, route it through `decision_hud` as a normal (non-blocking)
   card per `gate-skill-judgment-routing.md`, never an inline `clarify()`.
   `clarify()` is reserved for decisions that must resolve *this turn*.

**Signal table** (id → what to look for in the decision's own text):

| discriminant | true when the text has... | false when it has... |
|---|---|---|
| `is_interval_not_point` | "range", "between X and Y", "min and max" | a single number/setting to pick |
| `is_fixed_total_split` | values must sum to a stated total ("100%", "the $Nk budget") | independent values, no sum constraint |
| `prefers_visual_segments` | exactly 3 categories, described as a bar/split | >3 categories, or described as separate sliders |
| `is_and_or_neither_logic` | exactly 2 named factors combined with and/or/neither wording | not exactly 2 factors, or no combinatorial logic |
| `is_independent_subset` | "select all that apply", "choose any" | mutually exclusive options |
| `is_quantized_few_levels` | a small named set of exclusive tiers (low/med/high) | continuum or subset-pickable |
| `is_tree_not_flat` | nested categories ("parent > child") | flat list of buckets |
| `is_two_axis_grid` | two independent named axes (impact, effort) | one axis, or no explicit second axis |
| `is_absolute_dates_not_relative` | specific calendar dates/deadlines | only "before/after X" relative wording |
| `is_one_choice_per_slot` | named slots, each with its own option list | one flat option list |
| `is_exactly_two_options` | exactly 2 named alternatives | 1, 3, or unspecified count |
| `is_many_options_reduce` | ≥5 named options | <5 options |
| `is_multi_axis_no_dominant` | ≥3 named criteria, none called out as primary | 1-2 criteria, or one clearly primary |
| `is_shared_vs_exclusive` | two named sets with overlap wording ("both", "only") | one set, or no overlap language |
| `has_safe_defaults_to_confirm` | every field already has a stated current/recommended value | no defaults given, or some fields blank |
| `cross_card_reactive` | one selector's value visibly changes a displayed gauge/number | no live cross-field effect described |
| `is_pure_context_no_decision` | no action requested, purely informational | any choice is being requested |
| `needs_confidence_axis` | text asks "how confident/certain" alongside a value | only asks for the value |

This table belongs in the `card-type-gate` skill (add as
`references/discriminant-signals.md`) so it's reusable, not re-derived per
push — flagged as a follow-up, not required for this proposal.

## 2. `ambiguous` — tie-breaking hierarchy

**First, a structural note that changes the fix's scope:** as written today,
`RULES` partitions every bucket's discriminant space with no overlap — for
any bucket, at most one `Rule.requires` dict can match a self-consistent
answer set (verified by inspection: every multi-rule bucket differentiates
on a boolean that appears with opposite values across its rules). So
`ambiguous` should be **structurally near-impossible today**; it can only
fire if a future `RULES` edit adds a rule whose `requires` overlaps an
existing one without adding the differentiating key (the gate skill's own
"Known-confusable cluster" note flags `weighted_allocation` as exactly this
risk). Ladder rung 1 applies: the cheapest real fix is a one-time invariant
check —

```python
# add to card_type_selector.py (or a test file) — proposal, not yet applied
def assert_rules_partitioned():
    from itertools import combinations
    for a, b in combinations(RULES, 2):
        if a.bucket != b.bucket:
            continue
        shared = set(a.requires) & set(b.requires)
        if all(a.requires[k] == b.requires.get(k, a.requires[k]) for k in shared) \
           and set(a.requires) <= set(b.requires) | shared and set(b.requires) <= set(a.requires) | shared:
            # crude overlap check: both could be satisfied by one answer set
            raise AssertionError(f"{a.card_type} and {b.card_type} can both match ({a.bucket})")
```

That prevents most future `ambiguous` cases before they reach an agent at
all. It does **not** replace the tie-break procedure below — extensions can
still slip through, and the procedure is also the right shape for a
*future* bucket where legitimate overlap is intentional (e.g. a card that
can validly render two ways).

**Tie-break procedure**, applied to `verdict()["matches"]` (list of
`(card_type, rationale)` tied at equal-rule-match), stop at first rung that
yields exactly one winner:

1. **Least-recently-used.** Query `decision_hud`'s store
   (`decision_list` / direct read of the plugin's SQLite) for the most
   recent `created_at` per tied `card_type`. Pick the candidate with the
   oldest (or absent — never-used wins outright) last-use timestamp. This
   is the direct fix for "always converges on the same type": it forces
   rotation among structurally-equivalent options instead of always
   picking whichever the agent reaches for by habit.
2. **Interaction cost vs. urgency, if step 1 is still tied** (equal or no
   history). Read the decision's own `urgency` field (already on the
   `decision_hud` schema).
   - Low/normal urgency → pick the **lower**-interaction-cost tied
     candidate (fewer required clicks/fields).
   - High-stakes/high-urgency → invert: pick the **richer**
     tied candidate (captures more structured signal), since the extra
     click cost is justified by the stakes.
   Use a static ordinal cost ranking (rough click/field count), not a
   computed model — ponytail rung 6/7, a lookup table is enough:
   `zone_select ≈ quad_choice ≈ venn_overlap ≈ timeline_placement`
   (1 interaction) `< wire_match ≈ multi_select ≈ sort_to_bin ≈
   matrix_2x2 ≈ sequence_order` (N clicks, N ≈ item count) `<
   assemble_pieces ≈ tree_placement ≈ confidence_rating` (per-slot choice
   + a second axis) `< stacked_bar_split ≈ constrained_budget_split ≈
   weighted_allocation ≈ range_slider` (must balance/validate a total or
   band) `< pairwise_duel ≈ spider_compare ≈ balance_scale ≈
   mode_radial_gauge ≈ anchor_adjust` (multi-round or cross-field).
3. **Ask Ian — last resort only, and never blocking by default.** If rungs
   1-2 leave a genuine tie (identical history, identical urgency tier, same
   cost class), that means the two card types are truly interchangeable for
   this decision — which is itself useful information, not a failure.
   Route it as a normal (non-blocking) `decision_hud` push: the question is
   "pick between these ≤4 tied card_types" as a plain MCQ
   (`card_type=None`, per `decision-clarification-workflows-safe`: ≤4
   choices, safest/cheapest first), so it doesn't stall the current turn
   waiting on Ian. Use a blocking `clarify()` only if the decision itself
   is flagged urgent and must resolve this turn — the tie-break is riding
   on the decision's own urgency, not manufacturing new urgency.

## Why this order

- Recency-first directly targets the reported symptom (agent always picks
  the same type) without needing to model "which shape is objectively
  better" — it's a fairness/rotation fix, cheap to query, no new
  infrastructure (the history already lives in `decision_hud`'s existing
  store).
- Urgency-based cost matching reuses a field that's already on every
  decision (`urgency`), so it's a free second rung — no new schema.
- Escalation is genuinely last-resort and non-blocking by default, matching
  the autonomy-gate convention: card-shape discriminants (and, by
  extension, ties between two valid shapes) are structural facts an agent
  can and should resolve itself; asking Ian is for the residual case where
  the remaining choice is provably a coin flip.

## What this proposal does NOT do (ponytail: stop here)

- Does not add a `card_type` usage table or new persistence — reuses
  `decision_hud`'s existing store via a read query.
- Does not build a real interaction-cost model (timing studies, click
  logging) — a static ordinal table is enough to break ties; upgrade only
  if real usage data shows the ordinal guess is wrong.
- Does not change `card_type_selector.py`'s core algorithm (still pure
  forward-chaining, still deterministic) — only adds a pre-flight
  invariant check (optional, sketched above, not applied) and an
  agent-facing procedure for the two outcome branches.
- Does not touch `mcq_context`'s role as universal fallback — it remains
  the correct outcome for `no_match`, untouched by this proposal.

## Follow-ups (not done here, flagged for whoever picks this up)

1. Add the signal table (section 1) to `card-type-gate/references/` so it's
   reusable rather than re-derived per push.
2. Add the `assert_rules_partitioned()` check (or equivalent test) to
   `card_type_selector.py` so `ambiguous` stays the rare/defensive case it
   already structurally is.
3. Wire the least-recently-used query (section 2, rung 1) as a small helper
   near the gate script once a first real `ambiguous` case is hit — no
   speculative build before it's needed.
