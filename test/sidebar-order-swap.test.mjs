import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// MetricsSidebar now intentionally owns the AgentHealthList card stack.
const sidebarFnBody = source.match(/function MetricsSidebar\([^)]*\)\s*\{[\s\S]*?\n\}\n/)
assert.ok(sidebarFnBody, 'MetricsSidebar function body must exist')
const body = sidebarFnBody[0]

assert.match(body, /jsx\(AgentHealthList,\s*\{\s*health:\s*agentHealth,/)
assert.match(body, /availableMetrics,\s*projectId,\s*rest/)

console.log('sidebar-order-swap (MetricsSidebar AgentHealthList contract) structural test passed')
