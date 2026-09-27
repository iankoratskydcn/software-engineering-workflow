import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Decision HUD and its visualization surfaces are route-backed pages, matching
// Kanban. They must not regress to docked-pane-only registrations.
assert.match(source, /id:\s*'decision-hud-page'[\s\S]{0,160}area:\s*ROUTES_AREA/)
assert.match(source, /id:\s*'decision-hud-nav'[\s\S]{0,180}area:\s*SIDEBAR_NAV_AREA/)
assert.match(source, /id:\s*'agent-metrics-widgets-route'[\s\S]{0,160}area:\s*ROUTES_AREA/)
assert.match(source, /ENGINEERING_TABS[\s\S]*?label: 'Retrospective'/)
assert.doesNotMatch(source, /id:\s*'agent-dashboard-nav'/)
assert.doesNotMatch(
  source,
  /id:\s*PANE_ID,\s*area:\s*'panes'/,
  'Decision HUD must not be registered as a docked pane when it is a full-page surface',
)

// The Task List owns the persistent docked operational queue in its separate
// plugin; this plugin only documents that contract in its layout settings.
assert.match(source, /Task List remains docked beside chat/)

console.log('route-backed workspace and persistent task-list dock contract passed')
