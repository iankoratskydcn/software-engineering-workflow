"""swe-suite/vectors are generated from db.py; stale files would let core.js drift unnoticed."""
from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "swe-suite"


def test_vectors_match_python_reference():
    spec = importlib.util.spec_from_file_location("gen_vectors", ROOT / "gen_vectors.py")
    gen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen)
    for name, text in gen.build().items():
        assert (ROOT / "vectors" / name).read_text() == text, f"{name} is stale; run python swe-suite/gen_vectors.py"
