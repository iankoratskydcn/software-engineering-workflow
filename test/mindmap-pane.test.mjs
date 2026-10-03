import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = await readFile(resolve('plugin.js'), 'utf8')

assert.match(source, /ENGINEERING_TABS[\s\S]*?label: 'MindMap'/)
assert.doesNotMatch(source, /id: ['"]decision-hud-map-nav['"]/)

// The legacy hierarchy map (a second tree over hierarchy_nodes) is gone; MindMap and Spec Digest
// are two views of the spec tree.
assert.doesNotMatch(source, /decision-hud-map-route|\/decision-hud\/map|HierarchyMapPane/)
assert.doesNotMatch(source, /'decision', 'node'/)
console.log('mindmap pane contract passed')
