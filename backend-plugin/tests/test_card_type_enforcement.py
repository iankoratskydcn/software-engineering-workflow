"""RED: tests for db.py's server-side card_type verification.

Goal: a caller can no longer just assert card_type="whatever" on
push_decision — if card_type is set, card_type_bucket + card_type_answers
must ALSO be given, and db.py runs the SAME deterministic rule engine as
card-type-gate's scripts/card_type_selector.py against them. The push is
rejected (ValueError) unless the engine's own verdict resolves to exactly
the claimed card_type. This makes the classifier load-bearing instead of
advisory prose in a skill doc.

Isolated from the live queue.db entirely: every test uses tmp_path.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db  # noqa: E402


def _mkconn(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    conn = db.connect()
    return conn


def _mkproject(tmp_path):
    """Create a real project row in the actual projects.db _resolve_project
    reads (tmp_path/projects.db, independent of the decisions-queue db.py
    opens via db.connect() — _resolve_project always targets
    _hermes_home()/projects.db, which IS patched to tmp_path here)."""
    import sqlite3
    import uuid
    projects_db_path = tmp_path / "projects.db"
    conn = sqlite3.connect(str(projects_db_path))
    conn.execute("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT)")
    pid = uuid.uuid4().hex[:12]
    conn.execute("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", (pid, "p", "P"))
    conn.commit()
    conn.close()
    return pid


def test_push_without_card_type_never_needs_bucket_or_answers(tmp_path, monkeypatch):
    conn = _mkconn(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    # No card_type at all -> always allowed, no verification needed.
    row = db.push_decision(conn, project_id=pid, question="q?", choices=["a", "b"])
    assert row["card_type"] is None


def test_push_with_card_type_but_no_bucket_answers_is_rejected(tmp_path, monkeypatch):
    conn = _mkconn(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    try:
        db.push_decision(conn, project_id=pid, question="q?", choices=["a", "b"],
                          card_type="scalar_slider")
        assert False, "expected ValueError: card_type without bucket/answers must be rejected"
    except ValueError as exc:
        assert "card_type_bucket" in str(exc) or "card_type_answers" in str(exc)


def test_push_with_card_type_matching_engine_verdict_succeeds(tmp_path, monkeypatch):
    conn = _mkconn(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    row = db.push_decision(
        conn, project_id=pid, question="Pick cache TTL", choices=["Confirm", "Cancel"],
        card_type="scalar_slider",
        card_type_bucket="continuous_single",
        card_type_answers={
            # The engine requires the full discriminant set for the bucket
            # (union across every rule in "continuous_single"), not just the
            # keys the matched rule happens to use. See db.py's
            # _card_type_verdict: `needed = {q for _, reqs in bucket_rules
            # for q in reqs}`.
            "is_interval_not_point": False,
            "needs_confidence_axis": False,
            "has_safe_defaults_to_confirm": False,
        },
    )
    assert row["card_type"] == "scalar_slider"


def test_push_with_card_type_NOT_matching_engine_verdict_is_rejected(tmp_path, monkeypatch):
    conn = _mkconn(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    try:
        db.push_decision(
            conn, project_id=pid, question="Pick cache TTL", choices=["Confirm", "Cancel"],
            card_type="range_slider",  # claiming range_slider while answers resolve to scalar_slider
            card_type_bucket="continuous_single",
            card_type_answers={
                "is_interval_not_point": False,
                "needs_confidence_axis": False,
                "has_safe_defaults_to_confirm": False,
            },
        )
        assert False, "expected ValueError: claimed card_type must match the engine's resolved card_type"
    except ValueError as exc:
        assert "range_slider" in str(exc) and "scalar_slider" in str(exc)


def test_push_with_incomplete_answers_is_rejected(tmp_path, monkeypatch):
    conn = _mkconn(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    try:
        db.push_decision(
            conn, project_id=pid, question="Pick cache TTL", choices=["Confirm", "Cancel"],
            card_type="scalar_slider",
            card_type_bucket="continuous_single",
            card_type_answers={"is_interval_not_point": False},  # missing 2 more discriminants
        )
        assert False, "expected ValueError: incomplete discriminant answers must be rejected, never silently accepted"
    except ValueError as exc:
        assert "incomplete" in str(exc).lower()


def test_push_with_empty_requires_bucket_needs_zero_answers(tmp_path, monkeypatch):
    """continuous_independent has exactly one card_type (rating_grid) with
    an EMPTY requires dict -- an empty answers dict must still resolve,
    with no special-case bypass needed in _card_type_verdict (an empty
    requires dict matches vacuously, same mechanism as every other rule)."""
    conn = _mkconn(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    row = db.push_decision(
        conn, project_id=pid, question="Rate each feature's impact", choices=["Ok", "Not now"],
        card_type="rating_grid",
        card_type_bucket="continuous_independent",
        card_type_answers={},
    )
    assert row["card_type"] == "rating_grid"


def test_push_with_mcq_context_needs_full_categorical_single_answers(tmp_path, monkeypatch):
    """mcq_context moved into categorical_single (v2 taxonomy) and is no
    longer a zero-question bypass -- it now needs that bucket's full
    discriminant set answered, same as every other categorical_single card."""
    conn = _mkconn(tmp_path, monkeypatch)
    pid = _mkproject(tmp_path)
    row = db.push_decision(
        conn, project_id=pid, question="Anything not fitting a shape", choices=["Ok", "Not now"],
        card_type="mcq_context",
        card_type_bucket="categorical_single",
        card_type_answers={
            "is_simple_boolean": False,
            "is_and_or_neither_logic": False,
            "is_quantized_few_levels": False,
            "cross_card_reactive": False,
        },
    )
    assert row["card_type"] == "mcq_context"


def test_every_bucket_rule_set_is_total_and_partitioned():
    """The invariant CARD_TYPE_GATE_AMBIGUITY_RESOLUTION.md's
    assert_rules_partitioned() proposed but never shipped: for every
    bucket, EVERY possible True/False assignment over that bucket's
    discriminant keys must resolve to exactly one card_type (never
    no_match, never ambiguous) -- the chain-of-Falses rule structure
    (each rule adds one more True among the previous rules' Falses) is
    supposed to guarantee this by construction; this proves it
    exhaustively per bucket instead of by eyeballing the rule table.
    No DB/project needed -- calls db._card_type_verdict directly."""
    import itertools

    buckets: dict[str, set] = {}
    for _card_type, bucket, reqs in db._CARD_TYPE_RULES:
        buckets.setdefault(bucket, set()).update(reqs.keys())
    # info_only is a single-condition pre-gate, not one of the matrix's
    # chained buckets -- False there legitimately means "not this, go
    # check the value_type/cardinality matrix instead", a real no_match,
    # not a gap in the chain. Every other bucket IS a closed chain.
    buckets.pop("info_only", None)

    for bucket, keys in buckets.items():
        keys = sorted(keys)
        for combo in itertools.product([True, False], repeat=len(keys)):
            answers = dict(zip(keys, combo))
            verdict = db._card_type_verdict(bucket, answers)
            assert verdict["status"] == "resolved", (
                f"bucket={bucket!r} answers={answers!r} -> {verdict['status']!r}, "
                "expected exactly one card_type to resolve for every combination"
            )
            assert len(verdict["matches"]) == 1, (bucket, answers, verdict["matches"])


if __name__ == "__main__":
    import tempfile
    from pathlib import Path as _P

    failures = []
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            with tempfile.TemporaryDirectory() as td:
                tmp_path = _P(td)
                _patched = []

                class _MP:
                    def setattr(self, obj, attr, val):
                        _patched.append((obj, attr, getattr(obj, attr)))
                        setattr(obj, attr, val)
                mp = _MP()
                try:
                    fn(tmp_path, mp)
                    print(f"PASS {name}")
                except AssertionError as e:
                    print(f"FAIL {name}: {e}")
                    failures.append(name)
                except Exception as e:
                    print(f"ERROR {name}: {type(e).__name__}: {e}")
                    failures.append(name)
                finally:
                    for obj, attr, orig in reversed(_patched):
                        setattr(obj, attr, orig)
    if failures:
        print(f"\n{len(failures)} failing (expected pre-implementation): {failures}")
    else:
        print("\nall pass")
