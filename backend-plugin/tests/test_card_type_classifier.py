"""Tests for card_type_classifier.py — the text-only auto-classifier.

Every positive result must independently survive db._card_type_verdict
(the exact engine push_decision enforces) — that's the correctness
property this module exists for: a classifier result can never fail
_verify_card_type. Negative cases (None) are equally load-bearing: the
classifier must never guess on a question it can't confidently place.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import card_type_classifier  # noqa: E402
import db  # noqa: E402


def _assert_survives_engine(result):
    verdict = db._card_type_verdict(result["card_type_bucket"], result["card_type_answers"])
    assert verdict["status"] == "resolved"
    assert verdict["matches"][0][0] == result["card_type"]


def test_quad_choice_detected_from_both_neither_choices():
    result = card_type_classifier.classify(
        "Should we support offline mode and dark theme?",
        ["Offline mode only", "Dark theme only", "Both", "Neither"],
    )
    assert result is not None
    assert result["card_type"] == "quad_choice"
    _assert_survives_engine(result)


def test_zone_select_detected_from_tier_choices():
    result = card_type_classifier.classify(
        "How severe is this bug?",
        ["Low", "Medium", "High"],
    )
    assert result is not None
    assert result["card_type"] == "zone_select"
    _assert_survives_engine(result)


def test_zone_select_result_includes_derived_payload():
    """ZoneSelectCard needs card_payload.zones or it falls back to the plain
    list (plugin.js) -- the classifier must derive it, not just the verdict."""
    result = card_type_classifier.classify("How severe is this bug?", ["Low", "Medium", "High"])
    assert result["card_payload"] == {
        "zones": [
            {"key": "low", "label": "Low"},
            {"key": "medium", "label": "Medium"},
            {"key": "high", "label": "High"},
        ]
    }


def test_tier_substring_inside_unrelated_word_is_not_a_false_positive():
    """'Workflow A' contains the literal substring 'low' (inside 'flow') --
    a plain substring check wrongly reads that as a tier label. Must not."""
    result = card_type_classifier.classify("Which workflow?", ["Workflow A", "Workflow B"])
    assert result is None


def test_balance_scale_detected_from_two_options_and_tradeoff_wording():
    result = card_type_classifier.classify(
        "Strict schema vs loose schema — which should we weigh in favor of?",
        ["Strict schema", "Loose schema"],
    )
    assert result is not None
    assert result["card_type"] == "balance_scale"
    _assert_survives_engine(result)


def test_balance_scale_result_includes_payload_note():
    """considerations is a THIRD list distinct from the two choices -- the
    classifier has no source for it and must say so, not silently omit it."""
    result = card_type_classifier.classify(
        "Strict schema vs loose schema?", ["Strict schema", "Loose schema"]
    )
    assert "card_payload" not in result
    assert "considerations" in result["payload_note"]


def test_balance_scale_detects_inflected_weigh_forms():
    """Canonical tradeoff phrasing ('weighing X against Y', 'X outweighs Y')
    must match, not just the bare token 'weigh'."""
    for question in (
        "Weighing cost against reliability, which should we choose?",
        "Which option outweighs the other?",
    ):
        result = card_type_classifier.classify(question, ["Cost", "Reliability"])
        assert result is not None, question
        assert result["card_type"] == "balance_scale"


def test_two_tier_choices_with_comparison_wording_prefers_zone_select():
    """Both detectors' raw conditions are satisfied here (2 tier choices +
    'vs' wording) -- zone_select must win outright, not cancel out to None."""
    result = card_type_classifier.classify("Should the setting be low vs high?", ["Low", "High"])
    assert result is not None
    assert result["card_type"] == "zone_select"


def test_two_plain_choices_with_no_tradeoff_wording_is_not_classified():
    """Two choices alone isn't enough — no comparison wording means this
    could just as easily be an ordinary pick-one. Must not guess."""
    result = card_type_classifier.classify("Which cache backend?", ["Redis", "Memcached"])
    assert result is None


def test_generic_question_is_not_classified():
    result = card_type_classifier.classify("What should we name this?", ["Alpha", "Beta", "Gamma"])
    assert result is None


def test_empty_choices_is_not_classified():
    result = card_type_classifier.classify("Anything to add?", [])
    assert result is None


def test_partial_tier_match_is_not_classified():
    """Only SOME choices look like tiers -> no false positive."""
    result = card_type_classifier.classify("Pick one", ["Low", "Banana", "High"])
    assert result is None
