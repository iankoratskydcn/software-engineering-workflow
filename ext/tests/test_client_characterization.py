"""Characterization of the OMH Jev client safety properties we keep.

Written against the unmodified copy (commit ef9668b, all green), then moved to
the `endpoint=` API when routes were replaced by LayaEndpoint. A later change
that breaks one is a deliberate decision.
"""

from __future__ import annotations

import json
from urllib.request import Request

import pytest

from jev import client as c

KEY = "sk-laya-0123456789abcdef"
BODY = c.build_request_body("m", "state", {"q": {"type": "noul", "instructions": "x"}})


def reply(status=200, body=b"{}", headers=None):
    return c.TransportReply(status, headers or {}, body)


class Script:
    """Transport double: returns queued replies/raises queued errors; records requests."""

    def __init__(self, *items):
        self.items = list(items)
        self.requests: list[Request] = []

    def __call__(self, request, timeout):
        self.requests.append(request)
        item = self.items.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def ask(script, **kw):
    sleeps = []
    out = c.send_ask(
        endpoint=c.LayaEndpoint("10.0.0.5"),
        key=KEY,
        body=BODY,
        user_agent="t",
        transport=script,
        sleep=sleeps.append,
        jitter=lambda: 0.0,
        **kw,
    )
    return out, sleeps


# --- status mapping: exactly one answer status -------------------------------


@pytest.mark.parametrize(
    "code,status",
    [
        (200, c.STATUS_ANSWERED),
        (301, c.STATUS_REJECTED_REDIRECT),
        (302, c.STATUS_REJECTED_REDIRECT),
        (400, c.STATUS_REJECTED_BY_API),
        (401, c.STATUS_AUTH_FAILED),
        (402, c.STATUS_PAYMENT_REQUIRED),
        (403, c.STATUS_PERMISSION_DENIED),
        (429, c.STATUS_RATE_LIMITED),
        (503, c.STATUS_OVERLOADED),
        (529, c.STATUS_OVERLOADED),
        (504, c.STATUS_TIMEOUT),
        (524, c.STATUS_TIMEOUT),
        (500, c.STATUS_SERVER_ERROR),
        (502, c.STATUS_SERVER_ERROR),
        (204, c.STATUS_MALFORMED_RESPONSE),
    ],
)
def test_http_status_mapping(code, status):
    assert c._status_for_http(code) == status


def test_only_answered_is_success():
    assert c.SUCCESS_STATUS == c.STATUS_ANSWERED
    assert c.STATUS_ANSWERED in c.ASK_STATUSES


# --- retry matrix ------------------------------------------------------------


def test_retries_only_not_processed_replies():
    for code in (500, 502, 504, 401, 400):
        script = Script(reply(code))
        out, sleeps = ask(script)
        assert out["attempts"] == 1, code
        assert sleeps == [], code


def test_429_then_answer_retries_once():
    script = Script(reply(429), reply(200, b'{"a": 1}'))
    out, sleeps = ask(script)
    assert out["status"] == c.STATUS_ANSWERED
    assert out["attempts"] == 2
    assert len(sleeps) == 1


def test_retry_cap():
    script = Script(reply(503), reply(503), reply(503), reply(503))
    out, _ = ask(script)
    assert out["status"] == c.STATUS_OVERLOADED
    assert out["attempts"] == c.MAX_RETRIES + 1


def test_network_error_never_retried():
    out, sleeps = ask(Script(OSError("boom")))
    assert out["status"] == c.STATUS_NETWORK_ERROR
    assert out["attempts"] == 1 and sleeps == []


def test_unknown_transport_exception_is_network_error_not_answer():
    out, _ = ask(Script(RuntimeError("x")))
    assert out["status"] == c.STATUS_NETWORK_ERROR


def test_timeout_classified():
    out, _ = ask(Script(TimeoutError()))
    assert out["status"] == c.STATUS_TIMEOUT


def test_retry_after_beyond_deadline_is_not_slept():
    script = Script(reply(429, headers={"retry-after": "999"}))
    out, sleeps = ask(script)
    assert out["status"] == c.STATUS_RATE_LIMITED
    assert sleeps == []


# --- request/response bounds and redirect refusal ----------------------------


