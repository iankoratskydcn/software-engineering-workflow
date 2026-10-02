from jev import presets as p


def done(supports, contradicts, says_nothing, goal=0.9):
    answers = {
        "evidence_relation": {"probabilities": {"supports": supports, "contradicts": contradicts, "says_nothing": says_nothing}},
        "addresses_stated_goal": {"noul": goal},
    }
    return p.policy_result("done_check/v1", status="answered", answers=answers)["outcome"]


def test_clear_support_is_no_objection():
    assert done(0.9, 0.05, 0.05) == "no_objection"


def test_boundary_support_half_is_no_objection():
    assert done(0.5, 0.25, 0.25) == "no_objection"


def test_split_uncertainty_is_not_a_pass():
    # review finding: 98% non-support must not read as no_objection
    assert done(0.02, 0.49, 0.49) != "no_objection"


def test_contradiction_still_wins_first():
    assert done(0.1, 0.6, 0.3) == "objection_contradicted"


def test_no_outcome_is_approve_shaped():
    for preset in p.PRESETS.values():
        for outcome in preset.outcomes:
            assert not any(w in outcome for w in ("approve", "pass", "done", "merge")) or outcome in ("no_objection", "no_extra_hold", "no_flags")
