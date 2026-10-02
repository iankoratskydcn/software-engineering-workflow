"""Laya failing must never read as approval: every non-answer maps to the preset's hold/fail outcome."""

from __future__ import annotations

import pytest

from jev import client as c
from jev import presets as p

EP = c.LayaEndpoint("10.0.0.5")
BODY = c.build_request_body("laya", "s", {"q": {"type": "noul", "instructions": "x"}})
PASS_SHAPED = {"no_objection", "no_extra_hold", "no_flags"}


def run(transport):
    return c.send_ask(endpoint=EP, key="laya-key-0123456789", body=BODY, user_agent="t", transport=transport,
                      sleep=lambda s: None, jitter=lambda: 0.0)


def reply(code, body=b"{}"):
    return lambda req, timeout: c.TransportReply(code, {}, body)


def boom(exc):
    def t(req, timeout):
        raise exc
    return t


FAILURES = {
    "unreachable": boom(OSError("down")),
    "timeout": boom(TimeoutError()),
    "unknown_exc": boom(RuntimeError("x")),
    "401": reply(401), "403": reply(403), "429": reply(429), "500": reply(500), "503": reply(503),
    "redirect": reply(302), "bad_json": reply(200, b"nope"), "array": reply(200, b"[]"), "204": reply(204),
}


@pytest.mark.parametrize("name", FAILURES)
@pytest.mark.parametrize("preset_id", list(p.PRESETS))
def test_failure_never_yields_pass_shaped_outcome(name, preset_id):
    out = run(FAILURES[name])
    assert out["status"] != c.SUCCESS_STATUS
    result = p.policy_result(preset_id, status=out["status"], answers=out.get("reply", {}).get("answers"))
    assert result["outcome"] == p.PRESETS[preset_id].fail_outcome
    assert result["outcome"] not in PASS_SHAPED
    assert result["rule"] == f"not_answered:{out['status']}"


@pytest.mark.parametrize("preset_id", list(p.PRESETS))
def test_non_answered_status_ignores_supplied_answers(preset_id):
    # even a hostile "answers" payload cannot turn a non-answer into a pass
    fake = {"evidence_relation": {"probabilities": {"supports": 1.0, "contradicts": 0.0, "says_nothing": 0.0}}}
    result = p.policy_result(preset_id, status=c.STATUS_TIMEOUT, answers=fake)
    assert result["outcome"] == p.PRESETS[preset_id].fail_outcome


def test_every_fail_outcome_is_not_pass_shaped():
    for preset in p.PRESETS.values():
        assert preset.fail_outcome not in PASS_SHAPED
