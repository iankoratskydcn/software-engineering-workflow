import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// MetricsSidebar now delegates its current sidebar content to AgentHealthList.
const sidebarFnBody = source.match(/function MetricsSidebar\([^)]*\)\s*\{[\s\S]*?\n\}\n/)
assert.ok(sidebarFnBody, 'MetricsSidebar function body must exist')
const sidebar = sidebarFnBody[0]

assert.match(
  sidebar,
  /function MetricsSidebar\(\{ agentHealth, side, widthPx, availableMetrics, projectId, rest \}\)/,
  'MetricsSidebar must accept the current health-list inputs',
)
assert.match(
  sidebar,
  /jsx\(AgentHealthList,\s*\{\s*health:\s*agentHealth,\s*availableMetrics,\s*projectId,\s*rest\s*\}\)/,
  'MetricsSidebar must render AgentHealthList with its current data dependencies',
)

const agentHealthListDef = source.match(/function AgentHealthList\([^)]*\)\s*\{[\s\S]*?\n\}\n/)
assert.ok(agentHealthListDef, 'AgentHealthList component must be defined')
assert.match(
  agentHealthListDef[0],
  /function AgentHealthList\(\{ health, availableMetrics, projectId, rest \}\)/,
  'AgentHealthList must consume the sidebar health-list contract',
)

console.log('dial-grid-select (MetricsSidebar AgentHealthList contract) structural test passed')
