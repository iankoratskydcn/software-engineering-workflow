# Third-party notices

## oh-my-hermes (MIT)

Source: https://github.com/rlaope/oh-my-hermes, commit 4ab239b10ae37763a774168ad25f091005c5d738.
Copied code lives under `vendor/omh/` (see `vendor/omh/PROVENANCE.json` for per-file
upstream paths and hashes). Licence text: `vendor/omh/LICENSE`.
Copyright (c) 2026 oh-my-hermes contributors.

This is copied code, not a dependency. Modified derivatives must keep a provenance entry.

Adapted derivatives (modified): `ext/jev/client.py`, `ext/jev/presets.py` (see PROVENANCE.json).

Note: OMH's `action_check/v1` thresholds were themselves adopted by OMH from the MIT-licensed
`hermes-jev-approvals` plugin (`jev-approval-rules/1`, `plugin/jev_policy.py` @530fdb0). Their
calibration was for different questions and does not transfer; treat them as unmeasured.
