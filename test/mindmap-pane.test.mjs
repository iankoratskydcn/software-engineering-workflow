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

// Wave 4: node-attached decisions must reuse the existing queue/card path.
assert.match(source, /function hierarchyDecisionMatchesNode\(decision, nodeId\)/)
assert.match(source, /_hierarchy_node_id/)
assert.match(source, /decision', 'list', '--limit', String\(DASHBOARD_MAX_ROWS\), '--project-id', projectId/)
assert.match(source, /onClick: \(\) => onSelect\(node\)/)
assert.match(source, /DecisionCard[\s\S]*?attachedDecisions/)
assert.match(source, /decision', 'push'[\s\S]*?--card-payload/)
assert.match(source, /_hierarchy_node_id: selectedNode.id/)
assert.match(source, /Attach decision/)

// Wave 5: Story/Task nodes can link and unlink real Kanban cards.
assert.match(source, /function HierarchyKanbanLink\(\{ node, boardSlug, onChanged \}\)/)
assert.match(source, /decision', 'node', 'link-kanban', node\.id, taskId/)
assert.match(source, /decision', 'node', 'update', node\.id, '--kanban-task', ''/)
assert.match(source, /kanban', '--board', boardSlug, 'show', taskId, '--json/)
assert.match(source, /Link to Kanban card|linked Kanban task/)
assert.match(source, /node\.kanban_task_id[\s\S]*?task\.title[\s\S]*?task\.status/)

console.log('mindmap pane contract RED test passed')
