import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = await readFile(resolve('plugin.js'), 'utf8')

assert.match(source, /id: ['"]decision-hud-map-route['"][\s\S]*?path: ['"]\/decision-hud\/map['"][\s\S]*?render: \(\) => jsx\(HierarchyMapPane/)
assert.match(source, /id: ['"]decision-hud-map-nav['"][\s\S]*?label: ['"]Map['"][\s\S]*?path: ['"]\/decision-hud\/map['"]/) 
assert.match(source, /host\.request\('cli\.exec', \{ argv: \['decision', 'node', 'tree', '--project', projectId\]/)
assert.match(source, /function parseHierarchyTreeResponse\(res\)[\s\S]*?parseTrailingJson\(res\.output\)/)
assert.match(source, /VALID_HIERARCHY_STATUS_COLORS[\s\S]*?grey[\s\S]*?blue[\s\S]*?red[\s\S]*?green/)
assert.match(source, /No map yet/)
assert.match(source, /done_count[\s\S]*?total_count/)

console.log('mindmap pane contract RED test passed')
