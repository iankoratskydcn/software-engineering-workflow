"""Text-only card_type auto-classifier — promotes card-type-gate's
"incomplete gate" signal-answering procedure (see
CARD_TYPE_GATE_AMBIGUITY_RESOLUTION.md §1) from agent-followed prose into an
executable, testable function, so an agent (or the external card-type-gate
skill) no longer has to re-derive the discriminant table by hand every push.

Hard scope limit, by design: `decision_push`'s own surface is (question,
2-4 plain choice strings, recommended) — there is no `multi_select`, no item
list, no axis count. Most of the 23-entry taxonomy needs structure that only
exists in `card_payload` (items, slots, axes, min/max...), which the agent
must already have decided in order to build it. Classifying those from text
alone would mean guessing structure that was never given — this module
refuses to do that and returns None instead.

What CAN be read off (question, choices) alone, reliably: the handful of
card types whose entire discriminant is encoded in the choice LABELS
themselves (an explicit "Both"/"Neither" pair, a small ordered tier
vocabulary) or in trivial structure (exactly 2 choices) plus comparison
wording in the question. Everything else returns None — never a guess.
Every detector's answers are resolved through db._card_type_verdict (the
SAME engine push_decision enforces), so a classifier result is guaranteed
consistent with the rule table by construction, not duplicated logic that
could drift from it.
"""

from __future__ import annotations

import re
from typing import Optional

import db

# Tier vocabulary for zone_select: every choice must match one of these
# (case-insensitive substring) for the signal to fire — a partial match
# (only some choices look like tiers) is not enough, to avoid false
# positives on an ordinary short choice list that happens to include "low".
_TIER_WORDS = (
    "low", "medium", "med", "high", "critical", "minor", "major", "severe",
    "urgent", "none", "tier 1", "tier 2", "tier 3", "small", "large",
)

# Comparison/tradeoff wording for balance_scale — the question must name the
# tradeoff explicitly; two plain choices with no such wording could just as
# easily be a plain "pick one" (no_match / None), not a balance_scale.
_TRADEOFF_WORDS = re.compile(
    r"\b(vs\.?|versus|trade-?off|weigh|compare|balance|which is better)\b",
    re.IGNORECASE,
)

_BOTH_NEITHER_WORDS = {"both", "neither"}


def _norm(s: str) -> str:
    return s.strip().casefold()


def _detect_quad_choice(question: str, choices: list[str]) -> Optional[dict]:
    """quad_choice: exactly 4 choices, and the set includes an explicit
    "Both" and "Neither" option (the A/B/both/neither combinatorial
    pattern) — the one unambiguous lexical signature of this card type."""
    if len(choices) != 4:
        return None
    normed = {_norm(c) for c in choices}
    if not _BOTH_NEITHER_WORDS <= normed:
        return None
    return {
        "is_and_or_neither_logic": True,
        "is_independent_subset": False,
        "is_quantized_few_levels": False,
    }


def _detect_zone_select(question: str, choices: list[str]) -> Optional[dict]:
    """zone_select: every choice (2-4 of them) reads as an ordered tier
    label. Requires ALL choices to match, not just one."""
    if not (2 <= len(choices) <= 4):
        return None
    if any(_norm(c) in _BOTH_NEITHER_WORDS for c in choices):
        return None  # already claimed by quad_choice's pattern, don't double-fire
    if not all(any(word in _norm(c) for word in _TIER_WORDS) for c in choices):
        return None
    return {
        "is_and_or_neither_logic": False,
        "is_independent_subset": False,
        "is_quantized_few_levels": True,
    }


def _detect_balance_scale(question: str, choices: list[str]) -> Optional[dict]:
    """balance_scale: exactly 2 choices AND the question itself names a
    tradeoff/comparison explicitly. Two plain choices with no such wording
    is just as likely an ordinary pick-one — left as None, not guessed."""
    if len(choices) != 2:
        return None
    if not _TRADEOFF_WORDS.search(question):
        return None
    return {
        "is_exactly_two_options": True,
        "is_many_options_reduce": False,
        "is_multi_axis_no_dominant": False,
    }


# bucket -> detector. Order doesn't matter; detectors are mutually exclusive
# by construction (disjoint choice-count/content requirements), but classify()
# still refuses to pick if more than one somehow fires.
_DETECTORS: tuple[tuple[str, "callable"], ...] = (
    ("discrete_choice", _detect_quad_choice),
    ("discrete_choice", _detect_zone_select),
    ("compare_tradeoff", _detect_balance_scale),
)


def classify(question: str, choices: list[str]) -> Optional[dict]:
    """Return {"card_type", "card_type_bucket", "card_type_answers"} when
    exactly one detector fires AND the resulting answers resolve cleanly
    through db._card_type_verdict (status == "resolved") — i.e. a result
    this module returns is ALWAYS accepted by push_decision's own
    _verify_card_type, by construction. Returns None otherwise (no
    confident match, or more than one detector fired) — never a guess;
    callers fall back to card_type=None (plain list) or build card_payload
    + choose card_type by hand as before.
    """
    question = (question or "").strip()
    choices = [c for c in (choices or []) if isinstance(c, str) and c.strip()]
    hits = []
    for bucket, detector in _DETECTORS:
        answers = detector(question, choices)
        if answers is not None:
            hits.append((bucket, answers))
    if len(hits) != 1:
        return None
    bucket, answers = hits[0]
    verdict = db._card_type_verdict(bucket, answers)
    if verdict["status"] != "resolved":
        return None
    return {
        "card_type": verdict["matches"][0][0],
        "card_type_bucket": bucket,
        "card_type_answers": answers,
    }
