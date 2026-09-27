import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = await readFile(resolve('plugin.js'), 'utf8')

assert.match(source, /Flowcharts/)
assert.match(source, /decision-hud-flowcharts-route[\s\S]*?path:\s*['"]\/decision-hud\/flowcharts['"]/)
assert.match(source, /ENGINEERING_TABS[\s\S]*?label: 'Flowcharts'/)


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

// Refresh failures retain authoritative rows, selected identity, and drafts.
const refreshEffect = pane.match(/React\.useEffect\(\(\) => \{[\s\S]*?\}, \[projectId, revision\]\)/)?.[0]
assert.ok(refreshEffect, 'flow refresh effect must exist')
assert.doesNotMatch(refreshEffect, /setState\(\{\s*loading:\s*false,\s*flows:\s*\[\],/)
assert.match(refreshEffect, /\.catch\([\s\S]*?setState\(\s*\(current\)\s*=>\s*\(\{\s*\.\.\.current,\s*loading:\s*false,\s*error:/)
assert.match(pane, /\[selected\?\.id\]/)

// Every mutation is serialized, and cleanup runs on success and failure.
assert.match(pane, /mutationLoading|flowMutationLoading|flowBusy/)
assert.match(pane, /if \([^)]*(?:mutationLoading|flowMutationLoading|flowBusy)[^)]*\) return false/)
assert.match(pane, /finally\s*\{[\s\S]*?(?:mutationLoading|flowMutationLoading|flowBusy)[\s\S]*?false/)
assert.match(pane, /disabled:[^,}]*?(?:mutationLoading|flowMutationLoading|flowBusy)/)

// Structured backend errors render their message, not JavaScript object text.
const flowResponse = source.match(/function parseFlowResponse\(res\)[\s\S]*?(?=\nfunction |\nconst |\nexport )/)?.[0]
assert.ok(flowResponse, 'parseFlowResponse must exist')
assert.match(flowResponse, /payload\?\.error\?\.message|payload\?\.error\s*&&\s*typeof payload\?\.error === ['"]object['"]|error\.message/)
assert.doesNotMatch(flowResponse, /throw new Error\(payload\?\.error \|\| ['"]flow request failed['"]\)/)

console.log('flowcharts UI mutation acceptance test passed')
