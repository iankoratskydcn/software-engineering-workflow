import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile('plugin.js', 'utf8')
assert.match(source, /function hierarchyDecisionMatchesNode\(decision, nodeId\)/)
assert.match(source, /_hierarchy_node_id/)
assert.match(source, /decision', 'list', '--limit', String\(MAX_DECISION_ROWS\), '--project-id', projectId/)
assert.match(source, /onClick: selectNode/)
assert.match(source, /onDoubleClick: \(\) => onInspect\(node\)/)
assert.match(source, /HierarchyAttachedDecision[\s\S]*?DecisionCard/)
assert.match(source, /decision', 'push'[\s\S]*?--card-payload/)
assert.match(source, /_hierarchy_node_id: selectedNode.id/)
assert.match(source, /Attach decision/)
console.log('mindmap decision attachment contract passed')
