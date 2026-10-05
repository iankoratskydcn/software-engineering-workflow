"""Writes swe-suite/vectors/*.json from the Python implementation (the reference).

    python swe-suite/gen_vectors.py          # rewrite the files
    python swe-suite/gen_vectors.py --check  # exit 1 if they are stale

core.js is tested against these files, and backend-plugin tests fail when they are stale.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "backend-plugin"))
import db  # noqa: E402

GOOD = json.dumps(["Login succeeds", "Wrong password is rejected"])


def readiness_vectors() -> list[dict]:
    cases = []
    for kind in ("theme", "epic", "feature", "story", "bogus"):
        for criteria in (GOOD, "[]", "", None, "not json", "{}", '["ok", ""]', '["ok", "  "]', '[1]', '["a"]'):
            for estimate in (None, 1, 3, 5, 6, 8, 13):
                inp = {"kind": kind, "criteria_json": criteria, "estimate": estimate}
                cases.append({"input": inp, "output": db.spec_readiness(**inp)})
    return cases


CANONICAL_VALUES = [
    {}, [], {"b": 1, "a": [], "c": {}},
    {"id": "x", "criteria": ["one", "two"], "estimate": 3, "task_ref": None, "ok": True},
    {"title": "caf\u00e9 \u2014 \u65e5\u672c\u8a9e", "emoji": "\U0001f600"},
    {"quote": 'say "hi"\\ back', "ctl": "tab\tnl\ncr\r\x01\x7f", "slash": "a/b"},
    {"nested": {"z": [{"b": 2, "a": 1}, [1, [2, []]]], "a": None}},
    {"Zebra": 1, "apple": 2, "_u": 3, "1": 4},
    [0, -7, 123456789, False, None, "s"],
]


def canonical_vectors() -> list[dict]:
    return [{"value": v, "text": json.dumps(v, indent=2, sort_keys=True) + "\n"} for v in CANONICAL_VALUES]


def _lines(cases: list[dict]) -> str:
    body = ",\n".join(json.dumps(case, sort_keys=True) for case in cases)
    return f"[\n{body}\n]\n"  # one case per line, so diffs stay readable


def build() -> dict[str, str]:
    return {"readiness.json": _lines(readiness_vectors()), "canonical_json.json": _lines(canonical_vectors())}


def main() -> int:
    out = HERE / "vectors"
    out.mkdir(exist_ok=True)
    stale = False
    for name, text in build().items():
        path = out / name
        if "--check" in sys.argv:
            stale |= not path.exists() or path.read_text() != text
        else:
            path.write_text(text)
    if stale:
        print("vectors are stale; run python swe-suite/gen_vectors.py", file=sys.stderr)
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
