# Card-type decision tree

Which of the 24 Decision HUD card types to use, as a flowchart. Derived
directly from the gate's rule table (`_CARD_TYPE_RULES` in
`backend-plugin/db.py`, mirrored from card-type-gate's
`card_type_selector.py`) and the frontend renderer map (`CARD_RENDERERS`
in `plugin.js`). Where this doc and the code disagree, the code wins.

The 24 = the gate's 23 types plus `weighted_allocation`, which has a
renderer but no gate rule (see [Gaps](#gaps)).

## How to read it

Two steps, same as the gate:

1. **Pick the bucket** — what shape is the answer? (top of the chart)
2. **Answer the bucket's discriminants** — each diamond below the bucket
   is one `card_type_answers` key. Every discriminant must be answered;
   pass `card_type_bucket` + `card_type_answers` with the push.

Bucket questions are ordered so the first "yes" wins: check "is there a
decision at all?" and "are there defaults to confirm?" before looking at
answer shape.

## Flowchart

```mermaid
flowchart TD
    START([New decision to push]) --> Q_INFO{Is any choice<br/>being requested?}
    Q_INFO -- "No — purely informational" --> B_INFO[/info_only/]
    Q_INFO -- Yes --> Q_REC{Every field already has a<br/>current / recommended value<br/>to confirm or tweak?}
    Q_REC -- Yes --> B_REC[/recommend_override/]
    Q_REC -- No --> Q_REACT{Does one selector visibly<br/>change a live gauge/number?}
    Q_REACT -- Yes --> B_REACT[/reactive_config/]
    Q_REACT -- No --> Q_SHAPE{What shape is the answer?}

    Q_SHAPE -- "A number / amount" --> B_SCALAR[/scalar/]
    Q_SHAPE -- "Pick from options" --> B_DISC[/discrete_choice/]
    Q_SHAPE -- "Weigh options against each other" --> B_CMP[/compare_tradeoff/]
    Q_SHAPE -- "Put items into groups" --> B_CAT[/categorize/]
    Q_SHAPE -- "Put items in order / on dates" --> B_RANK[/rank_sequence/]
    Q_SHAPE -- "Pair items across two sets" --> B_MAP[/mapping/]
    Q_SHAPE -- "Fill named slots" --> B_COMP[/compose/]
    Q_SHAPE -- "Which set(s) an item belongs to" --> B_MEM[/membership/]
    Q_SHAPE -- "None of these fit" --> MCQ[mcq_context]

    %% info_only
    B_INFO --> D_CTX{is_pure_context_no_decision}
    D_CTX -- T --> CTX[context_readout]

    %% recommend_override
    B_REC --> D_ANCH{has_safe_defaults_to_confirm}
    D_ANCH -- T --> ANCH[anchor_adjust]

    %% reactive_config
    B_REACT --> D_RX{cross_card_reactive}
    D_RX -- T --> GAUGE[mode_radial_gauge]

    %% scalar
    B_SCALAR --> D_INT{is_interval_not_point<br/>min–max band?}
    D_INT -- T --> RANGE[range_slider]
    D_INT -- F --> D_TOT{is_fixed_total_split<br/>parts sum to a total?}
    D_TOT -- T --> D_SEG{prefers_visual_segments<br/>~3 parts as one bar?}
    D_SEG -- T --> STACK[stacked_bar_split]
    D_SEG -- F --> BUDGET[constrained_budget_split]
    D_TOT -- F --> D_CONF{needs_confidence_axis<br/>value + how sure?}
    D_CONF -- T --> CONF[confidence_rating]
    D_CONF -- F --> SLIDER[scalar_slider]

    %% discrete_choice
    B_DISC --> D_QUAD{is_and_or_neither_logic<br/>2 factors: A / B / both / neither?}
    D_QUAD -- T --> QUAD[quad_choice]
    D_QUAD -- F --> D_SUB{is_independent_subset<br/>select all that apply?}
    D_SUB -- T --> MULTI[multi_select]
    D_SUB -- F --> D_LVL{is_quantized_few_levels<br/>low / med / high tiers?}
    D_LVL -- T --> ZONE[zone_select]

    %% compare_tradeoff
    B_CMP --> D_TWO{is_exactly_two_options}
    D_TWO -- T --> BAL[balance_scale]
    D_TWO -- F --> D_MANY{is_many_options_reduce<br/>≥5 options?}
    D_MANY -- T --> DUEL[pairwise_duel]
    D_MANY -- F --> D_AX{is_multi_axis_no_dominant<br/>≥3 criteria, none primary?}
    D_AX -- T --> SPIDER[spider_compare]

    %% categorize
    B_CAT --> D_TREE{is_tree_not_flat<br/>nested parent › child?}
    D_TREE -- T --> TREE[tree_placement]
    D_TREE -- F --> D_GRID{is_two_axis_grid<br/>two named axes?}
    D_GRID -- T --> MATRIX[matrix_2x2]
    D_GRID -- F --> BIN[sort_to_bin]

    %% rank_sequence
    B_RANK --> D_DATE{is_absolute_dates_not_relative<br/>real calendar dates?}
    D_DATE -- T --> TIMELINE[timeline_placement]
    D_DATE -- F --> SEQ[sequence_order]

    %% mapping / compose / membership
    B_MAP --> D_WIRE{one_to_one_sets}
    D_WIRE -- T --> WIRE[wire_match]
    B_COMP --> D_SLOT{is_one_choice_per_slot}
    D_SLOT -- T --> ASSEMBLE[assemble_pieces]
    B_MEM --> D_VENN{is_shared_vs_exclusive<br/>both / only-A / only-B?}
    D_VENN -- T --> VENN[venn_overlap]

    %% renderer with no gate rule
    WEIGHTED[weighted_allocation<br/>⚠ no gate rule — unreachable]:::orphan

    classDef orphan stroke-dasharray: 5 5
```

A diamond with no `F` arrow is a dead end: answering `F` there gives
`no_match`, which means the gate rejects the claimed `card_type`. Push with
`card_type=None` (the plain button list — usually the right answer for
"pick exactly one of N") or re-bucket as `none_of_these` → `mcq_context`.

## Quick reference

| # | card_type | bucket | Use when… |
|---|---|---|---|
| 1 | `context_readout` | info_only | Nothing to decide — just show state/context |
| 2 | `anchor_adjust` | recommend_override | Every field has a recommended value; user confirms or nudges |
| 3 | `mode_radial_gauge` | reactive_config | Picking a mode visibly moves a live gauge/number |
| 4 | `range_slider` | scalar | Answer is a min–max band, not one number |
| 5 | `stacked_bar_split` | scalar | Parts sum to a fixed total, ~3 parts shown as one bar |
| 6 | `constrained_budget_split` | scalar | Parts sum to a fixed total, shown as separate sliders (>3 parts) |
| 7 | `confidence_rating` | scalar | One value **plus** "how sure are you?" |
| 8 | `scalar_slider` | scalar | One number / setting, nothing else |
| 9 | `quad_choice` | discrete_choice | Two factors combined: A, B, both, or neither |
| 10 | `multi_select` | discrete_choice | "Select all that apply" |
| 11 | `zone_select` | discrete_choice | One of a few exclusive ordered tiers (low/med/high) |
| 12 | `balance_scale` | compare_tradeoff | Exactly two alternatives weighed against each other |
| 13 | `pairwise_duel` | compare_tradeoff | ≥5 options to whittle down head-to-head |
| 14 | `spider_compare` | compare_tradeoff | 3–4 options across ≥3 criteria, none dominant |
| 15 | `tree_placement` | categorize | Items go into nested categories |
| 16 | `matrix_2x2` | categorize | Items placed on two independent axes (impact × effort) |
| 17 | `sort_to_bin` | categorize | Items go into flat buckets |
| 18 | `timeline_placement` | rank_sequence | Items land on real calendar dates |
| 19 | `sequence_order` | rank_sequence | Items put in relative order (first → last) |
| 20 | `wire_match` | mapping | Pair each item in set A with one in set B |
| 21 | `assemble_pieces` | compose | Named slots, each with its own option list |
| 22 | `venn_overlap` | membership | Two sets — which items are shared vs exclusive |
| 23 | `mcq_context` | none_of_these | Nothing above fits; multiple choice with context |
| 24 | `weighted_allocation` | — | ⚠ Renderer exists, no gate rule (see Gaps) |

## Coverage matrix

Same 24 types, cut a different way: **value type** (what kind of answer
each item gets) × **structure** (how many items, and whether they're
decided independently or jointly). Cells hold every card_type that fits;
`—` marks a combination that's structurally impossible (e.g. "ordinal"
needs ≥2 items, so there's no single-item ordinal cell).

| value type ↓ / structure → | Single item | Independent set (each item decided on its own) | Constrained set (items bound together — sum, comparison, sequence, pairing) |
|---|---|---|---|
| **Continuous** (a number) | `scalar_slider`, `range_slider`, `confidence_rating`, `anchor_adjust` | ⚠️ gap — proposed `rating_grid`, see below | `constrained_budget_split`, `stacked_bar_split`, `spider_compare`, `weighted_allocation`* |
| **Categorical** (a label) | `quad_choice`, `zone_select`, `mcq_context`, `mode_radial_gauge` | `multi_select`, `sort_to_bin`, `tree_placement`, `matrix_2x2`, `assemble_pieces` | `balance_scale`, `pairwise_duel` |
| **Ordinal** (relative position) | — | — | `sequence_order`, `timeline_placement` |
| **Relational** (pairing / membership across sets) | — | — | `wire_match`, `venn_overlap` |

\* `weighted_allocation` has no gate rule — see [Gaps](#gaps).

`context_readout` (info_only) isn't on the grid — no value is being
chosen, so it has no value type.

**Real gap found:** nothing covers **Continuous × Independent set** — a
card where each of several items gets its own number, independently, with
no sum constraint and no cross-item comparison (e.g. "rate each of these 5
features 1–10, no total, not compared to each other"). Every existing
continuous card_type is either single-item or ties items together. If that
pattern comes up, it currently has no `card_type` — falls back to
`card_type=None`. Proposed fix: a new `rating_grid` card_type — see
[`docs/proposals/rating-grid-card-type.md`](proposals/rating-grid-card-type.md)
for the exact rule-table edit and renderer.

The other two dead ends noted below ("pick exactly one of N", and
`compare_tradeoff` with one dominant criterion) aren't proposed as new
card types — the plain button list already serves "pick one of N" well,
and a single dominant criterion is really just a sorted list, not a
distinct card shape.

## Gaps

Found while building this tree; not fixed here.

- **`weighted_allocation` is unreachable.** It is in `CARD_RENDERERS` but
  not in `_CARD_TYPE_RULES`, so `_verify_card_type` rejects any push that
  claims it. It overlaps `constrained_budget_split` (both = weights summing
  to a total); `CARD_TYPE_GATE_AMBIGUITY_RESOLUTION.md` already flags it as
  confusable. Either add a discriminant that separates it or delete the
  renderer.
- **`mcq_context` has no dedicated renderer.** It falls through to
  `DefaultChoiceCard`.
- **Gaps in the tree that route to `no_match`:** plain "pick exactly one
  of N" in `discrete_choice` (all three discriminants false), and
  `compare_tradeoff` with 3–4 options and one dominant criterion. Both
  fall back to the plain list.
