import assert from 'node:assert/strict'
import { collectRegistrations as collectRendered, renderRegistration } from './render-harness.mjs'
import { mount, flush, installLocalStorageStub } from './dom-harness.mjs'
import { host } from '@hermes/plugin-sdk'

installLocalStorageStub()

const ROUTE_PATH = '/decision-hud/agent-dashboard'
const SELECTED_BOARD_STORAGE_KEY = 'decision-hud:selected-board'

// Wave 2a: the new canonical page stacks the dashboard read-model section
// above the Agent Matrix widgets section, sharing one board/project
// selector — same cliExec board/token stub shape as
// agent-metrics-fullpage.test.mjs, since AgentDashboardCombinedPage reuses
// useProjectDashboardScope().
function installKanbanScopeStub({ boardSlug, projectId, token, tokenError }) {
  if (boardSlug) localStorage.setItem(SELECTED_BOARD_STORAGE_KEY, boardSlug)
  const originalRequest = host.request
  host.request = async (method, params) => {
    if (method !== 'cli.exec') return originalRequest(method, params)
    const argv = params?.argv || []
    if (argv[0] === 'kanban' && argv[1] === 'boards' && argv[2] === 'list') {
      const boards = boardSlug ? [{ slug: boardSlug, project_id: projectId || null }] : []
      return { code: 0, output: JSON.stringify(boards) }
    }
    if (argv[0] === 'decision' && argv[1] === 'issue-token') {
      if (tokenError) return { code: 0, output: JSON.stringify({ ok: false, error: tokenError }) }
      return { code: 0, output: JSON.stringify({ ok: true, actor_token: token, project_id: projectId }) }
    }
    if (argv[0] === 'decision' && argv[1] === 'agent-metrics-snapshot') {
      return { code: 0, output: JSON.stringify({ ok: true, records: [{ assignee: 'a', outcome: 'done', volume: 3, avg_duration_s: 12 }], handoffs: [] }) }
    }
    return originalRequest(method, params)
  }
  return () => { host.request = originalRequest }
}

function collectWithRest(rest) {
  const registrations = []
  const ctx = {
    rest,
    host: { navigate() {}, revealPane() {} },
    register(registration) {
      registrations.push(registration)
      return () => {}
    },
    registerMany(items) {
      registrations.push(...items)
    },
  }
  return import('../plugin.js').then(({ default: plugin }) => {
    plugin.register(ctx)
    return registrations
  })
}

function findRoute(registrations, path) {
  return registrations.find((r) => r.area === 'routes' && r.data?.path === path)
}

function text(container) {
  return container.textContent.replace(/\s+/g, ' ').trim()
}

const validSnapshot = {
  schema_version: 'dashboard-read-model.v1',
  scope: { project_id: 'project-alpha', project_label: 'Project Alpha' },
  freshness: { state: 'fresh', as_of: '2026-09-12T20:00:00Z' },
  agents: [{ agent_id: 'agent-1', label: 'Builder', status: 'running' }],
  metrics: [
    { key: 'token_burn_rate', label: 'token_burn_rate', value: 12.5, unit: 'tokens/min', category: 'resource', source_window: 'telemetry', freshness: 'fresh' },
  ],
}

// Route registration: new canonical page exists alongside the existing ones.
const registrations = collectRendered()
assert.ok(findRoute(registrations, ROUTE_PATH), `expected a ${ROUTE_PATH} route registration`)
assert.ok(findRoute(registrations, '/decision-hud/agent-metrics'), 'legacy Agent Metrics route must still exist (retirement is Wave 2b)')
assert.ok(findRoute(registrations, '/decision-hud/agent-metrics/snapshot'), 'Agent Matrix route must still exist')

// The combined page exposes Dashboard and Retrospective only; the retired
// comparison surface must not reappear as a route or visible section.
{
  const comparisonRoutePath = '/decision-hud/agent-dashboard/comparison'
  assert.ok(!findRoute(registrations, comparisonRoutePath), 'retired comparison route must not be registered')
  const navEntries = registrations.filter((r) => r.area === 'sidebar.nav')
  assert.ok(!navEntries.some((r) => r.data?.path === comparisonRoutePath), 'retired comparison route must not be navigable')
}

async function mountPage(readModelResponse, scope = {}) {
  const uninstall = installKanbanScopeStub({
    boardSlug: 'default',
    projectId: 'project-alpha',
    token: 'actor-token-123',
    ...scope,
  })
  const regs = await collectWithRest(async (path, options) => {
    if (readModelResponse instanceof Error) throw readModelResponse
    return readModelResponse
  })
  const route = findRoute(regs, ROUTE_PATH)
  assert.ok(route, 'agent-dashboard route must be available to mount')
  const mounted = mount(route.render)
  await flush()
  return { ...mounted, unmount: async () => { await mounted.unmount(); uninstall() } }
}

// Both sections render on the same page, sharing one selector: the
// dashboard read-model section and the Agent Matrix widgets section both
// show live data from one mount, with no duplicate pane tree.
{
  const mounted = await mountPage(validSnapshot)
  const rendered = text(mounted.container)
  assert.match(rendered, /Dashboard/)
  assert.match(rendered, /Retrospective/)
  assert.match(rendered, /token_burn_rate/i)
  assert.match(rendered, /Heatmap/i)
  assert.equal(mounted.errors.length, 0)
  await mounted.unmount()
}

// One section's failure must not blank the other: read-model errors, Agent
// Matrix keeps working (both sections fetch independently).
{
  const mounted = await mountPage(new Error('telemetry unavailable'))
  const rendered = text(mounted.container)
  assert.match(rendered, /unavailable/i)
  assert.match(rendered, /Heatmap/i, 'Agent Matrix section must render even when the read-model section errors')
  assert.equal(mounted.errors.length, 0)
  await mounted.unmount()
}

console.log('agent-dashboard-combined-page acceptance tests reached')
