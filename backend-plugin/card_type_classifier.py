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

# Tier vocabulary for zone_select, matched as whole WORDS (not substrings --
# "Workflow A" contains the literal substring "low" inside "f-low", which a
# plain `in` check would wrongly treat as a tier label; \b...\b anchors each
# word to its own token boundaries). Multi-word entries ("tier 1") still
# match via the same word-boundary pattern spanning the literal phrase.
_TIER_WORDS = (
    "low", "medium", "med", "high", "critical", "minor", "major", "severe",
    "urgent", "none", "tier 1", "tier 2", "tier 3", "small", "large",
)
_TIER_PATTERNS = tuple(re.compile(r"\b" + re.escape(w) + r"\b", re.IGNORECASE) for w in _TIER_WORDS)

# Comparison/tradeoff wording for balance_scale. `\w*` on weigh/outweigh
# catches inflected forms (weighing, weighed, outweighs) that a bare \bweigh\b
# token match misses -- canonical tradeoff phrasing ("weighing X against Y",
# "which outweighs the other") must not silently fail to match.
_TRADEOFF_WORDS = re.compile(
    r"\b(vs\.?|versus|trade-?off|weigh\w*|outweigh\w*|compare|balance|which is better)\b",
    re.IGNORECASE,
)

_BOTH_NEITHER_WORDS = {"both", "neither"}


def _norm(s: str) -> str:
    return s.strip().casefold()


def _is_tier_label(choice: str) -> bool:
    return any(p.search(choice) for p in _TIER_PATTERNS)


def _slug(s: str) -> str:
    """zone_select payload key: lowercase, non-alnum runs collapsed to '_',
    trimmed -- stable, URL/JSON-key-safe, derived purely from the choice text
    so two different choices can never collide unless their text already
    normalizes to the same slug (then they weren't distinct choices anyway)."""
    return re.sub(r"[^a-z0-9]+", "_", s.strip().casefold()).strip("_") or "zone"


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
    label (whole-word match). Requires ALL choices to match, not just one."""
    if not (2 <= len(choices) <= 4):
        return None
    if any(_norm(c) in _BOTH_NEITHER_WORDS for c in choices):
        return None  # already claimed by quad_choice's pattern, don't double-fire
    if not all(_is_tier_label(c) for c in choices):
        return None
    return {
        "is_and_or_neither_logic": False,
        "is_independent_subset": False,
        "is_quantized_few_levels": True,
    }


def _detect_balance_scale(question: str, choices: list[str]) -> Optional[dict]:
    """balance_scale: exactly 2 choices AND the question itself names a
    tradeoff/comparison explicitly. Two plain choices with no such wording
    is just as likely an ordinary pick-one — left as None, not guessed.

    Tier-shaped choices (e.g. ["Low", "High"]) are excluded even when the
    question also uses comparison wording ("low vs high?") -- zone_select
    is the more specific, more useful match for an ordered-tier pair
    (renders as a proper zone picker, not a two-sided scale with nothing to
    place on it), so it wins instead of the two detectors cancelling each
    other out into a classify() tie.
    """
    if len(choices) != 2:
        return None
    if _detect_zone_select(question, choices) is not None:
        return None
    if not _TRADEOFF_WORDS.search(question):
        return None
    return {
        "is_exactly_two_options": True,
        "is_many_options_reduce": False,
        "is_multi_axis_no_dominant": False,
    }


# bucket -> detector. classify() still refuses to pick if more than one
# fires (the balance_scale/zone_select overlap is resolved inside
# _detect_balance_scale itself, above, not here -- this is a backstop for
# any future detector, not the mechanism for today's known overlap).
_DETECTORS: tuple[tuple[str, "callable"], ...] = (
    ("discrete_choice", _detect_quad_choice),
    ("discrete_choice", _detect_zone_select),
    ("compare_tradeoff", _detect_balance_scale),
)

# card_type -> derive card_payload from (question, choices) alone, or None
# when the card's payload needs information this module was never given
# (balance_scale's `considerations` are a THIRD list distinct from the two
# choices -- the items being weighed, not the sides -- there is nothing in
# (question, choices) to derive them from; the caller must supply it).
def _zone_payload(question: str, choices: list[str]) -> dict:
    return {"zones": [{"key": _slug(c), "label": c} for c in choices]}


_PAYLOAD_BUILDERS = {
    "zone_select": _zone_payload,
}

# Shown in classify()'s result when a hit's card renderer needs card_payload
# fields this module cannot derive, so a caller forwarding the result
# verbatim doesn't silently get the plain-list fallback it was trying to
# avoid (ZoneSelectCard/BalanceScaleCard both degrade to DefaultChoiceCard
# on an empty/missing payload -- see plugin.js).
_PAYLOAD_NOTES = {
    "balance_scale": (
        "Renders as the rich card only if you also pass "
        "card_payload={'considerations': [...]} -- the items to weigh "
        "between the two choices. This classifier has no source for that "
        "list (it's separate from the two choices, which are the sides, "
        "not the considerations); you must supply it yourself."
    ),
}


def classify(question: str, choices: list[str]) -> Optional[dict]:
    """Return {"card_type", "card_type_bucket", "card_type_answers",
    "card_payload"?, "payload_note"?} when exactly one detector fires AND
    the resulting answers resolve cleanly through db._card_type_verdict
    (status == "resolved") — i.e. a result this module returns is ALWAYS
    accepted by push_decision's own _verify_card_type, by construction.
    Returns None otherwise (no confident match, or more than one detector
    fired) — never a guess; callers fall back to card_type=None (plain
    list) or build card_payload + choose card_type by hand as before.

    `card_payload` is included only when it can be fully derived from
    (question, choices) (today: zone_select). When it's missing and the
    card type still needs one to avoid falling back to the plain list
    (today: balance_scale), `payload_note` says what to supply.
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
    card_type = verdict["matches"][0][0]
    result = {
        "card_type": card_type,
        "card_type_bucket": bucket,
        "card_type_answers": answers,
    }
    builder = _PAYLOAD_BUILDERS.get(card_type)
    if builder is not None:
        result["card_payload"] = builder(question, choices)
    note = _PAYLOAD_NOTES.get(card_type)
    if note is not None:
        result["payload_note"] = note
    return result
