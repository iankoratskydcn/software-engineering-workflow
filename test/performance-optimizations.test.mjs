import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const source = await readFile(fileURLToPath(new URL('../plugin.js', import.meta.url)), 'utf8')

const boards = source.match(/function useKanbanBoards\(\) \{[\s\S]*?\n\}\n\nfunction useDecisionQueue/)?.[0] || ''
const pane = source.match(/function DecisionHudPane\(\{ rest \}\) \{[\s\S]*?\n\}\n\nconst PANE_ID/)?.[0] || ''

assert.doesNotMatch(source, /register\(ctx\) \{\s*startNewDecisionToastWatcher\(\)/)
assert.match(pane, /startNewDecisionToastWatcher\(\)/)
assert.doesNotMatch(boards, /setInterval\(/)
assert.doesNotMatch(pane, /metricsReady|availableMetrics|handleMetricsChange|safeSidebarSettings|sidebarSettings|loadSidebarSettings|saveSidebarSettings/)
for (const retired of ['AgentMetricsPage', 'AgentMetricsWidgetsPage', 'AgentDashboardCombinedPage', 'ComparisonPanel', 'MetricsSidebar', 'DeferredMetricsSidebar', 'agent-metrics-route', 'agent-metrics-widgets-route', 'agent-metrics-open', 'agent-matrix-open']) {
  assert.doesNotMatch(source, new RegExp(`\\b${retired}\\b`), `retired symbol remains: ${retired}`)
}
assert.match(source, /function stableSpecCriteriaKey\(item, index, items(?:, occurrences)?\) \{[\s\S]*?Map\(\)/)

console.log('performance optimization contracts passed')
