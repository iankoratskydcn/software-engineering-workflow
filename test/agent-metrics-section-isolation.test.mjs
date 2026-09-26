// Wave 2c: explicit unavailable-state UI per section, no fabricated data.
//
// Each Agent Metrics section (Postgres-backed dashboard read model /
// SQLite-backed Agent Matrix widgets) already isolates FETCH failures via
// its own useState/effect (see agent-metrics-fullpage.test.mjs and
// agent-metrics-widgets.test.mjs's error-state cases). This file covers the
// remaining gap: an uncaught RENDER exception inside a section's body (a
// snapshot that passes shape validation but still breaks a body component,
// e.g. a malformed record) must not blank the whole route — it must
// degrade to an explicit "<Section> unavailable" message via
// SectionErrorBoundary, the same isolation pattern CardErrorBoundary
// already uses for individual decision cards.
import assert from 'node:assert/strict'
import { collectRegistrations as collectRendered } from './render-harness.mjs'
import { mount, flush, installLocalStorageStub } from './dom-harness.mjs'
import { host } from '@hermes/plugin-sdk'

installLocalStorageStub()

const DASHBOARD_ROUTE_PATH = '/decision-hud/agent-dashboard'
const WIDGETS_ROUTE_PATH = '/decision-hud/agent-metrics/snapshot'
const SELECTED_BOARD_STORAGE_KEY = 'decision-hud:selected-board'

function installKanbanScopeStub({ boardSlug, projectId, token }) {
  localStorage.setItem(SELECTED_BOARD_STORAGE_KEY, boardSlug)
  const originalRequest = host.request
  host.request = async (method, params) => {
    if (method !== 'cli.exec') return originalRequest(method, params)
    const argv = params?.argv || []
    if (argv[0] === 'kanban' && argv[1] === 'boards' && argv[2] === 'list') {
      return { code: 0, output: JSON.stringify([{ slug: boardSlug, project_id: projectId }]) }
    }
    if (argv[0] === 'decision' && argv[1] === 'issue-token') {
      return { code: 0, output: JSON.stringify({ ok: true, actor_token: token, project_id: projectId }) }
    }
    return originalRequest(method, params)
  }
  return () => { host.request = originalRequest }
}

function findRoute(registrations, path) {
  return registrations.find((r) => r.area === 'routes' && r.data?.path === path)
}

function text(container) {
  return container.textContent.replace(/\s+/g, ' ').trim()
}

// A snapshot that passes validateDashboardSnapshot's shape check (array of
// metrics) but whose single metric throws when a body component reads a
// property off it — stands in for a malformed/adversarial backend row that
// slips past the schema_version + top-level-shape check.
function throwingMetric() {
  return new Proxy({}, { get() { throw new Error('malformed metric row') } })
}

{
  const uninstall = installKanbanScopeStub({ boardSlug: 'default', projectId: 'project-alpha', token: 't-1' })
  const response = {
    schema_version: 'dashboard-read-model.v1',
    scope: { project_id: 'project-alpha', project_label: 'Project Alpha' },
    freshness: { state: 'fresh', as_of: '2026-09-12T20:00:00Z' },
    agents: [],
    metrics: [throwingMetric()],
  }
  const ctx = {
    rest: async () => response,
    host: { navigate() {}, revealPane() {} },
    register: () => () => {},
    registerMany: () => {},
  }
  const { default: plugin } = await import('../plugin.js')
  const regs = []
  plugin.register({ ...ctx, register: (r) => { regs.push(r); return () => {} }, registerMany: (items) => regs.push(...items) })
  const dashboardRoute = findRoute(regs, DASHBOARD_ROUTE_PATH)
  assert.ok(dashboardRoute, `expected a ${DASHBOARD_ROUTE_PATH} route registration`)
  const mounted = mount(dashboardRoute.render)
  await flush()
  await flush()

  // Section degrades to its own explicit unavailable message...
  assert.match(text(mounted.container), /Agent Metrics unavailable/i)
  // ...instead of an unhandled exception escaping the boundary.
  assert.equal(mounted.errors.filter((e) => !String(e?.message || e).includes('malformed metric row')).length, 0)

  await mounted.unmount()
  uninstall()
}

// Same isolation for the Agent Matrix (SQLite-backed) widgets section: a
// malformed record (null entry) breaks the heatmap/scatter grouping helpers
// on first property access, degrading to an explicit unavailable message
// rather than blanking the page.
{
  const originalRequest = host.request
  host.request = async (method, params) => {
    if (method !== 'cli.exec') return originalRequest(method, params)
    const argv = params?.argv || []
    if (argv[0] === 'decision' && argv[1] === 'agent-metrics-snapshot') {
      return {
        code: 0,
        output: JSON.stringify({
          schema_version: 'agent-metrics-snapshot.v1',
          records: [null],
          handoffs: [],
        }),
      }
    }
    return originalRequest(method, params)
  }

  const registrations = collectRendered()
  const route = findRoute(registrations, WIDGETS_ROUTE_PATH)
  assert.ok(route, `expected a ${WIDGETS_ROUTE_PATH} route registration`)
  const mounted = mount(route.render)
  await flush()

  assert.match(text(mounted.container), /Agent Metrics Widgets unavailable/i)

  await mounted.unmount()
  host.request = originalRequest
}

console.log('agent-metrics-section-isolation acceptance tests reached')
