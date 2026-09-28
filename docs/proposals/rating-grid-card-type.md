# `rating_grid` card type — proposal

Status: **proposal**. Nothing here exists in `db.py` or `plugin.js` today.
Fills the one real gap found while building
`docs/card-type-decision-tree.md`'s coverage matrix: **Continuous ×
Independent set** — no card type lets several items each get their own
scalar value, independently, with no sum constraint and no head-to-head
comparison.

## Why this is a real gap, not a style choice

Every existing scalar card_type is single-item or ties items together:

| card_type | multi-item? | independent? |
|---|---|---|
| `scalar_slider`, `range_slider`, `confidence_rating`, `anchor_adjust` | No — one value | n/a |
| `constrained_budget_split`, `stacked_bar_split`, `weighted_allocation`* | Yes | No — must sum to a total |
| `spider_compare` | Yes | No — scores exist to compare options against each other |

None of these fit "rate each of these 5 features 1–10, no total, not
compared to each other, not confidence-in-a-value" — e.g. impact scores
per backlog item, satisfaction ratings per team, confidence-per-milestone
with no forced sum. Today that decision has to be pushed with
`card_type=None` (plain button list per item, no scalar affordance) or
force-fit into `constrained_budget_split` and lie about the total
constraint — both are the kind of misuse `docs/card-misuse-catalog.md`
already warns against.

\* `weighted_allocation` is a separate open issue
(`docs/card-type-decision-tree.md` § Gaps) — unreachable today because it
has a renderer but no gate rule. Not the same gap: it's still a
sum-constrained split, not independent scoring.

## Proposed card_type: `rating_grid`

**Bucket:** `scalar` (same bucket as the other scalar types — it's still
"the answer is a number," just multiplied across items).

**New discriminant:** `is_multi_item_independent` — true when the decision
asks for a separate scalar value per item, with no total to hit and no
requirement to compare items against each other.

### `_CARD_TYPE_RULES` edit (`backend-plugin/db.py`)

Insert as the **first** scalar rule (checked before `is_interval_not_point`),
and — this is the part that actually matters — add
`is_multi_item_independent: False` to every existing scalar rule so the
partition stays non-overlapping (same invariant
`CARD_TYPE_GATE_AMBIGUITY_RESOLUTION.md` §1 already relies on: every
multi-rule bucket must differentiate on a boolean that appears with
opposite values across its rules):

```python
("rating_grid", "scalar", {"is_multi_item_independent": True}),

("range_slider", "scalar",
 {"is_multi_item_independent": False, "is_interval_not_point": True}),
("constrained_budget_split", "scalar",
 {"is_multi_item_independent": False, "is_interval_not_point": False,
  "is_fixed_total_split": True, "prefers_visual_segments": False}),
("stacked_bar_split", "scalar",
 {"is_multi_item_independent": False, "is_interval_not_point": False,
  "is_fixed_total_split": True, "prefers_visual_segments": True}),
("confidence_rating", "scalar",
 {"is_multi_item_independent": False, "is_interval_not_point": False,
  "is_fixed_total_split": False, "needs_confidence_axis": True}),
("scalar_slider", "scalar",
 {"is_multi_item_independent": False, "is_interval_not_point": False,
  "is_fixed_total_split": False, "needs_confidence_axis": False}),
```

Without this edit, a push with `is_multi_item_independent: True` and the
other three keys defaulted `False` would match **both** `rating_grid` and
`scalar_slider` — exactly the `ambiguous` failure mode
`CARD_TYPE_GATE_AMBIGUITY_RESOLUTION.md` describes, and precisely the kind
of silent overlap its `assert_rules_partitioned()` proposal (same doc,
§1) is meant to catch before it ships. This edit is what keeps the bucket
partitioned.

### `CARD_RENDERERS` addition (`plugin.js`)

```js
rating_grid: RatingGridCard,
```

`RatingGridCard` renders one slider/stepper per item, no aggregate/total
readout (that's the visual tell distinguishing it from
`constrained_budget_split`, which always shows a running total against
the fixed sum).

### Payload shape

```json
{
  "items": [
    {"id": "feat_a", "label": "Offline mode",   "min": 1, "max": 10, "default": 5},
    {"id": "feat_b", "label": "Dark theme",      "min": 1, "max": 10, "default": 5},
    {"id": "feat_c", "label": "Export to CSV",   "min": 1, "max": 10, "default": 5}
  ],
  "unit": "impact (1-10)"
}
```

Resolved payload: `{"feat_a": 8, "feat_b": 3, "feat_c": 6}` — no sum
validation, unlike `constrained_budget_split`'s resolved payload.

## Where this lands on the tree / matrix

`docs/card-type-decision-tree.md` flowchart, `scalar` branch gets one new
first diamond:

```
B_SCALAR --> D_MULTI{is_multi_item_independent}
D_MULTI -- T --> GRID[rating_grid]
D_MULTI -- F --> D_INT{is_interval_not_point...}   (existing chain, unchanged)
```

Coverage matrix: Continuous × Independent set cell goes from ⚠️ gap to
`rating_grid`.

## Scope check (ladder rung 1)

This needs a real code change (new rule tuple + edit to 5 existing rule
dicts + new renderer component) — it's not a doc-only fix like the
`no_match` fallbacks. Flagging as a follow-up PR, not bundled into the
decision-tree docs PR.
