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
| `jev_consent.py` | 525 | none | clean | **DROPPED** (removed from `vendor/`; recoverable from git history). It gates data leaving the machine to a public Jev on the person naming Jev this turn, via Hermes hook internals pinned to specific hermes-agent commits. Laya is on our LAN and `LayaEndpoint` already refuses non-LAN hosts, so the requirement is gone. Authority for acting on Laya answers belongs to the Decision HUD/policy layer, not this gate. |

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

## Status: batch 1 rewired for Laya (`ext/jev/`)

Test-first: 61 characterization tests green on the unmodified copy (`ef9668b`), then red tests
for the target (50 failing), then implementation, now 113 green (`cd ext && python -m pytest`).

- `LayaEndpoint(host, port, ca_file)`: LAN-only (private/loopback IP, or `.lan/.local/.internal/.home.arpa`). Public IPs and hostnames, userinfo, ports in host, and bad ports are refused at construction. Real TLS round trip tested on loopback with a private CA; untrusted cert is a `network_error` and the key never reaches the server.
- External routes, pricing and model-pin constants removed.
- Review defect 1 fixed: success reply deep-scrubbed of the key.
- Review defect 2 fixed: `done_check/v1` returns `objection_unsupported` when supports < 0.5.
- Rescan of `ext/jev`: score 0, no issues (partial coverage, parser limit on `client.py`).
- Still open: Laya model id and any wire differences from `/v1/systemone` (assumed same wire); `jev_consent` decision; preset thresholds are unmeasured and `action_check/v1` numbers came from another plugin's different questions.

## Batch 2 (scanned closures)

Closures computed by AST import walk (including lazy imports):

| Candidate | Closure | Scan | Decision |
|---|---|---|---|
| `handoff_contract` + `verification_plan` | 5 files, 1,389 lines (`executors`, `fanout_contracts`, `verification_environment`) | score 0, no issues, coverage 80% (parser limit on `verification_plan`); grep clean | **COPIED** verbatim to `vendor/omh/coding/`; working copy `ext/handoff/` |
| `context_safety` | 2 files, 1,321 lines (+`wait_strategy`) | score 0, coverage 50% (parser limit); grep clean | **DEFERRED**: requirement unclear (OMH/Codex-specific run-history and wrapper stripping). Question before copying. |
| `approval_receipts` | 6 files, 3,421 lines (+`system/{paths,local_store,append_only_store,metadata_safety,output_truncation}`) | 7 flags, all false positives: `self_update` strings in OMH's own venv path helpers (`paths.py`), `chmod` in a comment, refusal text; coverage only 33% | **NOT COPIED**: drags in 852-line OMH path layout, weak scan coverage, and overlaps the Decision HUD decision store. Take the idea (append-only, revision-bound approvals), not the code. |

`ext/handoff` (test-first, `ext/tests/test_handoff_contract.py`): 28 characterization tests green on the copy, then 5 red tests for the defect below, then fix. Rescan: score 0, no issues, coverage 83%.

**Defect found (ours, not from a review bot):** `contract_verification_observed` trusted the receipt's own `status`/`verdict` labels plus the digest, so a hand-written receipt `{digest, status: observed, verdict: passed}` with no rows counted as verified. Fixed: the receipt must carry one row per declared postcondition with matching id/check_id and integer exit status 0, labels must agree.

Notes for the runner (not yet built): postcondition commands are argv-split, not shell-run (`&&`, `$(...)`, `;` stay literal arguments), but `rm -rf /` is accepted as a declaration. Whatever executes postconditions must enforce an allowlist/authority; the contract only declares.

## Next steps

1. Add fail-closed "Laya unavailable != approval" test at the tool/policy boundary (`policy_result` already maps non-answers to the preset's fail outcome; test it end to end with the client).
2. Decide `jev_consent`.
3. Size/scan closure for `verification_plan`/`handoff_contract` (batch 2), then `approval_receipts`.
