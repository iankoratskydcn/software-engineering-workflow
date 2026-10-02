# OMH loot ledger

Policy: mine OMH code by copy-paste, never depend on it. Order per module:
**security scan -> verbatim copy -> characterization tests (TDD) -> rewire/repurpose -> delete loser.**
Scanner: NVIDIA SkillSpector v2.12.0 (`2226747`), static only (`--no-llm`, no code sent to any LLM).
Source pin: `rlaope/oh-my-hermes@4ab239b` (MIT). Plan had pinned `d23a7f8`; upstream HEAD has moved.

## Caveat on "passes"

SkillSpector reports `analysis_completeness: partial` (`static_parse_limit`) on several files
(its parser span bound trips on long files). So a clean scan is **not** full coverage.
Compensating control: manual grep for `eval/exec/pickle/marshal/subprocess/os.system/ctypes/
importlib/yaml.load/shell=True`. Result: none in batch 1 or the wider closure; only network
use is `urllib` in `jev_ask_client` (fixed HTTPS routes, see below).
Raw reports: `scans/`.

## Batch 1 (copied verbatim in this commit)

| Module | Lines | Intra-OMH deps | Scan | Decision |
|---|---|---|---|---|
| `jev_ask_client.py` | 716 | none (stdlib) | 1 MEDIUM: hardcoded `api.typesafe.ai` / `openrouter.ai` routes. True but expected. Code is the hardened client. | **ADAPT**: keep hardening (HTTPS-only, refuse redirects, byte/deadline bounds, key redaction, retry only on not-processed codes). Replace `ROUTES` with local Jev endpoint config. Never ship with the external routes active. Also adopt hardening into `sidecar_client.py`. |
| `jev_presets.py` | 384 | none | clean | **ADAPT**: typed-question presets + deterministic policy (probability != permission). |
| `jev_consent.py` | 525 | none | clean | **EVALUATE**: consent gate is OMH/Hermes-session specific (reads Kanban/env flags). Likely rewire to Decision HUD authority. |

Scan of the exact copies (`scans/batch1-jev.json`): score 7 LOW, 1 MEDIUM (the routes above), partial coverage 75%.

False positives in the wider closure pre-scan (`scans/closure-p*-prescan.json`), triaged:
- `jev_sidekick.py:265` "auto-approve": disclosure string saying it never auto-approves.
- `local_store.py:99` "Tool Parameter Abuse": regex matched the word `chmod` in a comment.
- `approval_receipts.py:311,1099` "Excessive Agency": refusal message text.

## Not yet copied (true dependency closure; correction to earlier "leaf" claims)

| Module | Why deferred |
|---|---|
| `verification_plan.py`, `handoff_contract.py` | Pull in `fanout_contracts` -> `executors`, plus `verification_environment`. Closure must be sized and scanned first. |
| `context_safety.py` | Lazy-imports `wait_strategy`. Scan that first. |
| `approval_receipts.py` | Needs `system/{append_only_store,local_store,metadata_safety}` (scanned, no true positives). Ready for batch 2. |
| `action_gate.py` | Design-only. 2.9k lines tied to goal-loop vocabulary. Re-implement trimmed against Decision HUD. |
| `jev_ask_store.py`, `jev_sidekick.py` | Need `awareness_delivery` / `metadata`. Probably skip. |
| `runtime/records.py`, `runtime/artifacts.py` | Do not loot. ~30-module import fan-out. |

## Test reality (changes the TDD plan)

OMH's own tests (`test_handoff_contract`, `test_verification_plan`, `test_context_safety`,
`test_approval_receipts`, `test_jev_ask_tool`) are integration tests that import the OMH CLI,
`runtime.artifacts`, `runtime.records` and test harnesses. They do not run against looted
modules in isolation. Only `test_jev_presets` is near-standalone. So we write our own
characterization tests per module (pin current behavior, then change behavior test-first).

## Placement note

This repo is a Decision HUD plugin + docs repo with no Python package or pytest config at root.
Looted code sits in `vendor/omh/` (frozen verbatim). Rewired code goes elsewhere (proposed
`ext/`) so `vendor/` stays diffable against upstream. Revisit if you want a different layout.

## Known defects in vendored code (from PR #19 review; fix in `ext/`, test-first)

1. `jev_ask_client.py` (~L324): a successful reply returns the parsed object without key scrubbing, so a server/proxy echo of the key (e.g. in `model`) would pass through. Failing test first: success reply containing the key comes back redacted.
2. `jev_presets.py` (~L301) `_done_check_ladder`: supports=0.02, contradicts=0.49, says_nothing=0.49 yields `no_objection`. Failing test first, then gate on positive support.

`vendor/omh/` stays verbatim; these are fixed only in the rewired copy.

## Next steps

1. Characterization tests for batch 1 (`jev_ask_client` first: redirect refusal, size/deadline bounds, key redaction, retry matrix).
2. Rewire `ROUTES` to local Jev (test-first), add fail-closed "unavailable != approval" test.
3. Size/scan closure for `verification_plan`/`handoff_contract` (batch 2), then `approval_receipts`.