def test_request_body_cap():
    with pytest.raises(c.AskRequestError):
        c.build_request_body("m", "x" * (c.MAX_REQUEST_BYTES + 1), {})


def test_response_cap_is_malformed_not_answer():
    big = b"{" + b" " * (c.MAX_RESPONSE_BYTES + 1) + b"}"
    out, _ = ask(Script(reply(200, big)))
    assert out["status"] == c.STATUS_MALFORMED_RESPONSE


@pytest.mark.parametrize("body", [b"not json", b"[1,2]", b"\xff\xfe"])
def test_non_object_body_is_malformed(body):
    out, _ = ask(Script(reply(200, body)))
    assert out["status"] == c.STATUS_MALFORMED_RESPONSE


def test_redirect_handler_refuses():
    assert c._RefuseRedirects().redirect_request(None, None, 302, "", {}, "https://evil/") is None


def test_request_has_exactly_three_body_keys_and_bearer_header():
    script = Script(reply(200, b"{}"))
    ask(script)
    req = script.requests[0]
    assert set(json.loads(req.data)) == {"model", "state", "questions"}
    assert req.get_method() == "POST"


# --- key redaction -----------------------------------------------------------


@pytest.mark.parametrize(
    "echo",
    [KEY, KEY.upper(), KEY[3:15], "s k - l a y a - 0 1 2 3 4 5 6 7 8 9", "sk-laya-\\u0030123456789abcdef"],
)
def test_scrub_key_hides_every_spelling(echo):
    out = c.scrub_key(f"bad {echo} here", KEY)
    assert not c.carries_key_fragment(out, KEY)


def test_error_excerpt_is_scrubbed_and_bounded():
    body = (("x" * 400) + KEY).encode()
    out, _ = ask(Script(reply(401, body)))
    assert out["status"] == c.STATUS_AUTH_FAILED
    assert len(out["api_error"]) <= c.MAX_API_ERROR_CHARS
    assert not c.carries_key_fragment(out["api_error"], KEY)


def test_result_never_contains_key():
    out, _ = ask(Script(reply(403, KEY.encode())))
    assert KEY not in json.dumps(out)


def test_served_model_scrubbed():
    assert KEY not in c.safe_served_model("jev-" + KEY, KEY)


# --- reply validation: partial or out-of-range answers are never answers -----

Q = {"q": {"type": "noul", "instructions": "x"}}


def good(**over):
    r = {"answers": {"q": {"type": "noul", "noul": 0.7}}, "usage": {"input_tokens": 1, "output_tokens": 1}, "model": "m"}
    r.update(over)
    return r


def test_validate_reply_ok():
    assert c.validate_reply(Q, good())["answers"]["q"]["noul"] == 0.7


@pytest.mark.parametrize(
    "bad",
    [
        good(answers={}),
        good(answers={"q": {"type": "noul", "noul": 0.7}, "extra": {"type": "noul", "noul": 0.1}}),
        good(answers={"q": {"type": "choice", "noul": 0.7}}),
        good(answers={"q": {"type": "noul", "noul": 1.5}}),
        good(answers={"q": {"type": "noul", "noul": float("nan")}}),
        good(answers={"q": {"type": "noul", "noul": True}}),
        good(usage={"input_tokens": -1, "output_tokens": 1}),
        good(usage=None),
    ],
)
def test_validate_reply_rejects(bad):
    with pytest.raises(c.MalformedReply):
        c.validate_reply(Q, bad)


# --- request validation ------------------------------------------------------


@pytest.mark.parametrize("q", [{}, {"": {"type": "noul", "instructions": "x"}}, {"q": {"type": "x", "instructions": "x"}},
                               {"q": {"type": "noul", "instructions": " "}}, {"q": {"type": "choice", "instructions": "x"}},
                               {"q": {"type": "score", "instructions": "x", "criteria": ["a"]}}])
def test_validate_questions_rejects(q):
    with pytest.raises(c.AskRequestError):
        c.validate_questions(q)


@pytest.mark.parametrize("s", ["", "  ", {}, [], 5, None])
def test_validate_state_rejects(s):
    with pytest.raises(c.AskRequestError):
        c.validate_state(s)
