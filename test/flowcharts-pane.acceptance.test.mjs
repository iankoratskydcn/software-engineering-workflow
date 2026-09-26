import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = await readFile(resolve('plugin.js'), 'utf8')

assert.match(source, /Flowcharts/)
assert.match(source, /decision-hud-flowcharts-route[\s\S]*?path:\s*['"]\/decision-hud\/flowcharts['"]/)
assert.match(source, /decision-hud-flowcharts-nav[\s\S]*?label:\s*['"]Flowcharts['"]/)

const pane = source.match(/function FlowchartsPane\(\)[\s\S]*?(?=\nfunction |\nconst |\nexport )/)?.[0]
assert.ok(pane, 'FlowchartsPane must exist as an independently testable surface')

assert.match(pane, /['"]decision['"],\s*['"]flow['"],\s*['"]list['"],\s*['"]--project['"],\s*projectId/)
assert.match(pane, /['"]decision['"],\s*['"]flow['"],\s*['"]add['"],\s*['"]--project['"],\s*projectId/)
assert.match(pane, /['"]decision['"],\s*['"]flow['"],\s*['"]update['"],\s*['"]--project['"],\s*projectId/)
assert.match(pane, /['"]decision['"],\s*['"]flow['"],\s*['"]set-steps['"],\s*['"]--project['"],\s*projectId/)

assert.match(pane, /runFlowCommand[\s\S]*?parseFlowResponse\(response\)/)
assert.match(pane, /catch[\s\S]*?setState\([\s\S]*?error/)
assert.match(pane, /onClick:[\s\S]*?runFlowCommand\(\[['"]decision['"],\s*['"]flow['"],\s*['"]add['"]/)
assert.match(pane, /onClick:[\s\S]*?runFlowCommand\(\[['"]decision['"],\s*['"]flow['"],\s*['"]update['"]/)
assert.match(pane, /onClick:[\s\S]*?runFlowCommand\(\[['"]decision['"],\s*['"]flow['"],\s*['"]set-steps['"]/)

assert.match(pane, /No flow steps yet|empty graph/i)
assert.match(pane, /Malformed graph|malformed graph/)
assert.match(pane, /deriveFlowLayout|next[\s\S]*?layout/)

// Mutations must refresh authoritative state only after a successful command;
// failed writes must leave the form/state intact and visible as an error.
assert.match(pane, /if \(await runFlowCommand\([\s\S]*?\)\) setNewName\(''\)/)
assert.doesNotMatch(pane, /setNewName\(''\)[\s\S]*?runFlowCommand/)

console.log('flowcharts UI mutation acceptance test passed')
