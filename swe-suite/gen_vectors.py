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


def build() -> dict[str, str]:
    lines = ",\n".join(json.dumps(case, sort_keys=True) for case in readiness_vectors())
    return {"readiness.json": f"[\n{lines}\n]\n"}  # one case per line, so diffs stay readable


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
