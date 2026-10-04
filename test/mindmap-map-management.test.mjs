// Adversarial RED source contract for named MindMap map management.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile('plugin.js', 'utf8')
const pane = source.slice(source.indexOf('function MindMapPane('), source.indexOf('function SpecDigest('))

assert.notEqual(pane, '', 'MindMapPane source must exist')

// Backend map lifecycle must be distinct from spec-node CRUD and project-scoped.
assert.match(pane, /['"]decision['"], ['"]mindmap['"], ['"]list['"], ['"]--project-id['"], projectId/)
assert.match(pane, /['"]decision['"], ['"]mindmap['"], ['"]create['"], [\s\S]*?--project-id[\s\S]*?--name[\s\S]*?--description/)
assert.match(pane, /['"]decision['"], ['"]mindmap['"], ['"]update['"], [\s\S]*?--project-id[\s\S]*?--map-id[\s\S]*?--name[\s\S]*?--description/)
assert.match(pane, /['"]decision['"], ['"]mindmap['"], ['"]delete['"], [\s\S]*?--project-id[\s\S]*?--map-id/)

// Destructive UI must obtain backend ownership/child metadata before confirmation.
assert.match(pane, /owned_node_count/)
assert.match(pane, /has_children|children_count/)
assert.match(pane, /window\.confirm\(/)
assert.match(pane, /['"]--confirm['"]|confirmDelete/)

// Selector is collapsible, with accessible state and a stable selected map.
assert.match(pane, /aria-label: ['"]MindMap selector['"]|aria-label: ['"]MindMap maps['"]|data-testid: ['"]mindmap-selector['"]/) 
assert.match(pane, /['"]aria-expanded['"]: [^,]+/) 
assert.match(pane, /Collapse mindmaps|Expand mindmaps|collapse.*mindmap|expand.*mindmap/i)
assert.match(pane, /selectedMapId|activeMapId|selectedMindMapId/)

// Existing maps expose edit and add affordances, not prompt-only node actions.
assert.match(pane, /aria-label: ['"]Edit mindmap['"]|title: ['"]Edit mindmap['"]|pencil/i)
assert.match(pane, /aria-label: ['"]Add mindmap['"]|title: ['"]Add mindmap['"]|\+ Add map|Add mindmap/)

console.log('MindMap map-management contract RED test passed')
