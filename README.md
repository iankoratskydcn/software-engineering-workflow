# Decision HUD

Cross-project Decision HUD desktop plugin for Hermes: a card-stack decision queue plus an Agent Dashboard pane, docked beside the main chat.

- **Frontend:** `plugin.js` — a single self-contained ESM file loaded at runtime by the Hermes desktop app's plugin loader (blob URL — no build step, no relative imports; see the comment block at the top of `plugin.js` for why internal components are inlined rather than split into files).
- **Backend (decisions):** `~/.hermes/plugins/decision-hud/` (SQLite-backed, driven through `hermes decision ...` CLI commands via the generic `cli.exec` RPC — the pane never touches the DB file directly).
- **Backend (agent dashboard telemetry):** `backend/` in this repo — a PostgreSQL-backed read-only HTTP service, with disposable Docker Compose integration tests. See `docs/agent-dashboard-decision-record.md` for the authority/scope decisions behind it.

## Setup for agents / contributors (read this before touching the repo)

### 1. Clone
```
gh repo clone iankoratskydcn/decision-hud
```

### 2. Frontend tests
`package.json` declares no dependencies. `npm run test:setup` installs `react`, `react-dom` and `jsdom` with `--no-save`, then copies the committed `@hermes/plugin-sdk` stub (`test/stubs/plugin-sdk/`) into `node_modules/`. Then `npm test` runs the suite (`test/*.test.mjs`). Re-run `npm run test:setup` after any `npm install`, which prunes the stub. CI does exactly this.

The stub exports exactly what `plugin.js`'s top `import` line pulls in. Its `PALETTE_AREA` / `ROUTES_AREA` / `SIDEBAR_NAV_AREA` strings match hermes-agent (`apps/desktop/src/app/command-palette/contrib.ts`, `apps/desktop/src/app/routes.ts`). If `plugin.js` starts importing another name from the SDK, add it to the stub; a wrong area string breaks registration-matching tests even when the plugin code is correct.

### 3. Deploy for live use in the desktop app
Symlink the whole repo directory into the desktop plugin root so edits hot-reload with no copy step:
```
cmd /c mklink "%LOCALAPPDATA%\hermes\desktop-plugins\decision-hud" "<path to this repo>"
```
(macOS/Linux: `ln -s <path to this repo> "$HERMES_HOME/desktop-plugins/decision-hud"`.)
Then Command Palette → "Reload desktop plugins" to force the first load. Subsequent saves hot-reload automatically.

### 4. Backend tests
Plugin backend (SQLite, no services needed), from the repo root:
```
pip install pytest pyyaml
python -m pytest backend-plugin/tests
```

Agent dashboard telemetry (needs Postgres), also from the repo root. The pytest config in `backend/pyproject.toml` only resolves from the repo root with `backend/` on `PYTHONPATH`; running from `backend/` does not work.
```
docker compose -f backend/docker-compose.yml up -d   # disposable Postgres on 127.0.0.1:55432
pip install pytest pytest-asyncio "psycopg[binary]"
export DASHBOARD_TEST_DATABASE_URL=postgresql://dashboard:dashboard@127.0.0.1:55432/dashboard
PYTHONPATH=backend python -m pytest -c backend/pyproject.toml backend/tests
```
Two HTTP-route tests skip unless the plugin is installed at `~/.hermes/plugins/decision-hud/` (symlink `backend-plugin` there to run them). Without `DASHBOARD_TEST_DATABASE_URL`, the Postgres tests fail rather than skip. See `backend/pyproject.toml` for the `integration` marker.

## Windows gotcha: CRLF breaks structural tests
Some frontend tests (`test/settings-gear.test.mjs`, `test/sidebar-order-swap.test.mjs`, etc.) read `plugin.js` as raw text and match regexes containing literal `\n`. A Windows checkout with `core.autocrlf=true` normalizes the file to CRLF, silently breaking those regexes — the test fails with a misleading message (e.g. "DecisionHudPane function must exist") even though the function is present. This repo ships a `.gitattributes` forcing LF on checkout, so a fresh clone is unaffected; if you still hit this, `git config core.autocrlf false` and re-checkout the affected file(s) (`git checkout -- plugin.js`), then verify with `file plugin.js` (should say "UTF-8 text" with no "CRLF line terminators").

## Rich decision cards
See the `decision-hud-cards` skill for the card-type taxonomy, the `card_type`/`card_payload` schema, and the workflow for pushing/rendering rich decision cards instead of plain MCQ.
