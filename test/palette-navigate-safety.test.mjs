import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Page navigation is intentional: these surfaces now follow the Kanban
// route pattern and are opened through the sidebar or command palette.
assert.match(source, /host\.navigate\('\/decision-hud'\)/)
assert.match(source, /host\.navigate\(AGENT_METRICS_ROUTE_PATH\)/)
assert.match(source, /host\.navigate\(AGENT_DASHBOARD_ROUTE_PATH\)/)

assert.doesNotMatch(
  source,
  /id:\s*'open-agent-metrics'/,
  "the redundant 'open-agent-metrics' palette command must not be registered",
)

// The three page surfaces have sidebar entries, matching Kanban's route-backed
// page pattern. Task List is deliberately excluded because it remains a
// permanently right-docked operational queue in its separate plugin.
assert.match(source, /area:\s*SIDEBAR_NAV_AREA/)
assert.match(source, /label:\s*'Software Engineering',\s*path:\s*'\/decision-hud'/)
assert.match(source, /ENGINEERING_TABS[\s\S]*?label: 'Spec Digest'/)
assert.doesNotMatch(source, /ENGINEERING_TABS[\s\S]*?label: 'Retrospective'/)
assert.doesNotMatch(source, /id:\s*'spec-digest-nav'/)
assert.doesNotMatch(source, /id:\s*'decision-hud-flowcharts-nav'/)
assert.doesNotMatch(source, /id:\s*'roadmap-nav'/)

assert.match(
  source,
  /id:\s*'agent-metrics-route'[\s\S]{0,120}data:\s*\{\s*path:\s*AGENT_METRICS_ROUTE_PATH/,
  'the Agent Dashboard full page must remain reachable via its ROUTES_AREA registration',
)

console.log('palette-navigate-safety regression test passed')
