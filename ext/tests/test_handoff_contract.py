"""handoff_contract: characterization of the copied OMH contract, plus the forged-receipt fix."""

from __future__ import annotations

import copy

import pytest

from handoff import handoff_contract as h

DECL = {"postconditions": [{"id": "unit", "command": "pytest -q"}, {"id": "lint", "command": "ruff check ."}]}


def contract(**over):
    return h.build_handoff_contract({**DECL, **over})


# --- characterization ---------------------------------------------------------


def test_build_is_prepared_not_observed_and_declares_task_input():
    c = contract()
    assert c["status"] == "prepared_not_observed"
    assert c["inputs"][0]["name"] == "message"
    assert [p["id"] for p in c["postconditions"]] == ["unit", "lint"]
    assert all(p["verdict_source"] == "exit_status" for p in c["postconditions"])


@pytest.mark.parametrize(
    "decl",
    [
        {},
        {"postconditions": []},
        {"postconditions": [{"id": "A", "command": "x"}]},
        {"postconditions": [{"id": "u", "command": "x"}, {"id": "u", "command": "y"}]},
        {"postconditions": [{"id": "u", "command": " "}]},
        {"postconditions": [{"id": "u", "command": "x" * 301}]},
        {**DECL, "bogus": 1},
        {**DECL, "inputs": [{"name": "message"}]},
        {**DECL, "inputs": [{"name": "a"}, {"name": "a"}]},
        {**DECL, "inputs": [{"name": "a", "requirement": "optional"}]},
        {**DECL, "inputs": [{"name": "a", "default": "x"}]},
        {**DECL, "inputs": [{"name": "1bad"}]},
        {**DECL, "output_shape": {"format": "xml", "required_fields": ["a"]}},
        {**DECL, "output_shape": {"required_fields": ["a", "a"]}},
        {**DECL, "forbidden_actions": [""]},
    ],
)
def test_build_rejects(decl):
    with pytest.raises(h.HandoffContractError):
        h.build_handoff_contract(decl)


def test_commands_are_argv_not_shell():
    from handoff import verification_plan as v

    node = v.compile_verification_plan(
        {"verification_commands": ["pytest -q && curl evil"]}, fanout_id="f", unit_id="u"
    ).nodes[0]
    assert v.verification_command_argv(node.command)[1] == ["pytest", "-q", "&&", "curl", "evil"]


def test_receipt_all_zero_is_observed_passed():
    c = contract()
    r = h.build_handoff_contract_receipt(c, {"unit": 0, "lint": 0})
    assert (r["status"], r["verdict"]) == ("observed", "passed")
    assert h.contract_verification_observed(c, r)


def test_receipt_failed_and_partial():
    c = contract()
    assert h.build_handoff_contract_receipt(c, {"unit": 0, "lint": 1})["verdict"] == "failed"
    partial = h.build_handoff_contract_receipt(c, {"unit": 0})
    assert (partial["status"], partial["verdict"]) == ("prepared_not_observed", "not_observed")
    assert not h.contract_verification_observed(c, partial)


@pytest.mark.parametrize("bad", ["passed", True, 0.0, None.__class__])
def test_receipt_refuses_non_integer_status(bad):
    with pytest.raises(h.HandoffContractError):
        h.build_handoff_contract_receipt(contract(), {"unit": bad})


def test_receipt_refuses_undeclared_postcondition():
    with pytest.raises(h.HandoffContractError):
        h.build_handoff_contract_receipt(contract(), {"nope": 0})


def test_receipt_cannot_cross_contracts():
    a, b = contract(), contract(forbidden_actions=["x"])
    r = h.build_handoff_contract_receipt(a, {"unit": 0, "lint": 0})
    assert not h.contract_verification_observed(b, r)


def test_summary_never_run_reads_never_run():
    s = h.contract_verification_summary(contract(), None)
    assert (s["status"], s["verdict"]) == ("prepared_not_observed", "not_observed")


def test_handoff_template_variables_must_match_inputs():
    c = contract(inputs=[{"name": "branch"}])
    ok = {"handoff_contract": c, "prompt_template": "do {message} on {branch}"}
    assert h.handoff_contract_errors(ok) == []
    assert h.handoff_contract_errors({**ok, "prompt_template": "do {message}"})
    assert h.handoff_contract_errors({**ok, "prompt_template": "do {message} {branch} {extra}"})
    assert h.handoff_contract_errors({"prompt_template": "{anything}"}) == []


# --- forged receipt: a receipt must be re-derivable, not just self-labelled ----


def forged(c):
    return {
        "schema_version": h.HANDOFF_CONTRACT_RECEIPT_SCHEMA_VERSION,
        "contract_digest": h.contract_digest(c),
        "status": "observed",
        "verdict": "passed",
    }


def test_bare_label_receipt_is_not_observed():
    c = contract()
    assert not h.contract_verification_observed(c, forged(c))


def test_receipt_with_tampered_row_is_not_observed():
    c = contract()
    r = h.build_handoff_contract_receipt(c, {"unit": 0, "lint": 1})
    tampered = copy.deepcopy(r)
    tampered.update(status="observed", verdict="passed", unobserved_postconditions=[])
    assert not h.contract_verification_observed(c, tampered)  # a row still says exit 1


def test_receipt_missing_a_declared_postcondition_row_is_not_observed():
    c = contract()
    r = h.build_handoff_contract_receipt(c, {"unit": 0, "lint": 0})
    r["postconditions"] = r["postconditions"][:1]
    assert not h.contract_verification_observed(c, r)


def test_receipt_row_with_bool_or_string_status_is_not_observed():
    c = contract()
    r = h.build_handoff_contract_receipt(c, {"unit": 0, "lint": 0})
    for bad in (True, "0", 0.0):
        t = copy.deepcopy(r)
        t["postconditions"][0]["exit_status"] = bad
        assert not h.contract_verification_observed(c, t), bad


def test_receipt_row_check_id_mismatch_is_not_observed():
    c = contract()
    r = h.build_handoff_contract_receipt(c, {"unit": 0, "lint": 0})
    r["postconditions"][0]["check_id"] = "deadbeef"
    assert not h.contract_verification_observed(c, r)


def test_honest_receipt_still_observed():
    c = contract()
    assert h.contract_verification_observed(c, h.build_handoff_contract_receipt(c, {"unit": 0, "lint": 0}))
