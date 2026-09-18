/**
 * Decision HUD desktop plugin — card-stack pane for the cross-project
 * decision queue (backend: ~/.hermes/plugins/decision-hud/).
 *
 * Data path: this pane never touches the SQLite file directly (desktop
 * plugins have no filesystem access). It drives the backend plugin's
 * `hermes decision ...` CLI commands through the generic `cli.exec` RPC
 * (host.request('cli.exec', { argv: [...] })), which is the standard
 * non-interactive command-exec surface already built into the gateway —
 * no core changes, no new RPC method needed.
 *
 * Layout: card stack in the center (3-5 pending decisions, oldest/highest
 * urgency first), a project switcher across the top, docked to the RIGHT
 * of the main chat pane so it sits beside a live conversation. The left
 * "switchable visualization" panel is a v1 placeholder (per the build
 * decision) — wired for a future per-project stats view.
 *
 * Rich cards (decision-hud-cards skill): a decision row can carry an
 * optional `card_type` + `card_payload` (see ~/.hermes/plugins/decision-hud/
 * db.py v2 schema) hinting which visual widget below to render instead of
 * the plain button list. `question`/`choices` always remain a complete,
 * legible fallback — DecisionCard dispatches on card_type but falls back to
 * the plain list for null/unrecognized types, so this never hard-fails on
 * older or hand-pushed decisions with no card_type set.
 */

import { Badge, Button, cn, Codicon, haptic, host, PALETTE_AREA, ROUTES_AREA, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Separator, Switch, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import * as React from 'react'

const PLUGIN_ID = 'decision-hud'
const POLL_MS = 4000

// --- Agent Dashboard (additive interface) ----------------------------------
// Inlined directly in this file — NOT split into dashboard/AgentDashboard.js —
// because the desktop app's runtime plugin loader evaluates plugin.js as a
// single blob URL (apps/desktop/src/contrib/runtime-loader.ts). Blob URLs
// have no hierarchical base, so a relative import like
// `./dashboard/AgentDashboard.js` can never resolve there even though it
// resolves fine under Node's real filesystem ESM (which is why the test
// suite passed while the live desktop app failed with "Failed to resolve
// module specifier"). The loader only rewrites the bare specifiers
// @hermes/plugin-sdk, react, react/jsx-runtime, react/jsx-dev-runtime to blob
// shims (apps/desktop/src/sdk/runtime.ts's sdkImportMap) — notably NOT
// react-dom, so flushSync is unavailable here too (a second, same-class bug
// caught before shipping: the loader's unsupportedImports() check rejects
// any other bare specifier up front with a clear error, rather than the
// cryptic "Failed to resolve module specifier" a raw failed blob import
// would throw). Plain setState replaces the flushSync calls below; this
// pane's own tests only assert on committed render output, not on
// microtask/macrotask update timing, so the loss of forced synchronous
// flushing has no observable effect here.

const DASHBOARD_MAX_ROWS = 1000
// Reserved resolved_choice value for the Dismiss action: reuses resolve_decision()
// (actor-token gated, same as a real answer) instead of a new delete endpoint —
// the row and its history stay in decisions.db, just permanently off list_pending().
const DISMISS_SENTINEL_CHOICE = '__dismissed__'
// `ctx.rest(path)` is already scoped under `/api/plugins/<plugin-id>/...` by
// the desktop host (plugin-id == 'decision-hud'), so a path that repeats the
// plugin id here doubles the segment: `/decision-hud/agent-dashboard` became
// `/api/plugins/decision-hud/decision-hud/agent-dashboard` -> 404 "No such
// API endpoint". The backend HTTP service's own route
// (backend/agent_dashboard/service/http_app.py, _ROUTE_PATH) is a separate,
// unscoped loopback path and is unaffected by this — only the gateway-facing
// path passed to `rest()` needs the plugin-id segment dropped.
const DASHBOARD_READ_MODEL_PATH = '/agent-dashboard'

// Real wiring (owner decision, 2026-09-14, supersedes the placeholder this
// comment used to describe): project scope for the dashboard IS the
// currently-selected Kanban board. DecisionHudPane's own board selector
// (BoardSelector / selectedBoard) and this pane are SEPARATE registered
// panes/routes with no shared React tree, so the selection is persisted to
// `SELECTED_BOARD_STORAGE_KEY` in localStorage by DecisionHudPane and read
// here — same cross-pane-persistence shape as SIDEBAR_SETTINGS_STORAGE_KEY
// below, just keyed differently. `useKanbanBoards()` + `board.project_id`
// resolve the slug to a project id exactly like DecisionHudPane's own
// selectedBoardProjectId cross-link (search that name for the fuller
// history of the board<->project_id link). The actor token is minted per
// project via `hermes decision issue-token --actor desktop-pane
// --project-id <id>` (decision-hud plugin cli.py, `_cmd_issue_token` +
// `_agent_dashboard_auth_module()`), which calls the agent-dashboard
// backend's `issue_project_actor_token()` — same token format/verification
// as the unscoped token used elsewhere in this file (getActorToken), just
// with an added project claim, minted fresh per project (not reused across
// projects, since a token proves exactly one project claim; see
// useProjectActorToken below). No board selected -> no project_id -> the
// pane shows an explicit "select a board in Decision HUD" state rather than
// issuing an unscoped/failing request.
const SELECTED_BOARD_STORAGE_KEY = 'decision-hud:selected-board'

function loadSelectedBoardSlug() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SELECTED_BOARD_STORAGE_KEY) : null
    return typeof raw === 'string' && raw ? raw : null
  } catch {
    return null
  }
}

function saveSelectedBoardSlug(slug) {
  try {
    if (typeof localStorage === 'undefined') return
    if (slug) localStorage.setItem(SELECTED_BOARD_STORAGE_KEY, slug)
    else localStorage.removeItem(SELECTED_BOARD_STORAGE_KEY)
  } catch {
    // best-effort persistence only — a write failure just means the
    // board selection doesn't survive a reload/other-pane read, not a
    // functional error in the pane that made the selection.
  }
}

// Shared by DecisionHudPane's own auto-select effect AND
// useProjectDashboardScope below: when nothing is persisted yet, prefer
// the board literally named/slugged "default" (matches the common
// single-board setup, e.g. the "Default" option seen in the board
// dropdown) over just grabbing boards[0] — a board list is not guaranteed
// to return "default" first, and picking an arbitrary board would scope
// the Agent Dashboard to the wrong project on a multi-board setup. Falls
// back to the first board when there is no "default"-slugged one.
function pickDefaultBoardSlug(boards) {
  if (!Array.isArray(boards) || boards.length === 0) return null
  const named = boards.find((b) => b && String(b.slug).toLowerCase() === 'default')
  return (named || boards[0]).slug || null
}

// Shared by AgentDashboard and AgentMetricsPage: resolve the persisted
// selected-board slug to { projectId, boardsLoading, boardsError } via the
// same useKanbanBoards() used by DecisionHudPane, then mint (and cache, per
// projectId) a project-scoped actor token. Re-resolves on every mount since
// these are routed/docked panes that can be reopened long after the token's
// TTL — unlike getActorToken()'s single long-lived module-level promise,
// this is deliberately NOT cached across projectId changes (see comment
// block above this constant).
function useProjectDashboardScope() {
  const [boardSlug, setBoardSlug] = React.useState(loadSelectedBoardSlug)
  const { boards, loading: boardsLoading, error: boardsError } = useKanbanBoards()
  const [tokenState, setTokenState] = React.useState({ token: null, loading: false, error: null })

  // Pick up a board selection made in the DecisionHudPane tab after this
  // pane already mounted (e.g. user switches board, then opens Agent
  // Metrics) — storage events fire in OTHER same-origin tabs/frames, which
  // is exactly the desktop app's docked-pane-vs-routed-page relationship.
  React.useEffect(() => {
    function onStorage(e) {
      if (e.key === SELECTED_BOARD_STORAGE_KEY) setBoardSlug(e.newValue || null)
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('storage', onStorage)
      return () => window.removeEventListener('storage', onStorage)
    }
    return undefined
  }, [])

  // Owner request: Agent Dashboard/Metrics must work without ever visiting
  // Decision HUD first — before this fix, no persisted selection meant an
  // indefinite "Select a board in Decision HUD to scope the Agent
  // Dashboard" dead end even when boards existed and one of them is
  // "default". Auto-resolve and PERSIST the default board slug the same
  // way DecisionHudPane's own auto-select effect does, so both panes
  // converge on the same board and the choice is not silently re-guessed
  // on every mount (a subsequent Decision HUD board switch still wins via
  // the storage listener above).
  React.useEffect(() => {
    if (boardSlug || boardsLoading || boards.length === 0) return
    const fallback = pickDefaultBoardSlug(boards)
    if (fallback) {
      setBoardSlug(fallback)
      saveSelectedBoardSlug(fallback)
    }
  }, [boardSlug, boardsLoading, boards])

  const projectId = React.useMemo(() => {
    if (!boardSlug) return null
    const board = boards.find((b) => b && b.slug === boardSlug)
    return board ? board.project_id || null : null
  }, [boards, boardSlug])

  React.useEffect(() => {
    let active = true
    if (!projectId) {
      setTokenState({ token: null, loading: false, error: null })
      return () => { active = false }
    }
    setTokenState({ token: null, loading: true, error: null })
    cliExec(['decision', 'issue-token', '--actor', 'desktop-pane', '--project-id', projectId])
      .then((res) => {
        if (!active) return
        if (!res || !res.ok || !res.actor_token) {
          setTokenState({ token: null, loading: false, error: (res && res.error) || 'failed to obtain project actor token' })
          return
        }
        setTokenState({ token: res.actor_token, loading: false, error: null })
      })
      .catch((e) => {
        if (active) setTokenState({ token: null, loading: false, error: String(e.message || e) })
      })
    return () => { active = false }
  }, [projectId])

  return {
    boardSlug,
    projectId,
    token: tokenState.token,
    loading: boardsLoading || tokenState.loading,
    error: boardsError || tokenState.error,
  }
}

function isDashboardRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function dashboardFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateDashboardSnapshot(value) {
  if (!isDashboardRecord(value) || value.schema_version !== 'dashboard-read-model.v1') {
    throw new Error('read model is unavailable')
  }
  if (!isDashboardRecord(value.scope) || !value.scope.project_id || !value.scope.project_label) {
    throw new Error('selected project scope is unavailable')
  }
  if (!isDashboardRecord(value.freshness) || !['fresh', 'stale', 'missing'].includes(value.freshness.state)) {
    throw new Error('freshness state is unavailable')
  }
  if (!Array.isArray(value.agents) || !Array.isArray(value.metrics)) {
    throw new Error('dashboard rows are unavailable')
  }
  return value
}

function boundedDashboardRows(rows) {
  return { rows: rows.slice(0, DASHBOARD_MAX_ROWS), omitted: Math.max(0, rows.length - DASHBOARD_MAX_ROWS) }
}

function displayDashboardMetric(metric) {
  if (!isDashboardRecord(metric)) return { label: 'Metric', value: 'Unavailable' }
  if (metric.state === 'unavailable' || !dashboardFiniteNumber(metric.value) && typeof metric.value !== 'string') {
    return { label: metric.label || metric.key || 'Metric', value: metric.reason || 'Unavailable' }
  }
  return {
    label: metric.label || metric.key || 'Metric',
    value: `${String(metric.value)}${metric.unit ? ` ${String(metric.unit)}` : ''}`,
    window: metric.source_window,
  }
}

function dashboardStatusText(snapshot) {
  if (snapshot.freshness.state === 'missing') return 'No data'
  return snapshot.freshness.state === 'stale' ? 'Stale' : 'Live'
}

function DashboardLoadingState() {
  return jsx('div', { role: 'status', children: 'Loading Agent Dashboard…' })
}

function DashboardMessageState({ children }) {
  return jsx('div', { role: 'status', children })
}

// --- Agent Metrics (full-page route) ------------------------------------
// Ported from the standalone agent-metrics scaffold plugin
// (~/.hermes/desktop-plugins/agent-metrics/plugin.js) into this plugin per
// owner decision: it renders the SAME read-only dashboard read model
// (DASHBOARD_READ_MODEL_PATH) as the docked AgentDashboard pane above, at
// full page size, grouped by category — not a second data source, and not
// backed by mock data. `metrics.category` is optional on the wire (older/
// synthetic telemetry may omit it); those metrics land in an explicit
// 'uncategorized' bucket rather than being dropped or guessed into one.
const AGENT_METRICS_ROUTE_PATH = '/decision-hud/agent-metrics'
const UNCATEGORIZED_KEY = 'uncategorized'

// Category -> display-label lookup for the full-page Agent Metrics view.
// This is a forward-looking, non-exhaustive lookup table — it is NOT a
// mirror of any backend schema or Python type. As of this writing, the
// only category value this repo's backend/agent_dashboard code and tests
// actually emit is the literal string 'resource' (see
// backend/tests/test_agent_dashboard_repair.py and
// backend/tests/test_read_only_vertical_slice.py). The remaining entries
// below are placeholders for categories that may be introduced once the
// backend emits richer telemetry; they carry no verified contract today.
// Any category key NOT present here (including future/unknown ones)
// safely falls back to its raw key text via agentMetricsCategoryLabel
// below — the fallback, not this map, is what must stay correct.
const AGENT_METRICS_CATEGORY_LABELS = {
  resource_cost: 'Resource / Cost',
  quality_correctness: 'Quality / Correctness',
  task_outcome_quality: 'Task-Outcome Quality',
  throughput_progress: 'Throughput / Progress',
  coordination_workflow: 'Coordination / Workflow',
  human_trust: 'Human Trust (Decision HUD)',
  latency_responsiveness: 'Latency / Responsiveness',
  tool_reliability: 'Tool-Use Reliability',
  security_permissions: 'Security / Permissions',
  knowledge_freshness: 'Knowledge / Context Freshness',
  resource: 'Resource',
  [UNCATEGORIZED_KEY]: 'Uncategorized',
}

function agentMetricsCategoryLabel(key) {
  return AGENT_METRICS_CATEGORY_LABELS[key] || key
}

// Category cards must render in a stable, deterministic order regardless of
// backend metric-arrival order (Map insertion order is not a contract):
// known categories follow their fixed position in
// AGENT_METRICS_CATEGORY_LABELS; unknown categories sort alphabetically
// after all known ones; UNCATEGORIZED_KEY (the catch-all/degenerate bucket)
// always renders last, even though it appears earlier in the labels map.
const AGENT_METRICS_CATEGORY_ORDER_INDEX = new Map(
  Object.keys(AGENT_METRICS_CATEGORY_LABELS)
    .filter((key) => key !== UNCATEGORIZED_KEY)
    .map((key, index) => [key, index])
)

function sortAgentMetricsCategoryKeys(keys) {
  return [...keys].sort((a, b) => {
    if (a === UNCATEGORIZED_KEY) return b === UNCATEGORIZED_KEY ? 0 : 1
    if (b === UNCATEGORIZED_KEY) return -1
    const indexA = AGENT_METRICS_CATEGORY_ORDER_INDEX.has(a) ? AGENT_METRICS_CATEGORY_ORDER_INDEX.get(a) : Infinity
    const indexB = AGENT_METRICS_CATEGORY_ORDER_INDEX.has(b) ? AGENT_METRICS_CATEGORY_ORDER_INDEX.get(b) : Infinity
    if (indexA !== indexB) return indexA - indexB
    return a < b ? -1 : a > b ? 1 : 0
  })
}

function groupMetricsByCategory(metrics) {
  const bounded = boundedDashboardRows(metrics)
  const byCategory = new Map()
  for (const metric of bounded.rows) {
    const key = isDashboardRecord(metric) && typeof metric.category === 'string' && metric.category
      ? metric.category
      : UNCATEGORIZED_KEY
    if (!byCategory.has(key)) byCategory.set(key, [])
    byCategory.get(key).push(metric)
  }
  return { byCategory, omitted: bounded.omitted }
}

function AgentMetricsCategoryCard({ categoryKey, metrics }) {
  return jsxs('div', {
    'data-metrics-category': categoryKey,
    style: {
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '8px',
      padding: '12px 14px',
      minWidth: '260px',
      flex: '1 1 260px',
    },
    children: [
      jsx('div', {
        style: { fontWeight: 600, marginBottom: '8px', color: 'var(--ui-text-secondary)' },
        children: agentMetricsCategoryLabel(categoryKey),
      }),
      jsx('div', {
        role: 'list',
        children: metrics.map((metric, index) => {
          const item = displayDashboardMetric(metric)
          return jsxs('div', {
            'data-metric-row': 'true',
            role: 'listitem',
            style: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '12px' },
            children: [
              jsx('span', { children: item.label }),
              jsx('span', { className: 'ml-2', children: item.value }),
            ],
          }, isDashboardRecord(metric) ? (metric.key || index) : index)
        }),
      }),
    ],
  })
}

function AgentMetricsPageBody({ snapshot }) {
  const { byCategory, omitted } = groupMetricsByCategory(snapshot.metrics)
  const categoryKeys = sortAgentMetricsCategoryKeys(byCategory.keys())
  if (categoryKeys.length === 0) {
    return jsx(DashboardMessageState, { children: 'No metrics available' })
  }
  return jsxs('div', {
    children: [
      jsxs('div', { children: [jsx('span', { className: 'font-medium', children: 'Scope: ' }), jsx('span', { children: snapshot.scope.project_label })] }),
      jsx('div', { className: 'text-(--ui-text-tertiary)', children: dashboardStatusText(snapshot) }),
      omitted > 0 ? jsx('div', { className: 'text-(--ui-text-tertiary)', children: `${omitted} metrics omitted (showing ${DASHBOARD_MAX_ROWS})` }) : null,
      jsx('div', {
        style: { display: 'flex', flexWrap: 'wrap', gap: '12px', marginTop: '12px' },
        children: categoryKeys.map((key) => jsx(AgentMetricsCategoryCard, { categoryKey: key, metrics: byCategory.get(key) }, key)),
      }),
    ],
  })
}

function AgentMetricsPage({ rest }) {
  const [state, setState] = React.useState({ loading: true, snapshot: null, error: null })
  const scope = useProjectDashboardScope()
  React.useLayoutEffect(() => {
    let active = true
    if (scope.loading) {
      setState({ loading: true, snapshot: null, error: null })
      return () => { active = false }
    }
    if (!scope.projectId) {
      setState({ loading: false, snapshot: null, error: scope.error || 'Select a board in Decision HUD to scope Agent Metrics' })
      return () => { active = false }
    }
    if (!scope.token) {
      setState({ loading: false, snapshot: null, error: scope.error || 'Unable to obtain a project-scoped actor token' })
      return () => { active = false }
    }
    const query = { limit: DASHBOARD_MAX_ROWS, project_id: scope.projectId }
    const headers = { Authorization: `Bearer ${scope.token}` }
    rest(DASHBOARD_READ_MODEL_PATH, { method: 'GET', query, headers }).then((response) => {
      const snapshot = validateDashboardSnapshot(response)
      if (active) setState({ loading: false, snapshot, error: null })
    }).catch((error) => {
      if (active) setState({ loading: false, snapshot: null, error: String(error?.message || error) })
    })
    return () => { active = false }
  }, [rest, scope.loading, scope.projectId, scope.token, scope.error])

  return jsxs('section', {
    'aria-label': 'Agent Metrics',
    className: 'flex h-full flex-col gap-3 overflow-auto p-4 text-sm',
    children: [
      jsx('div', { className: 'font-medium', children: 'Agent Metrics' }),
      state.loading ? jsx(DashboardLoadingState, {}) : state.error ? jsx(DashboardMessageState, { children: `Dashboard unavailable: ${state.error}` }) : jsx(AgentMetricsPageBody, { snapshot: state.snapshot }),
    ],
  })
}
// --- End Agent Metrics ---------------------------------------------------

// F2 authorization: the desktop pane is the interactive-only resolution
// surface, so it mints ONE actor token per pane session (lazily, on first
// resolve) via `hermes decision issue-token` and holds the raw value only
// in this module's memory for the life of the pane — never written to
// disk by the pane itself (db.py's issue_actor_token() persists only the
// token's SHA-256 hash, in a 0600 file only the same OS user can read).
// Every `decision resolve` cliExec call must carry --actor-token; there is
// no fallback path that resolves without one.
let _actorTokenPromise = null

async function getActorToken() {
  if (!_actorTokenPromise) {
    _actorTokenPromise = cliExec(['decision', 'issue-token', '--actor', 'desktop-pane']).then((res) => {
      if (!res || !res.ok || !res.actor_token) {
        _actorTokenPromise = null // allow retry on next resolve attempt
        throw new Error((res && res.error) || 'failed to obtain actor token')
      }
      return res.actor_token
    }).catch((e) => {
      _actorTokenPromise = null
      throw e
    })
  }
  return _actorTokenPromise
}

async function cliExec(argv) {
  const res = await host.request('cli.exec', { argv, timeout: 30 })
  if (!res || res.blocked) {
    throw new Error((res && res.hint) || 'cli.exec blocked')
  }
  if (res.code !== 0) {
    throw new Error(`decision CLI exited ${res.code}: ${res.output || ''}`)
  }
  return parseTrailingJson(res.output || '')
}

// stdout can carry noise ahead of the JSON (e.g. a Python
// RequestsDependencyWarning from an unrelated import printed to stdout), and
// separately the gateway's cli.exec joins the child's stdout AND stderr as
// `stdout + "\n" + stderr` (tui_gateway/methods_tools.py:_joined_output) —
// Python's warnings.warn() writes to STDERR, so that same warning can land
// AFTER the JSON instead of before it. A "scan backward from the last line"
// approach can never recover from trailing noise (every suffix slice still
// ends in garbage), so instead find the first complete top-level JSON value
// by bracket-matching from the start and ignore anything that follows it —
// robust to noise on either side.
function parseTrailingJson(output) {
  const trimmed = output.trim()
  if (trimmed) {
    try {
      return JSON.parse(trimmed)
    } catch (e) {
      // fall through to bracket-matched extraction below
    }
  }
  for (let i = 0; i < output.length; i++) {
    const ch = output[i]
    if (ch !== '{' && ch !== '[') continue
    const close = ch === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escape = false
    for (let j = i; j < output.length; j++) {
      const c = output[j]
      if (inString) {
        if (escape) {
          escape = false
        } else if (c === '\\') {
          escape = true
        } else if (c === '"') {
          inString = false
        }
        continue
      }
      if (c === '"') {
        inString = true
      } else if (c === ch) {
        depth++
      } else if (c === close) {
        depth--
        if (depth === 0) {
          const candidate = output.slice(i, j + 1)
          try {
            return JSON.parse(candidate)
          } catch (e) {
            break // this bracket run wasn't valid JSON; keep scanning for the next '{'/'['
          }
        }
      }
    }
  }
  throw new Error(`decision CLI returned no JSON value: ${output}`)
}

// --- Agent Metrics Widgets (heatmap/scatter/parallel-coords/treemap/radar/
// sankey), backed by backend/scripts/agent_metrics_snapshot.py -----------
// A genuinely separate surface from AgentMetricsPage above: different data
// source (Kanban SQLite via a CLI subprocess, not the Postgres-backed
// DASHBOARD_READ_MODEL_PATH read model), different route. Never touches
// AgentMetricsPage/DASHBOARD_READ_MODEL_PATH. Hand-rolled inline SVG only —
// this repo has zero runtime deps and the widgets are simple enough that a
// charting library would be pure overhead (ponytail rung 4: stdlib/native
// covers it — plain SVG is a native platform feature).
const AGENT_METRICS_WIDGETS_ROUTE_PATH = '/decision-hud/agent-metrics/snapshot'

function AgentMetricsWidgetsSection({ title, dataKey, children }) {
  return jsxs('div', {
    'data-widget': dataKey,
    style: { border: '1px solid var(--ui-stroke-secondary)', borderRadius: '8px', padding: '12px 14px', marginBottom: '12px' },
    children: [
      jsx('div', { style: { fontWeight: 600, marginBottom: '8px', color: 'var(--ui-text-secondary)' }, children: title }),
      children,
    ],
  })
}

function agentMetricsOutcomes(records) {
  return [...new Set(records.map((r) => r.outcome))].sort()
}

function agentMetricsAssignees(records) {
  return [...new Set(records.map((r) => r.assignee))].sort()
}

// Heatmap: assignee x outcome grid, cell intensity = volume. Plain DOM grid
// (no SVG needed for a grid of colored cells).
function AgentMetricsHeatmap({ records }) {
  if (records.length === 0) return jsx(DashboardMessageState, { children: 'No agent metrics available' })
  const assignees = agentMetricsAssignees(records)
  const outcomes = agentMetricsOutcomes(records)
  const maxVolume = Math.max(...records.map((r) => r.volume))
  const byKey = new Map(records.map((r) => [`${r.assignee}\u0000${r.outcome}`, r]))
  return jsx('div', {
    style: { display: 'grid', gridTemplateColumns: `120px repeat(${outcomes.length}, 1fr)`, gap: '2px', fontSize: '11px' },
    children: [
      jsx('div', {}, 'corner'),
      ...outcomes.map((o) => jsx('div', { style: { fontWeight: 600, textAlign: 'center' }, children: o }, `h-${o}`)),
      ...assignees.flatMap((a) => [
        jsx('div', { style: { fontWeight: 600 }, children: a }, `row-${a}`),
        ...outcomes.map((o) => {
          const rec = byKey.get(`${a}\u0000${o}`)
          const intensity = rec ? rec.volume / maxVolume : 0
          return jsx('div', {
            'data-heatmap-cell': 'true',
            title: rec ? `${a} / ${o}: volume ${rec.volume}` : `${a} / ${o}: no data`,
            style: {
              minHeight: '24px',
              background: rec ? `rgba(80,140,255,${0.15 + intensity * 0.75})` : 'transparent',
              border: '1px solid var(--ui-stroke-secondary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            },
            children: rec ? String(rec.volume) : '',
          }, `cell-${a}-${o}`)
        }),
      ]),
    ],
  })
}

// Scatter: avg_duration_s (x) vs volume (y), one point per (assignee, outcome).
function AgentMetricsScatter({ records }) {
  if (records.length === 0) return jsx(DashboardMessageState, { children: 'No agent metrics available' })
  const W = 320, H = 220, PAD = 30
  const maxDuration = Math.max(1, ...records.map((r) => r.avg_duration_s))
  const maxVolume = Math.max(1, ...records.map((r) => r.volume))
  const points = records.map((r) => ({
    x: PAD + (r.avg_duration_s / maxDuration) * (W - 2 * PAD),
    y: H - PAD - (r.volume / maxVolume) * (H - 2 * PAD),
    label: `${r.assignee} / ${r.outcome}: ${r.avg_duration_s.toFixed(0)}s, vol ${r.volume}`,
  }))
  return jsxs('svg', {
    width: W, height: H, role: 'img', 'aria-label': 'avg duration vs volume scatter plot',
    children: [
      jsx('line', { x1: PAD, y1: H - PAD, x2: W - PAD, y2: H - PAD, stroke: 'var(--ui-stroke-secondary)' }),
      jsx('line', { x1: PAD, y1: PAD, x2: PAD, y2: H - PAD, stroke: 'var(--ui-stroke-secondary)' }),
      ...points.map((p, i) => jsxs('g', { children: [jsx('circle', { cx: p.x, cy: p.y, r: 4, fill: '#508cff' }), jsx('title', { children: p.label })] }, `pt-${i}`)),
    ],
  })
}

// Parallel coordinates: assignee -> outcome -> volume -> avg_duration_s axes.
function AgentMetricsParallelCoordinates({ records }) {
  if (records.length === 0) return jsx(DashboardMessageState, { children: 'No agent metrics available' })
  const W = 360, H = 200, PAD = 20
  const assignees = agentMetricsAssignees(records)
  const outcomes = agentMetricsOutcomes(records)
  const maxVolume = Math.max(1, ...records.map((r) => r.volume))
  const maxDuration = Math.max(1, ...records.map((r) => r.avg_duration_s))
  const axes = ['assignee', 'outcome', 'volume', 'avg_duration_s']
  const axisX = (i) => PAD + (i / (axes.length - 1)) * (W - 2 * PAD)
  const yFor = (axis, r) => {
    if (axis === 'assignee') return PAD + (assignees.indexOf(r.assignee) / Math.max(1, assignees.length - 1)) * (H - 2 * PAD)
    if (axis === 'outcome') return PAD + (outcomes.indexOf(r.outcome) / Math.max(1, outcomes.length - 1)) * (H - 2 * PAD)
    if (axis === 'volume') return H - PAD - (r.volume / maxVolume) * (H - 2 * PAD)
    return H - PAD - (r.avg_duration_s / maxDuration) * (H - 2 * PAD)
  }
  return jsxs('svg', {
    width: W, height: H, role: 'img', 'aria-label': 'parallel coordinates: assignee, outcome, volume, avg duration',
    children: [
      ...axes.map((axis, i) => jsx('line', { x1: axisX(i), y1: PAD, x2: axisX(i), y2: H - PAD, stroke: 'var(--ui-stroke-secondary)' }, `axis-${axis}`)),
      ...records.map((r, i) => jsx('polyline', {
        points: axes.map((axis, ai) => `${axisX(ai)},${yFor(axis, r)}`).join(' '),
        fill: 'none', stroke: '#508cff', strokeOpacity: 0.5,
      }, `line-${i}`)),
    ],
  })
}

// Treemap: nested by assignee, sized by volume. Simple single-level
// slice-and-dice layout (rows sized proportional to each assignee's total
// volume) — no nested-rectangle algorithm needed for one grouping level.
function AgentMetricsTreemap({ records }) {
  if (records.length === 0) return jsx(DashboardMessageState, { children: 'No agent metrics available' })
  const W = 320, H = 220
  const totals = new Map()
  for (const r of records) totals.set(r.assignee, (totals.get(r.assignee) || 0) + r.volume)
  const grandTotal = [...totals.values()].reduce((a, b) => a + b, 0) || 1
  let y = 0
  const rects = [...totals.entries()].map(([assignee, volume], i) => {
    const h = (volume / grandTotal) * H
    const rect = { x: 0, y, w: W, h, assignee, volume }
    y += h
    return rect
  })
  const palette = ['#508cff', '#5fd0a0', '#f0a860', '#e06880', '#a878e0', '#60c8d8']
  return jsxs('svg', {
    width: W, height: H, role: 'img', 'aria-label': 'volume by assignee treemap',
    children: rects.map((r, i) => jsxs('g', {
      children: [
        jsx('rect', { x: r.x, y: r.y, width: r.w, height: Math.max(0, r.h - 1), fill: palette[i % palette.length], fillOpacity: 0.75 }),
        jsx('title', { children: `${r.assignee}: volume ${r.volume}` }),
        r.h > 14 ? jsx('text', { x: r.x + 4, y: r.y + 14, fontSize: 11, fill: '#fff', children: `${r.assignee} (${r.volume})` }) : null,
      ],
    }, `rect-${r.assignee}`)),
  })
}

// Radar: per-assignee profile across outcome categories (volume per outcome,
// normalized to that outcome's max across assignees).
function AgentMetricsRadar({ records }) {
  if (records.length === 0) return jsx(DashboardMessageState, { children: 'No agent metrics available' })
  const W = 260, H = 260, CX = W / 2, CY = H / 2, R = 100
  const outcomes = agentMetricsOutcomes(records)
  const assignees = agentMetricsAssignees(records)
  if (outcomes.length < 3) {
    // A radar chart needs >=3 axes to be meaningful; fall back to an
    // explicit note rather than drawing a degenerate 1-2-axis shape.
    return jsx(DashboardMessageState, { children: `Not enough outcome categories for a radar chart (need >=3, have ${outcomes.length})` })
  }
  const maxByOutcome = new Map(outcomes.map((o) => [o, Math.max(1, ...records.filter((r) => r.outcome === o).map((r) => r.volume))]))
  const angleFor = (i) => (i / outcomes.length) * 2 * Math.PI - Math.PI / 2
  const palette = ['#508cff', '#5fd0a0', '#f0a860', '#e06880', '#a878e0', '#60c8d8']
  const axisLines = outcomes.map((o, i) => {
    const a = angleFor(i)
    return jsx('line', { x1: CX, y1: CY, x2: CX + R * Math.cos(a), y2: CY + R * Math.sin(a), stroke: 'var(--ui-stroke-secondary)' }, `axis-${o}`)
  })
  const polygons = assignees.map((assignee, ai) => {
    const pts = outcomes.map((o, i) => {
      const rec = records.find((r) => r.assignee === assignee && r.outcome === o)
      const ratio = rec ? rec.volume / maxByOutcome.get(o) : 0
      const a = angleFor(i)
      return `${CX + R * ratio * Math.cos(a)},${CY + R * ratio * Math.sin(a)}`
    }).join(' ')
    return jsxs('g', {
      children: [jsx('polygon', { points: pts, fill: palette[ai % palette.length], fillOpacity: 0.2, stroke: palette[ai % palette.length] }), jsx('title', { children: assignee })],
    }, `poly-${assignee}`)
  })
  return jsxs('svg', { width: W, height: H, role: 'img', 'aria-label': 'per-assignee outcome radar', children: [...axisLines, ...polygons] })
}

// Sankey: handoffs[] from -> to flow. Two-column layout (from-nodes left,
// to-nodes right) with flow bands sized by volume — the simplest sankey
// shape that fits this data (handoffs is already a flat from/to/volume
// list, not a multi-stage graph).
function AgentMetricsSankey({ handoffs }) {
  if (handoffs.length === 0) return jsx(DashboardMessageState, { children: 'No handoffs available' })
  const W = 360, H = 240, NODE_W = 10
  const fromNodes = [...new Set(handoffs.map((h) => h.from))]
  const toNodes = [...new Set(handoffs.map((h) => h.to))]
  const totalOut = new Map(fromNodes.map((n) => [n, handoffs.filter((h) => h.from === n).reduce((s, h) => s + h.volume, 0)]))
  const totalIn = new Map(toNodes.map((n) => [n, handoffs.filter((h) => h.to === n).reduce((s, h) => s + h.volume, 0)]))
  const grandTotal = handoffs.reduce((s, h) => s + h.volume, 0) || 1
  const usableH = H - 20
  function layout(nodes, totals) {
    let y = 10
    const pos = new Map()
    for (const n of nodes) {
      const h = (totals.get(n) / grandTotal) * usableH
      pos.set(n, { y, h })
      y += h + 4
    }
    return pos
  }
  const fromPos = layout(fromNodes, totalOut)
  const toPos = layout(toNodes, totalIn)
  const fromCursor = new Map(fromNodes.map((n) => [n, fromPos.get(n).y]))
  const toCursor = new Map(toNodes.map((n) => [n, toPos.get(n).y]))
  const palette = ['#508cff', '#5fd0a0', '#f0a860', '#e06880', '#a878e0', '#60c8d8']
  const bands = handoffs.map((h, i) => {
    const bandH = (h.volume / grandTotal) * usableH
    const y0 = fromCursor.get(h.from)
    const y1 = toCursor.get(h.to)
    fromCursor.set(h.from, y0 + bandH)
    toCursor.set(h.to, y1 + bandH)
    const x0 = NODE_W, x1 = W - NODE_W
    const path = `M${x0},${y0} C${W / 2},${y0} ${W / 2},${y1} ${x1},${y1} L${x1},${y1 + bandH} C${W / 2},${y1 + bandH} ${W / 2},${y0 + bandH} ${x0},${y0 + bandH} Z`
    return jsxs('g', { children: [jsx('path', { d: path, fill: palette[i % palette.length], fillOpacity: 0.45 }), jsx('title', { children: `${h.from} -> ${h.to}: ${h.volume}` })] }, `band-${h.from}-${h.to}`)
  })
  const fromLabels = fromNodes.map((n) => jsx('text', { x: 0, y: fromPos.get(n).y + fromPos.get(n).h / 2, fontSize: 10, children: n }, `from-label-${n}`))
  const toLabels = toNodes.map((n) => jsx('text', { x: W, y: toPos.get(n).y + toPos.get(n).h / 2, fontSize: 10, textAnchor: 'end', children: n }, `to-label-${n}`))
  return jsxs('svg', { width: W, height: H, role: 'img', 'aria-label': 'agent handoff sankey diagram', children: [...bands, ...fromLabels, ...toLabels] })
}

function AgentMetricsWidgetsBody({ snapshot }) {
  const records = Array.isArray(snapshot.records) ? snapshot.records : []
  const handoffs = Array.isArray(snapshot.handoffs) ? snapshot.handoffs : []
  if (records.length === 0 && handoffs.length === 0) {
    return jsx(DashboardMessageState, { children: 'No agent metrics available' })
  }
  return jsxs('div', {
    children: [
      jsx(AgentMetricsWidgetsSection, { title: 'Heatmap (assignee x outcome, volume)', dataKey: 'heatmap', children: jsx(AgentMetricsHeatmap, { records }) }),
      jsx(AgentMetricsWidgetsSection, { title: 'Scatter (avg duration vs volume)', dataKey: 'scatter', children: jsx(AgentMetricsScatter, { records }) }),
      jsx(AgentMetricsWidgetsSection, { title: 'Parallel Coordinates (assignee/outcome/volume/duration)', dataKey: 'parallel-coordinates', children: jsx(AgentMetricsParallelCoordinates, { records }) }),
      jsx(AgentMetricsWidgetsSection, { title: 'Treemap (volume by assignee)', dataKey: 'treemap', children: jsx(AgentMetricsTreemap, { records }) }),
      jsx(AgentMetricsWidgetsSection, { title: 'Radar (per-assignee outcome profile)', dataKey: 'radar', children: jsx(AgentMetricsRadar, { records }) }),
      jsx(AgentMetricsWidgetsSection, { title: 'Sankey (handoff flow)', dataKey: 'sankey', children: jsx(AgentMetricsSankey, { handoffs }) }),
    ],
  })
}

function AgentMetricsWidgetsPage() {
  const [state, setState] = React.useState({ loading: true, snapshot: null, error: null })
  React.useLayoutEffect(() => {
    let active = true
    cliExec(['decision', 'agent-metrics-snapshot']).then((res) => {
      if (!active) return
      if (!res || res.ok === false || !Array.isArray(res.records)) {
        setState({ loading: false, snapshot: null, error: (res && res.error) || 'agent metrics snapshot is unavailable' })
        return
      }
      setState({ loading: false, snapshot: res, error: null })
    }).catch((e) => {
      if (active) setState({ loading: false, snapshot: null, error: String(e.message || e) })
    })
    return () => { active = false }
  }, [])

  return jsxs('section', {
    'aria-label': 'Agent Metrics Widgets',
    className: 'flex h-full flex-col gap-3 overflow-auto p-4 text-sm',
    children: [
      jsx('div', { className: 'font-medium', children: 'Agent Metrics Widgets' }),
      state.loading ? jsx(DashboardLoadingState, {}) : state.error ? jsx(DashboardMessageState, { children: `Agent metrics unavailable: ${state.error}` }) : jsx(AgentMetricsWidgetsBody, { snapshot: state.snapshot }),
    ],
  })
}
// --- End Agent Metrics Widgets --------------------------------------------

function useKanbanBoards() {
  // Kanban boards are a wholly separate concept from decision-hud "projects"
  // (see BoardSelector below) — this only lists them for the selector UI,
  // it does not join them to anything.
  const [state, setState] = React.useState({ boards: [], loading: true, error: null })

  const refresh = React.useCallback(async () => {
    try {
      // Real CLI verb, confirmed via `hermes kanban boards list --help`:
      // `hermes kanban boards list --json` — returns a bare JSON array of
      // board objects (not wrapped in a `{ boards: [...] }` envelope like
      // the decision CLI's list commands).
      const boardsRes = await cliExec(['kanban', 'boards', 'list', '--json'])
      setState({ boards: Array.isArray(boardsRes) ? boardsRes : [], loading: false, error: null })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }))
    }
  }, [])

  React.useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  return { ...state, refresh }
}

function useDecisionQueue(projectId) {
  const [state, setState] = React.useState({ decisions: [], projects: [], loading: true, error: null })

  const refresh = React.useCallback(async () => {
    try {
      const [listRes, projRes] = await Promise.all([
        cliExec(['decision', 'list', '--limit', '5', ...(projectId ? ['--project-id', projectId] : [])]),
        cliExec(['decision', 'projects']),
      ])
      setState({
        decisions: listRes.decisions || [],
        projects: projRes.projects || [],
        loading: false,
        error: null,
      })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }))
    }
  }, [projectId])

  React.useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  return { ...state, refresh }
}

function TriageBlockedWorkButton({ boardSlug, projectId, onComplete }) {
  const [pending, setPending] = React.useState(false)
  const handleClick = async () => {
    if (!boardSlug || !projectId || pending) return
    haptic('tap')
    setPending(true)
    try {
      const [diagnostics, blocked] = await Promise.all([
        cliExec(['kanban', '--board', boardSlug, 'diagnostics', '--json']),
        cliExec(['kanban', '--board', boardSlug, 'list', '--status', 'blocked', '--json']),
      ])
      const graphRows = await Promise.all(
        (Array.isArray(blocked) ? blocked : []).map(async (task) => [
          task.id,
          await cliExec(['kanban', '--board', boardSlug, 'show', task.id, '--json']),
        ])
      )
      const graph = Object.fromEntries(graphRows.map(([id, detail]) => [id, { parents: detail.parents || [] }]))
      const result = await cliExec([
        'decision', 'triage-blocked', '--project-id', projectId, '--board', boardSlug,
        '--diagnostics', JSON.stringify(diagnostics), '--blocked', JSON.stringify(blocked), '--graph', JSON.stringify(graph),
      ])
      await onComplete()
      const summary = result.summary || {}
      host.notify({ kind: 'success', message: `Blocked work triaged: ${summary.created || 0} card(s), ${summary.dependency_only || 0} dependency wait(s) grouped` })
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setPending(false)
    }
  }
  return jsx('button', {
    type: 'button',
    'aria-label': 'Triage blocked work',
    title: 'Group blocked Kanban work into bounded Decision HUD cards',
    onClick: handleClick,
    disabled: pending,
    className: 'h-6 rounded border border-(--ui-stroke-secondary) px-2 text-[0.7rem] text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) disabled:opacity-50',
    children: pending ? 'Triaging…' : 'Triage blocked work',
  })
}

const URGENCY_COLOR = {
  high: 'var(--ui-danger, #e5484d)',
  normal: 'var(--ui-text-secondary)',
  low: 'var(--ui-text-tertiary)',
}

// --- Shared small primitives --------------------------------------------

// safeText: coerce any payload/decision-derived value to a renderable JSX
// child. React itself throws when handed a bare object/array as children —
// this is the single choke point every renderer below funnels scalars
// through before putting them in `children`.
function safeText(value, fallback = '') {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch (e) {
    return fallback
  }
}

// safeArray: never let a non-array payload field reach .map() — every
// CARD_RENDERERS component reads its list/array fields from card_payload
// (fully-attacker/producer-controlled JSON) through this instead of a bare
// `|| []` fallback, which only covers missing/null, not wrong-type.
function safeArray(value) {
  return Array.isArray(value) ? value : []
}

// CardHeader: project tag on the left; urgency label and the Dismiss (X)
// icon grouped together on the right of the SAME row, so closing a card is
// reachable without hunting for it among the bottom-row action buttons.
function CardHeader({ decision, onDismiss, resolving }) {
  return jsxs('div', {
    className: 'flex items-center justify-between text-[0.7rem]',
    children: [
      jsx('span', {
        className: 'rounded px-1.5 py-0.5 font-medium text-(--ui-text-tertiary)',
        style: { border: '1px solid var(--ui-stroke-secondary)' },
        children: safeText(decision.project_slug, decision.project_id),
      }),
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('span', {
            style: { color: URGENCY_COLOR[decision.urgency] || URGENCY_COLOR.normal },
            children: safeText(decision.urgency),
          }),
          jsx(DismissButton, { disabled: resolving, onClick: () => onDismiss(decision.id) }),
        ],
      }),
    ],
  })
}

function CardQuestion({ decision }) {
  return jsx('div', { className: 'text-sm font-medium leading-snug', children: safeText(decision.question, '(no question text)') })
}

function ConfirmButton({ disabled, resolving, onClick, children }) {
  return jsx('button', {
    type: 'button',
    disabled: disabled || resolving,
    onClick,
    className: cn(
      'mt-1 rounded-md px-3 py-1.5 text-[0.8rem] font-medium',
      'bg-(--ui-accent)/15 text-(--ui-accent)',
      'transition-colors hover:bg-(--ui-accent) hover:text-(--ui-on-accent,#fff)',
      'disabled:opacity-40 disabled:hover:bg-(--ui-accent)/15 disabled:hover:text-(--ui-accent)'
    ),
    children: children || 'Confirm',
  })
}

function DeferButton({ disabled, onClick }) {
  // Fixed h-[1.9rem] height matches IconButton (Discuss/Dismiss) so the
  // bottom action row's two buttons line up vertically instead of Defer's
  // old vertical-padding-driven sizing giving it a different height.
  return jsx('button', {
    type: 'button',
    disabled,
    onClick,
    className: cn(
      'mt-1 flex h-[1.9rem] items-center rounded-md px-3 text-[0.8rem] font-medium transition-opacity',
      'disabled:opacity-40 hover:bg-(--chrome-action-hover)'
    ),
    style: { border: '1px solid var(--ui-stroke-secondary)', color: 'var(--ui-text-secondary)' },
    children: 'Defer',
  })
}

// IconButton: shared shape for the two icon-only card actions (Discuss,
// Dismiss) that sit alongside DeferButton — same height/border language,
// square instead of labeled since a codicon carries the meaning.
function IconButton({ disabled, onClick, title, codicon, tone }) {
  return jsx('button', {
    type: 'button',
    disabled,
    onClick,
    title,
    'aria-label': title,
    className: cn(
      'mt-1 flex h-[1.9rem] w-[1.9rem] items-center justify-center rounded-md transition-opacity',
      'disabled:opacity-40 hover:bg-(--chrome-action-hover)',
      tone === 'danger' ? 'text-(--ui-danger,#e5484d)' : 'text-(--ui-text-secondary)'
    ),
    style: { border: '1px solid var(--ui-stroke-secondary)' },
    children: jsx(Codicon, { name: codicon, size: '0.85rem' }),
  })
}

function DiscussButton({ disabled, onClick }) {
  return jsx(IconButton, { disabled, onClick, title: 'Discuss in chat', codicon: 'comment-discussion' })
}

function DismissButton({ disabled, onClick }) {
  return jsx(IconButton, { disabled, onClick, title: 'Dismiss', codicon: 'close', tone: 'danger' })
}

// --- Card type components -------------------------------------------------
// Each receives (decision, onResolve, resolving) and calls
// onResolve(decisionId, plainTextChoiceSummary, structuredPayloadOrNull).

function DefaultChoiceCard({ decision, onResolve, resolving }) {
  // Plain-text fallback: also the renderer for card_type null/unrecognized,
  // and effectively for "mcq_plus_context" since a single click IS the
  // choice — the desktop pane has no free-text box (that variant is a
  // ::preview-only affordance); the plain list already satisfies "always
  // available as backup" here.
  const choices = safeArray(decision.choices)
  if (choices.length === 0) {
    return jsx('div', {
      className: 'text-[0.75rem] text-(--ui-text-tertiary)',
      children: 'No choices available for this decision — malformed decision data.',
    })
  }
  return jsx('div', {
    className: 'flex flex-col gap-1.5',
    children: choices.map((choice) =>
      jsx(
        'button',
        {
          key: safeText(choice),
          type: 'button',
          disabled: resolving,
          onClick: () => onResolve(decision.id, choice, null),
          className: cn(
            'rounded-md px-2.5 py-1.5 text-left text-[0.8rem] transition-colors',
            'hover:bg-(--chrome-action-hover) disabled:opacity-50'
          ),
          style: {
            border:
              choice === decision.recommended
                ? '1px solid var(--ui-accent)'
                : '1px solid var(--ui-stroke-secondary)',
          },
          children: [
            safeText(choice),
            choice === decision.recommended
              ? jsx('span', { className: 'ml-1.5 text-(--ui-text-tertiary)', children: '★' })
              : null,
          ],
        }
      )
    ),
  })
}

function QuadChoiceCard({ decision, onResolve, resolving }) {
  // Same one-click-resolves model as the default list, just laid out as a
  // 2-column grid — matches the ::preview Quad Choice card's shape
  // (both/either/one-only/neither) without needing a payload.
  const choices = safeArray(decision.choices)
  if (choices.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }
  return jsx('div', {
    className: 'grid grid-cols-2 gap-2',
    children: choices.map((choice) =>
      jsx('button', {
        key: safeText(choice),
        type: 'button',
        disabled: resolving,
        onClick: () => onResolve(decision.id, choice, null),
        className: cn(
          'rounded-md px-2 py-2 text-center text-[0.75rem] transition-colors',
          'hover:bg-(--chrome-action-hover) disabled:opacity-50'
        ),
        style: {
          border:
            choice === decision.recommended
              ? '1px solid var(--ui-accent)'
              : '1px solid var(--ui-stroke-secondary)',
        },
        children: safeText(choice),
      })
    ),
  })
}

function MultiSelectCard({ decision, onResolve, resolving }) {
  const choices = safeArray(decision.choices)
  const [selected, setSelected] = React.useState(() => new Set())
  const toggle = (choice) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(choice) ? next.delete(choice) : next.add(choice)
      return next
    })
  }
  if (choices.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }
  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'flex flex-col gap-1.5',
        children: choices.map((choice) =>
          jsxs('button', {
            key: safeText(choice),
            type: 'button',
            disabled: resolving,
            onClick: () => toggle(choice),
            className: cn(
              'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[0.8rem] transition-colors',
              'hover:bg-(--chrome-action-hover) disabled:opacity-50'
            ),
            style: { border: `1px solid ${selected.has(choice) ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
            children: [
              jsx('span', {
                className: 'inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-[0.6rem]',
                style: {
                  border: '1px solid var(--ui-stroke-secondary)',
                  background: selected.has(choice) ? 'var(--ui-accent)' : 'transparent',
                  color: 'var(--ui-on-accent, #fff)',
                },
                children: selected.has(choice) ? '✓' : '',
              }),
              safeText(choice),
            ],
          })
        ),
      }),
      jsx(ConfirmButton, {
        disabled: selected.size === 0,
        resolving,
        onClick: () => {
          const list = Array.from(selected)
          onResolve(decision.id, list.join(', '), { selected: list })
        },
        children: `Confirm (${selected.size} selected)`,
      }),
    ],
  })
}

function SequenceOrderCard({ decision, onResolve, resolving }) {
  const initialOrder = safeArray(decision.choices)
  const [order, setOrder] = React.useState(initialOrder)
  const [firstPick, setFirstPick] = React.useState(null)

  if (initialOrder.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const handleClick = (idx) => {
    if (firstPick === null) {
      setFirstPick(idx)
      return
    }
    if (firstPick === idx) {
      setFirstPick(null)
      return
    }
    setOrder((prev) => {
      const next = [...prev]
      ;[next[firstPick], next[idx]] = [next[idx], next[firstPick]]
      return next
    })
    setFirstPick(null)
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: 'Click two rows to swap their order.',
      }),
      jsx('div', {
        className: 'flex flex-col gap-1',
        children: order.map((item, idx) =>
          jsxs('button', {
            key: safeText(item) + '-' + idx,
            type: 'button',
            disabled: resolving,
            onClick: () => handleClick(idx),
            className: cn(
              'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[0.8rem] transition-colors',
              'hover:bg-(--chrome-action-hover) disabled:opacity-50'
            ),
            style: { border: `1px solid ${firstPick === idx ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
            children: [
              jsx('span', {
                className: 'flex h-4 w-4 items-center justify-center rounded-full text-[0.65rem] text-(--ui-text-tertiary)',
                style: { border: '1px solid var(--ui-stroke-secondary)' },
                children: String(idx + 1),
              }),
              safeText(item),
            ],
          })
        ),
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => onResolve(decision.id, order.join(' → '), { order }),
        children: 'Confirm order',
      }),
    ],
  })
}

function AssemblePiecesCard({ decision, onResolve, resolving }) {
  // card_payload.slots: [{ key, label, options: [...] }]
  const slots = safeArray(decision.card_payload && decision.card_payload.slots)
  const [picks, setPicks] = React.useState({})
  const allPicked = slots.length > 0 && slots.every((s) => s && picks[s.key])

  if (slots.length === 0) {
    // malformed/missing payload — never dead-end, fall back to plain list
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      ...slots.map((slot, slotIdx) => {
        const options = safeArray(slot && slot.options)
        const slotKey = slot && slot.key !== undefined ? safeText(slot.key) : `slot-${slotIdx}`
        return jsxs('div', {
          key: slotKey,
          className: 'flex flex-col gap-1',
          children: [
            jsx('div', { className: 'text-[0.7rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: safeText(slot && slot.label, slotKey) }),
            jsx('div', {
              className: 'flex flex-wrap gap-1.5',
              children: options.map((opt) =>
                jsx('button', {
                  key: safeText(opt),
                  type: 'button',
                  disabled: resolving,
                  onClick: () => setPicks((prev) => ({ ...prev, [slotKey]: opt })),
                  className: 'rounded-md px-2 py-1 text-[0.75rem] transition-colors hover:bg-(--chrome-action-hover)',
                  style: { border: `1px solid ${picks[slotKey] === opt ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
                  children: safeText(opt),
                })
              ),
            }),
          ],
        })
      }),
      jsx(ConfirmButton, {
        disabled: !allPicked,
        resolving,
        onClick: () => {
          const summary = slots.map((s, i) => `${(s && s.key) || `slot-${i}`}=${picks[(s && s.key) || `slot-${i}`]}`).join(', ')
          onResolve(decision.id, summary, { picks })
        },
        children: 'Confirm assembly',
      }),
    ],
  })
}

const MATRIX_QUADRANTS = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

function BalanceScaleCard({ decision, onResolve, resolving }) {
  // decision.choices must be exactly the 2 sides; card_payload.considerations
  // is the list of chip labels to sort between them.
  const sides = safeArray(decision.choices)
  const sideA = sides[0]
  const sideB = sides[1]
  const considerations = safeArray(decision.card_payload && decision.card_payload.considerations)
  const [placement, setPlacement] = React.useState({}) // label -> 'A' | 'B'

  if (considerations.length === 0 || sideA === undefined || sideB === undefined) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const allPlaced = considerations.every((c) => placement[c])
  const countA = considerations.filter((c) => placement[c] === 'A').length
  const countB = considerations.filter((c) => placement[c] === 'B').length

  const cycle = (label) => {
    setPlacement((prev) => ({ ...prev, [label]: prev[label] === 'A' ? 'B' : 'A' }))
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: `Click each item to toggle it between "${safeText(sideA)}" and "${safeText(sideB)}".`,
      }),
      jsx('div', {
        className: 'flex flex-col gap-1',
        children: considerations.map((label) =>
          jsxs('button', {
            key: safeText(label),
            type: 'button',
            disabled: resolving,
            onClick: () => cycle(label),
            className: 'flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[0.8rem] transition-colors hover:bg-(--chrome-action-hover)',
            style: { border: `1px solid ${placement[label] ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
            children: [
              safeText(label),
              jsx('span', {
                className: 'text-[0.7rem] text-(--ui-text-tertiary)',
                children: placement[label] ? `→ ${placement[label] === 'A' ? safeText(sideA) : safeText(sideB)}` : '(unplaced — click to place)',
              }),
            ],
          })
        ),
      }),
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: allPlaced ? `${safeText(sideA)}: ${countA}  ·  ${safeText(sideB)}: ${countB}` : 'Place every item to see the tally.',
      }),
      jsx(ConfirmButton, {
        disabled: !allPlaced,
        resolving,
        onClick: () => {
          const winner = countA === countB ? 'tied' : countA > countB ? sideA : sideB
          onResolve(decision.id, `${safeText(winner)} (${countA} vs ${countB})`, {
            winner,
            tally: { [sideA]: countA, [sideB]: countB },
          })
        },
        children: 'Confirm choice',
      }),
    ],
  })
}

function WeightedAllocationCard({ decision, onResolve, resolving }) {
  // card_payload: { total, options: [{ key, label }] }
  const totalRaw = decision.card_payload && decision.card_payload.total
  const total = typeof totalRaw === 'number' && isFinite(totalRaw) ? totalRaw : 10
  const options = safeArray(decision.card_payload && decision.card_payload.options)
  const [values, setValues] = React.useState(() => Object.fromEntries(options.map((o, i) => [(o && o.key) ?? `opt-${i}`, 0])))

  if (options.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const used = Object.values(values).reduce((a, b) => a + b, 0)
  const remaining = total - used

  const step = (key, dir) => {
    setValues((prev) => {
      const next = prev[key] + dir
      if (next < 0) return prev
      if (dir > 0 && used >= total) return prev
      return { ...prev, [key]: next }
    })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: `${remaining} point${remaining === 1 ? '' : 's'} remaining`,
      }),
      jsx('div', {
        className: 'flex flex-col gap-1.5',
        children: options.map((opt, i) => {
          const key = (opt && opt.key) ?? `opt-${i}`
          return jsxs('div', {
            key: safeText(key),
            className: 'flex items-center justify-between rounded-md px-2.5 py-1.5',
            style: { border: '1px solid var(--ui-stroke-secondary)' },
            children: [
              jsx('span', { className: 'text-[0.8rem]', children: safeText(opt && opt.label, safeText(key)) }),
              jsxs('div', {
                className: 'flex items-center gap-2',
                children: [
                  jsx('button', {
                    type: 'button',
                    disabled: resolving || values[key] <= 0,
                    onClick: () => step(key, -1),
                    className: 'flex h-5 w-5 items-center justify-center rounded disabled:opacity-30',
                    style: { border: '1px solid var(--ui-stroke-secondary)' },
                    children: '−',
                  }),
                  jsx('span', { className: 'w-4 text-center text-[0.8rem] font-medium', children: safeText(values[key], '0') }),
                  jsx('button', {
                    type: 'button',
                    disabled: resolving || remaining <= 0,
                    onClick: () => step(key, 1),
                    className: 'flex h-5 w-5 items-center justify-center rounded disabled:opacity-30',
                    style: { border: '1px solid var(--ui-stroke-secondary)' },
                    children: '+',
                  }),
                ],
              }),
            ],
          })
        }),
      }),
      jsx(ConfirmButton, {
        disabled: remaining !== 0,
        resolving,
        onClick: () => {
          const summary = options.map((o, i) => `${(o && o.key) ?? `opt-${i}`}=${values[(o && o.key) ?? `opt-${i}`]}`).join(', ')
          onResolve(decision.id, summary, { allocation: values })
        },
        children: 'Confirm allocation',
      }),
    ],
  })
}

function ScalarSliderCard({ decision, onResolve, resolving }) {
  // card_payload: { min, max, step, default, unit }
  const rawP = decision.card_payload
  const p = rawP && typeof rawP === 'object' && !Array.isArray(rawP) ? rawP : {}
  const min = typeof p.min === 'number' ? p.min : 0
  const max = typeof p.max === 'number' ? p.max : 100
  const step = typeof p.step === 'number' ? p.step : 1
  const unit = safeText(p.unit, '')
  const [value, setValue] = React.useState(typeof p.default === 'number' ? p.default : min)

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', { className: 'text-center text-lg font-semibold', style: { color: 'var(--ui-accent)' }, children: `${value}${unit}` }),
      jsx('input', {
        type: 'range',
        min,
        max,
        step,
        value,
        disabled: resolving,
        onChange: (e) => setValue(Number(e.target.value)),
        className: 'w-full',
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => onResolve(decision.id, `${value}${unit}`, { value }),
        children: `Confirm ${value}${unit}`,
      }),
    ],
  })
}

function RangeSliderCard({ decision, onResolve, resolving }) {
  // card_payload: { min, max, step, default_low, default_high, unit }
  const rawP = decision.card_payload
  const p = rawP && typeof rawP === 'object' && !Array.isArray(rawP) ? rawP : {}
  const min = typeof p.min === 'number' ? p.min : 0
  const max = typeof p.max === 'number' ? p.max : 1000
  const step = typeof p.step === 'number' ? p.step : 10
  const unit = safeText(p.unit, '')
  const [lo, setLo] = React.useState(typeof p.default_low === 'number' ? p.default_low : min)
  const [hi, setHi] = React.useState(typeof p.default_high === 'number' ? p.default_high : max)

  const loClamped = Math.min(lo, hi)
  const hiClamped = Math.max(lo, hi)

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-center text-sm font-semibold',
        style: { color: 'var(--ui-accent)' },
        children: `${loClamped}${unit} – ${hiClamped}${unit}`,
      }),
      jsxs('div', {
        className: 'flex flex-col gap-1',
        children: [
          jsx('input', { type: 'range', min, max, step, value: lo, disabled: resolving, onChange: (e) => setLo(Number(e.target.value)), className: 'w-full' }),
          jsx('input', { type: 'range', min, max, step, value: hi, disabled: resolving, onChange: (e) => setHi(Number(e.target.value)), className: 'w-full' }),
        ],
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => onResolve(decision.id, `${loClamped}${unit}-${hiClamped}${unit}`, { low: loClamped, high: hiClamped }),
        children: `Confirm ${loClamped}${unit} – ${hiClamped}${unit}`,
      }),
    ],
  })
}

function AnchorAdjustCard({ decision, onResolve, resolving }) {
  // card_payload.fields: [{ key, label, default, options: [...] }]
  const fields = safeArray(decision.card_payload && decision.card_payload.fields)
  const [values, setValues] = React.useState(() => Object.fromEntries(fields.map((f, i) => [(f && f.key) ?? `field-${i}`, f && f.default])))
  const [open, setOpen] = React.useState({})

  if (fields.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const overriddenCount = fields.filter((f, i) => values[(f && f.key) ?? `field-${i}`] !== (f && f.default)).length

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children:
          overriddenCount === 0
            ? `All ${fields.length} fields at recommended defaults — Confirm works now.`
            : `${overriddenCount}/${fields.length} field(s) overridden.`,
      }),
      jsx('div', {
        className: 'flex flex-col gap-1',
        children: fields.map((f, i) => {
          const key = (f && f.key) ?? `field-${i}`
          const options = safeArray(f && f.options)
          const overridden = values[key] !== (f && f.default)
          return jsxs('div', {
            key: safeText(key),
            className: 'rounded-md px-2.5 py-1.5',
            style: { border: `1px solid ${overridden ? 'var(--ui-text-tertiary)' : 'var(--ui-accent)'}` },
            children: [
              jsxs('button', {
                type: 'button',
                disabled: resolving,
                onClick: () => setOpen((prev) => ({ ...prev, [key]: !prev[key] })),
                className: 'flex w-full items-center justify-between text-left text-[0.8rem]',
                children: [
                  jsxs('span', { children: [`${safeText(f && f.label, safeText(key))} — `, jsx('b', { children: safeText(values[key]) })] }),
                  jsx('span', {
                    className: 'text-[0.65rem]',
                    style: { color: overridden ? 'var(--ui-text-tertiary)' : 'var(--ui-accent)' },
                    children: overridden ? 'Overridden' : 'Recommended',
                  }),
                ],
              }),
              open[key]
                ? jsx('div', {
                    className: 'mt-1.5 flex flex-wrap gap-1 border-t pt-1.5',
                    style: { borderColor: 'var(--ui-stroke-secondary)' },
                    children: options.map((opt) =>
                      jsx('button', {
                        key: safeText(opt),
                        type: 'button',
                        disabled: resolving,
                        onClick: () => setValues((prev) => ({ ...prev, [key]: opt })),
                        className: 'rounded px-1.5 py-0.5 text-[0.7rem] transition-colors hover:bg-(--chrome-action-hover)',
                        style: { border: `1px solid ${values[key] === opt ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
                        children: safeText(opt),
                      })
                    ),
                  })
                : null,
            ],
          })
        }),
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => {
          const summary = fields.map((f, i) => {
            const key = (f && f.key) ?? `field-${i}`
            return `${key}=${values[key]}`
          }).join(', ')
          onResolve(decision.id, summary, { values })
        },
        children: 'Confirm config',
      }),
    ],
  })
}

function Matrix2x2Card({ decision, onResolve, resolving }) {
  // card_payload: { x_axis_label, y_axis_label, items: [{ key, label }] }
  const payload = decision.card_payload || {}
  const xLabel = payload.x_axis_label
  const yLabel = payload.y_axis_label
  const items = safeArray(payload.items)
  const [placements, setPlacements] = React.useState({}) // item_key -> quadrant

  // Guard: missing axis labels or malformed items array -> plain fallback,
  // never crash on an attacker/producer-controlled payload.
  if (
    typeof xLabel !== 'string' || xLabel.trim() === '' ||
    typeof yLabel !== 'string' || yLabel.trim() === '' ||
    items.length === 0 ||
    !items.every((it) => it && typeof it === 'object' && it.key !== undefined && it.key !== null && it.key !== '')
  ) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const itemKeys = items.map((it) => safeText(it.key))
  const allPlaced = itemKeys.length > 0 && itemKeys.every((k) => placements[k])

  const place = (key, quadrant) => {
    setPlacements((prev) => ({ ...prev, [key]: quadrant }))
  }

  const unplaced = items.filter((it) => !placements[safeText(it.key)])

  const quadrantCell = (quadrant, cornerLabel) => {
    const inQuadrant = items.filter((it) => placements[safeText(it.key)] === quadrant)
    return jsxs('div', {
      key: quadrant,
      className: 'flex min-h-[84px] flex-col gap-1 rounded-md p-2',
      style: { border: '1px solid var(--ui-stroke-secondary)' },
      children: [
        jsx('div', { className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: cornerLabel }),
        jsx('div', {
          className: 'flex flex-wrap gap-1',
          children: inQuadrant.map((it) =>
            jsx('button', {
              key: safeText(it.key),
              type: 'button',
              disabled: resolving,
              onClick: () => place(safeText(it.key), null),
              className: 'rounded-md px-1.5 py-0.5 text-[0.7rem] transition-colors hover:bg-(--chrome-action-hover)',
              style: { border: '1px solid var(--ui-accent)' },
              children: safeText(it.label, safeText(it.key)),
            })
          ),
        }),
      ],
    })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: `Click an unplaced item, then click the quadrant it belongs in. Axes: "${safeText(xLabel)}" (x) vs "${safeText(yLabel)}" (y).`,
      }),
      jsx('div', {
        className: 'grid grid-cols-2 gap-1.5',
        children: [
          quadrantCell('top-left', 'Top-Left'),
          quadrantCell('top-right', 'Top-Right'),
          quadrantCell('bottom-left', 'Bottom-Left'),
          quadrantCell('bottom-right', 'Bottom-Right'),
        ],
      }),
      unplaced.length > 0
        ? jsxs('div', {
            className: 'flex flex-col gap-1',
            children: [
              jsx('div', { className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: 'Unplaced items — click a quadrant button below each' }),
              jsx('div', {
                className: 'flex flex-col gap-1',
                children: unplaced.map((it) => {
                  const key = safeText(it.key)
                  return jsxs('div', {
                    key,
                    className: 'flex items-center justify-between gap-2 rounded-md px-2 py-1',
                    style: { border: '1px solid var(--ui-stroke-secondary)' },
                    children: [
                      jsx('span', { className: 'text-[0.78rem]', children: safeText(it.label, key) }),
                      jsx('div', {
                        className: 'flex flex-wrap gap-1',
                        children: MATRIX_QUADRANTS.map((q) =>
                          jsx('button', {
                            key: q,
                            type: 'button',
                            disabled: resolving,
                            onClick: () => place(key, q),
                            className: 'rounded-md px-1.5 py-0.5 text-[0.65rem] transition-colors hover:bg-(--chrome-action-hover)',
                            style: { border: '1px solid var(--ui-stroke-secondary)' },
                            children: q,
                          })
                        ),
                      }),
                    ],
                  })
                }),
              }),
            ],
          })
        : null,
      jsx(ConfirmButton, {
        disabled: !allPlaced,
        resolving,
        onClick: () => {
          const summary = items
            .map((it) => `${safeText(it.label, safeText(it.key))}=${placements[safeText(it.key)]}`)
            .join(', ')
          onResolve(decision.id, summary, { placements })
        },
        children: 'Confirm placement',
      }),
    ],
  })
}

function SortToBinCard({ decision, onResolve, resolving }) {
  // card_payload: { items: [{ key, label }], bins: [{ key, label }] }
  // Click-to-place (not HTML5 drag-and-drop): this codebase already
  // resolved the same tension in BalanceScaleCard (chips onto sides) by
  // using click-to-cycle rather than porting the prototype's native
  // drag/drop — click targets are simpler to reach with keyboard/assistive
  // tech and there is zero existing native-DnD precedent anywhere else in
  // plugin.js to match. Interaction: click an item to select it, then
  // click a bin to place the selected item there; click a placed item
  // again to re-select and move it.
  const items = safeArray(decision.card_payload && decision.card_payload.items)
  const bins = safeArray(decision.card_payload && decision.card_payload.bins)
  const [placements, setPlacements] = React.useState({})
  const [selectedItem, setSelectedItem] = React.useState(null)

  // Malformed payload guard: need at least one item and 2-3 bins, else
  // fall back to the plain choice list rather than risk a broken render.
  if (items.length === 0 || bins.length < 2 || bins.length > 3) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const itemKeyOf = (it, i) => (it && it.key !== undefined ? safeText(it.key) : `item-${i}`)
  const binKeyOf = (bin, i) => (bin && bin.key !== undefined ? safeText(bin.key) : `bin-${i}`)
  const allPlaced = items.every((it, i) => placements[itemKeyOf(it, i)])

  const place = (itemKey, binKey) => {
    setPlacements((prev) => ({ ...prev, [itemKey]: binKey }))
    setSelectedItem(null)
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: selectedItem
          ? 'Click a bin below to place the selected item.'
          : 'Click an item, then click the bin to place it in.',
      }),
      jsx('div', {
        className: 'flex flex-wrap gap-1.5 rounded-md p-2',
        style: { border: '1px dashed var(--ui-stroke-secondary)' },
        children: items.map((it, i) => {
          const key = itemKeyOf(it, i)
          const placed = placements[key]
          return jsx('button', {
            key,
            type: 'button',
            disabled: resolving,
            onClick: () => setSelectedItem(selectedItem === key ? null : key),
            className: 'rounded-full px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-(--chrome-action-hover)',
            style: {
              border: `1px solid ${selectedItem === key ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}`,
              opacity: placed ? 0.5 : 1,
            },
            children: safeText(it && it.label, key),
          })
        }),
      }),
      jsx('div', {
        className: 'grid gap-1.5',
        style: { gridTemplateColumns: `repeat(${bins.length}, minmax(0,1fr))` },
        children: bins.map((bin, bi) => {
          const binKey = binKeyOf(bin, bi)
          const binItems = items.filter((it, i) => placements[itemKeyOf(it, i)] === binKey)
          return jsxs('div', {
            key: binKey,
            className: 'flex min-h-16 flex-col gap-1 rounded-md p-1.5 text-left',
            style: { border: `1px solid ${selectedItem ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
            onClick: () => {
              if (selectedItem) place(selectedItem, binKey)
            },
            children: [
              jsx('div', {
                className: 'text-center text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)',
                children: safeText(bin && bin.label, binKey),
              }),
              ...binItems.map((it, i) =>
                jsx('div', {
                  key: itemKeyOf(it, i),
                  className: 'rounded-full px-2 py-0.5 text-center text-[0.7rem]',
                  style: { border: '1px solid var(--ui-stroke-secondary)' },
                  children: safeText(it && it.label),
                })
              ),
            ],
          })
        }),
      }),
      jsx(ConfirmButton, {
        disabled: !allPlaced,
        resolving,
        onClick: () => {
          const summary = items
            .map((it, i) => {
              const key = itemKeyOf(it, i)
              return `${safeText(it && it.label, key)}→${safeText(placements[key])}`
            })
            .join(', ')
          onResolve(decision.id, summary, { placements })
        },
        children: 'Confirm placement',
      }),
    ],
  })
}

function ZoneSelectCard({ decision, onResolve, resolving }) {
  // card_payload.zones: [{ key, label, description? }] — quantized/few
  // discrete levels, exclusive choice. Click target only, never drag (see
  // decision-hud-cards skill: gauges/zones are click targets, not drag).
  const zones = safeArray(decision.card_payload && decision.card_payload.zones)
  const [selectedKey, setSelectedKey] = React.useState(null)

  // Malformed/missing payload, or fewer than 2 zones (nothing meaningful to
  // choose between) — never dead-end, fall back to the plain choice list.
  if (zones.length < 2) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const selectedZone = zones.find((z) => z && safeText(z.key) === selectedKey)

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'flex flex-wrap gap-1.5',
        children: zones.map((zone, idx) => {
          const key = zone && zone.key !== undefined ? safeText(zone.key) : `zone-${idx}`
          const isSelected = selectedKey === key
          return jsx('button', {
            key,
            type: 'button',
            disabled: resolving,
            onClick: () => setSelectedKey(key),
            title: safeText(zone && zone.description, ''),
            className: cn(
              'rounded-md border px-2.5 py-1.5 text-left text-[0.8rem] transition-colors',
              'hover:bg-(--chrome-action-hover) disabled:opacity-50'
            ),
            style: {
              border: isSelected
                ? '1px solid var(--ui-accent)'
                : '1px solid var(--ui-stroke-secondary)',
              background: isSelected ? 'var(--ui-accent)/15' : 'transparent',
              color: isSelected ? 'var(--ui-accent)' : undefined,
              fontWeight: isSelected ? 600 : 400,
            },
            children: safeText(zone && zone.label, key),
          })
        }),
      }),
      selectedZone && selectedZone.description
        ? jsx('div', {
            className: 'text-[0.7rem] text-(--ui-text-tertiary)',
            children: safeText(selectedZone.description),
          })
        : null,
      jsxs('div', {
        className: 'flex items-center justify-end gap-2',
        children: [
          jsx('button', {
            type: 'button',
            disabled: selectedKey === null || resolving,
            onClick: () => setSelectedKey(null),
            className: cn(
              'mt-1 rounded-md border px-3 py-1.5 text-[0.8rem] font-medium',
              'border-(--ui-stroke-secondary) text-(--ui-text-secondary)',
              'transition-colors hover:bg-(--chrome-action-hover) disabled:opacity-40'
            ),
            children: 'Clear response',
          }),
          jsx(ConfirmButton, {
            disabled: selectedKey === null,
            resolving,
            onClick: () => {
              const label = safeText(selectedZone && selectedZone.label, selectedKey)
              onResolve(decision.id, label, { selected_key: selectedKey, summary: label })
            },
            children: selectedKey === null ? 'Select a zone' : `Confirm "${safeText(selectedZone && selectedZone.label, selectedKey)}"`,
          }),
        ],
      }),
    ],
  })
}

const STACKED_BAR_COLORS = ['var(--ui-accent)', 'var(--ui-warning, #f5a623)', 'var(--ui-text-tertiary)']

function StackedBarSplitCard({ decision, onResolve, resolving }) {
  // card_payload: { segments: [{ key, label }, { key, label }, { key, label }] }
  // exactly 3 segments required — the bar geometry (2 dividers) only makes
  // sense for exactly 3 regions, so any other count falls back to the
  // plain choice list rather than guessing a layout.
  const segments = safeArray(decision.card_payload && decision.card_payload.segments)
  // boundaries[0] = divider between segment 0/1 (%), boundaries[1] = divider
  // between segment 1/2 (%). Percentages derive from these two numbers by
  // construction: seg0 = b0, seg1 = b1-b0, seg2 = 100-b1 — they always sum
  // to 100 with no separate validation step needed.
  const [boundaries, setBoundaries] = React.useState([33, 67])
  const barRef = React.useRef(null)
  const dragRef = React.useRef(null) // which divider index is being dragged

  if (segments.length !== 3) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const keys = segments.map((s, i) => (s && s.key) ?? `seg-${i}`)
  const labels = segments.map((s, i) => safeText(s && s.label, safeText(keys[i])))

  const pct0 = Math.round(boundaries[0])
  const pct1 = Math.round(boundaries[1] - boundaries[0])
  const pct2 = 100 - pct0 - pct1 // remainder absorbs rounding so the three always sum to exactly 100

  const percentages = [pct0, pct1, pct2]

  const clientXToPct = (clientX) => {
    const rect = barRef.current ? barRef.current.getBoundingClientRect() : null
    if (!rect || rect.width === 0) return 0
    return Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100))
  }

  const moveDivider = (idx, rawPct) => {
    setBoundaries((prev) => {
      const next = [...prev]
      if (idx === 0) {
        // divider 0 can only trade percentage with segment 0 (left of it)
        // and segment 1 (between it and divider 1) — clamp so it never
        // crosses 0 or divider 1.
        next[0] = Math.min(Math.max(rawPct, 0), prev[1])
      } else {
        // divider 1 can only trade percentage between segment 1 and
        // segment 2 — clamp so it never crosses divider 0 or 100.
        next[1] = Math.max(Math.min(rawPct, 100), prev[0])
      }
      return next
    })
  }

  const onPointerDown = (idx) => (e) => {
    if (resolving) return
    e.preventDefault()
    dragRef.current = idx
    const onPointerMove = (moveEvent) => {
      if (dragRef.current === null) return
      moveDivider(dragRef.current, clientXToPct(moveEvent.clientX))
    }
    const onPointerUp = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  const widths = [`${pct0}%`, `${pct1}%`, `${pct2}%`]

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'flex items-center justify-between text-[0.7rem] text-(--ui-text-tertiary)',
        children: labels.map((label, i) =>
          jsxs('span', { key: safeText(keys[i]), children: [label, ': ', jsx('b', { children: `${percentages[i]}%` })] })
        ),
      }),
      jsxs('div', {
        ref: barRef,
        className: 'relative flex h-8 w-full overflow-hidden rounded-md',
        style: { border: '1px solid var(--ui-stroke-secondary)' },
        children: [
          widths.map((w, i) =>
            jsx('div', {
              key: safeText(keys[i]),
              style: { width: w, backgroundColor: STACKED_BAR_COLORS[i % STACKED_BAR_COLORS.length] },
              className: 'h-full transition-[width] duration-75',
            })
          ),
          // divider handles, positioned via CSS percentage left offset so
          // dragging one only ever adjusts the boundary array (and thus
          // the two adjacent segments), never the third.
          [0, 1].map((idx) =>
            jsx('div', {
              key: `handle-${idx}`,
              onPointerDown: onPointerDown(idx),
              className: 'absolute top-0 h-full w-2 cursor-ew-resize touch-none',
              style: {
                left: `calc(${boundaries[idx]}% - 4px)`,
                backgroundColor: 'var(--ui-text-primary, #fff)',
                opacity: resolving ? 0.3 : 0.85,
              },
            })
          ),
        ],
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => {
          const percentagesObj = Object.fromEntries(keys.map((k, i) => [k, percentages[i]]))
          const summary = labels.map((label, i) => `${label}=${percentages[i]}%`).join(', ')
          onResolve(decision.id, summary, { percentages: percentagesObj })
        },
        children: 'Confirm split',
      }),
    ],
  })
}

function ConstrainedBudgetSplitCard({ decision, onResolve, resolving }) {
  // card_payload: { total, categories: [{ key, label, min, max, default }] }
  // Distinct from WeightedAllocationCard: N independent range sliders (not
  // +/- steppers) that CAN be dragged past the point of exceeding the total —
  // there is no hard per-step gate. A live status banner reports
  // balanced/over/under as sliders move, and only an exact balance enables
  // Confirm.
  const rawP = decision.card_payload
  const p = rawP && typeof rawP === 'object' && !Array.isArray(rawP) ? rawP : {}
  const totalRaw = p.total
  const total = typeof totalRaw === 'number' && isFinite(totalRaw) ? totalRaw : null
  const categories = safeArray(p.categories)

  if (total === null || categories.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const catMeta = categories.map((c, i) => {
    const key = (c && c.key) ?? `cat-${i}`
    const label = safeText(c && c.label, safeText(key))
    const min = typeof (c && c.min) === 'number' ? c.min : 0
    const max = typeof (c && c.max) === 'number' ? c.max : total
    const def = typeof (c && c.default) === 'number' ? c.default : min
    return { key, label, min, max, default: def }
  })

  const [values, setValues] = React.useState(() => Object.fromEntries(catMeta.map((c) => [c.key, c.default])))

  const sum = catMeta.reduce((a, c) => a + (values[c.key] ?? 0), 0)
  const diff = total - sum
  // status: 'balanced' | 'over' | 'under' — purely descriptive, never blocks
  // slider movement; only gates the Confirm button below.
  const status = diff === 0 ? 'balanced' : diff < 0 ? 'over' : 'under'
  const statusColor = status === 'balanced' ? 'var(--ui-accent)' : status === 'over' ? 'var(--ui-danger, #e05252)' : 'var(--ui-text-tertiary)'
  const statusText =
    status === 'balanced'
      ? `Balanced — ${sum} / ${total}`
      : status === 'over'
        ? `Over by ${Math.abs(diff)} — ${sum} / ${total}`
        : `Under by ${diff} — ${sum} / ${total}`

  const setValue = (key, v) => setValues((prev) => ({ ...prev, [key]: v }))

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'rounded-md px-2.5 py-1.5 text-center text-[0.75rem] font-medium',
        style: { border: `1px solid ${statusColor}`, color: statusColor },
        children: statusText,
      }),
      jsx('div', {
        className: 'flex flex-col gap-2',
        children: catMeta.map((c) => {
          return jsxs('div', {
            key: safeText(c.key),
            className: 'flex flex-col gap-1',
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between text-[0.8rem]',
                children: [
                  jsx('span', { children: c.label }),
                  jsx('span', { className: 'font-medium', children: safeText(values[c.key], '0') }),
                ],
              }),
              jsx('input', {
                type: 'range',
                min: c.min,
                max: c.max,
                value: values[c.key] ?? c.min,
                disabled: resolving,
                onChange: (e) => setValue(c.key, Number(e.target.value)),
                className: 'w-full',
              }),
            ],
          })
        }),
      }),
      jsx(ConfirmButton, {
        disabled: status !== 'balanced',
        resolving,
        onClick: () => {
          const summary = catMeta.map((c) => `${c.label}=${values[c.key]}`).join(', ') + ` (total ${sum}/${total})`
          onResolve(decision.id, summary, { allocations: values })
        },
        children: 'Confirm split',
      }),
    ],
  })
}

function ConfidenceRatingCard({ decision, onResolve, resolving }) {
  // card_payload: { min, max, step, default, unit, confidence_levels: [{ key, label }] }
  //
  // Two independent axes, BOTH required before Confirm enables:
  //   1. value  — a point on a numeric continuum (slider, like ScalarSliderCard)
  //   2. confidence_level_key — a discrete certainty band (button group)
  //
  // UI choice: the certainty axis is a discrete button group, not a second
  // slider. Two overlapping range inputs stacked in one card read as "pick
  // two points on the same scale" (like RangeSliderCard's low/high), which
  // is the wrong mental model here — confidence is categorical judgment
  // (Low/Medium/High), not a second continuous quantity, and a small
  // button group makes "you haven't picked one yet" visually unambiguous
  // (no selection highlighted) in a way an untouched slider thumb cannot.
  const rawP = decision.card_payload
  const p = rawP && typeof rawP === 'object' && !Array.isArray(rawP) ? rawP : {}
  const hasBounds = typeof p.min === 'number' && typeof p.max === 'number'
  const levels = safeArray(p.confidence_levels).filter(
    (l) => l && typeof l === 'object' && !Array.isArray(l) && (typeof l.key === 'string' || typeof l.key === 'number')
  )

  // Malformed/missing payload -> fall back to the plain choice list rather
  // than rendering a broken slider or an empty/unusable button group.
  if (!hasBounds || levels.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const min = p.min
  const max = p.max
  const step = typeof p.step === 'number' ? p.step : 1
  const unit = safeText(p.unit, '')
  const defaultValue = typeof p.default === 'number' ? p.default : min

  const [value, setValue] = React.useState(defaultValue)
  // Both axes require an explicit user interaction, not just the default,
  // before Confirm enables. A slider always has *some* numeric value (its
  // default), so "has a value" can't gate Confirm the way it does for
  // confidence_level_key (which starts genuinely unset); we track touch
  // explicitly so a payload's default point can't silently pass as the
  // user's considered estimate.
  const [valueTouched, setValueTouched] = React.useState(false)
  const [levelKey, setLevelKey] = React.useState(null)

  const canConfirm = valueTouched && levelKey !== null

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsxs('div', {
        className: 'flex flex-col gap-2',
        children: [
          jsx('div', {
            className: 'text-center text-lg font-semibold',
            style: { color: 'var(--ui-accent)' },
            children: `${value}${unit}`,
          }),
          jsx('input', {
            type: 'range',
            min,
            max,
            step,
            value,
            disabled: resolving,
            onChange: (e) => {
              setValue(Number(e.target.value))
              setValueTouched(true)
            },
            className: 'w-full',
          }),
        ],
      }),
      jsxs('div', {
        className: 'flex flex-col gap-1.5',
        children: [
          jsx('div', { className: 'text-[0.7rem] text-(--ui-text-tertiary)', children: 'Confidence' }),
          jsx('div', {
            className: 'flex flex-wrap gap-1.5',
            children: levels.map((l, i) => {
              const key = String(l.key)
              const selected = levelKey === key
              return jsx('button', {
                key,
                type: 'button',
                disabled: resolving,
                onClick: () => setLevelKey(key),
                className: 'rounded-md px-2.5 py-1 text-[0.75rem] transition-colors hover:bg-(--chrome-action-hover)',
                style: {
                  border: `1px solid ${selected ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}`,
                  color: selected ? 'var(--ui-accent)' : undefined,
                  fontWeight: selected ? 600 : 400,
                },
                children: safeText(l.label, key),
              })
            }),
          }),
        ],
      }),
      jsx(ConfirmButton, {
        disabled: !canConfirm,
        resolving,
        onClick: () => {
          const level = levels.find((l) => String(l.key) === levelKey)
          const levelLabel = safeText(level && level.label, levelKey)
          const summary = `${value}${unit} (${levelLabel} confidence)`
          onResolve(decision.id, summary, { value, confidence_level_key: levelKey })
        },
        children: canConfirm ? `Confirm ${value}${unit}` : 'Set value and confidence',
      }),
    ],
  })
}

function WireMatchCard({ decision, onResolve, resolving }) {
  // card_payload: { left: [{ key, label }], right: [{ key, label }] } —
  // click-click 1:1 pairing between two node columns (e.g. services ->
  // owning teams). Ported from decision_hud_prototype.html's drag-style
  // Wire Match card, but reworked as click-then-click (matching this
  // codebase's SequenceOrderCard/BalanceScaleCard idiom of click-based
  // interaction rather than literal HTML5 drag events) with SVG cubic
  // paths drawn between the DOM boxes of paired nodes.
  const payload = decision.card_payload
  const left = safeArray(payload && payload.left)
  const right = safeArray(payload && payload.right)

  const [selectedLeft, setSelectedLeft] = React.useState(null)
  const [links, setLinks] = React.useState({}) // left_key -> right_key
  const [paths, setPaths] = React.useState([])
  const wrapRef = React.useRef(null)
  const leftRefs = React.useRef({})
  const rightRefs = React.useRef({})

  const leftKeyOf = (item, i) => (item && item.key !== undefined && item.key !== null ? safeText(item.key) : `left-${i}`)
  const rightKeyOf = (item, i) => (item && item.key !== undefined && item.key !== null ? safeText(item.key) : `right-${i}`)

  const recalc = React.useCallback(() => {
    if (!wrapRef.current) return
    const wrapRect = wrapRef.current.getBoundingClientRect()
    const next = []
    for (const [lk, rk] of Object.entries(links)) {
      const ln = leftRefs.current[lk]
      const rn = rightRefs.current[rk]
      if (!ln || !rn) continue
      const lr = ln.getBoundingClientRect()
      const rr = rn.getBoundingClientRect()
      const x1 = lr.right - wrapRect.left
      const y1 = lr.top - wrapRect.top + lr.height / 2
      const x2 = rr.left - wrapRect.left
      const y2 = rr.top - wrapRect.top + rr.height / 2
      const mx = (x1 + x2) / 2
      next.push(`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`)
    }
    setPaths(next)
  }, [links])

  React.useEffect(() => {
    recalc()
    if (typeof window === 'undefined') return undefined
    window.addEventListener('resize', recalc)
    return () => window.removeEventListener('resize', recalc)
  }, [recalc])

  if (left.length === 0 || right.length === 0) {
    // malformed/missing payload (absent, non-array, or empty either side)
    // — never dead-end, fall back to the plain choice list.
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const allLinked = left.every((item, i) => links[leftKeyOf(item, i)] !== undefined)

  const handleLeftClick = (key) => {
    setSelectedLeft((prev) => (prev === key ? null : key))
  }

  const handleRightClick = (key) => {
    if (!selectedLeft) return
    setLinks((prev) => ({ ...prev, [selectedLeft]: key }))
    setSelectedLeft(null)
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: 'Click an item on the left, then its match on the right. All items must be wired before confirming.',
      }),
      jsxs('div', {
        ref: wrapRef,
        className: 'relative flex items-stretch justify-between gap-8',
        children: [
          jsx('svg', {
            className: 'pointer-events-none absolute inset-0 h-full w-full overflow-visible',
            children: paths.map((d, i) =>
              jsx('path', { key: i, d, fill: 'none', stroke: 'var(--ui-accent)', strokeWidth: 2 })
            ),
          }),
          jsx('div', {
            className: 'flex flex-1 flex-col gap-2',
            children: left.map((item, i) => {
              const key = leftKeyOf(item, i)
              const done = links[key] !== undefined
              return jsx('button', {
                key,
                type: 'button',
                ref: (el) => { leftRefs.current[key] = el },
                disabled: resolving,
                onClick: () => handleLeftClick(key),
                className: cn(
                  'rounded-md px-2.5 py-1.5 text-left text-[0.8rem] transition-colors',
                  'hover:bg-(--chrome-action-hover) disabled:opacity-50'
                ),
                style: {
                  border: `1px solid ${selectedLeft === key ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}`,
                  opacity: done ? 0.6 : 1,
                },
                children: [safeText(item && item.label, key), done ? jsx('span', { className: 'ml-1.5 text-(--ui-text-tertiary)', children: '●' }) : null],
              })
            }),
          }),
          jsx('div', {
            className: 'flex flex-1 flex-col gap-2',
            children: right.map((item, i) => {
              const key = rightKeyOf(item, i)
              return jsx('button', {
                key,
                type: 'button',
                ref: (el) => { rightRefs.current[key] = el },
                disabled: resolving,
                onClick: () => handleRightClick(key),
                className: cn(
                  'rounded-md px-2.5 py-1.5 text-left text-[0.8rem] transition-colors',
                  'hover:bg-(--chrome-action-hover) disabled:opacity-50'
                ),
                style: { border: '1px solid var(--ui-stroke-secondary)' },
                children: safeText(item && item.label, key),
              })
            }),
          }),
        ],
      }),
      jsx(ConfirmButton, {
        disabled: !allLinked,
        resolving,
        onClick: () => {
          const pairs = left.map((item, i) => {
            const leftKey = leftKeyOf(item, i)
            return { left_key: leftKey, right_key: links[leftKey] }
          })
          const summary = pairs.map((p) => `${p.left_key}→${p.right_key}`).join(', ')
          onResolve(decision.id, summary, { pairs })
        },
        children: 'Confirm mapping',
      }),
    ],
  })
}

function PairwiseDuelCard({ decision, onResolve, resolving }) {
  const rawOptions = safeArray(decision.card_payload && decision.card_payload.options)
  // Coerce + validate: every entry needs at least a usable key; label
  // falls back to the key so a payload with keys-only still renders.
  const seeds = rawOptions
    .map((o, i) => {
      if (!o || typeof o !== 'object') return null
      const key = o.key !== undefined && o.key !== null && o.key !== '' ? safeText(o.key) : null
      if (key === null) return null
      return { key, label: safeText(o.label, key) }
    })
    .filter(Boolean)

  // React hooks must run unconditionally, so seed the reducer-ish state
  // before checking validity — the invalid-payload branch below simply
  // never touches `state`.
  const [state, setState] = React.useState(() => pairwiseDuelInitialState(seeds))

  React.useEffect(() => {
    if (seeds.length < PAIRWISE_DUEL_MIN_OPTIONS) return
    if (state.champion) return
    // Odd contestant left over in this round with no opponent -> bye,
    // advance automatically without waiting for a click.
    if (state.queue.length - state.pairIndex === 1) {
      setState((prev) => pairwiseDuelApplyBye(prev))
    }
  }, [state, seeds.length])

  if (seeds.length < PAIRWISE_DUEL_MIN_OPTIONS) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  if (state.champion) {
    return jsxs('div', {
      className: 'flex flex-col gap-2',
      children: [
        jsx('div', {
          className: 'text-[0.7rem] text-(--ui-text-tertiary)',
          children: `Champion of ${seeds.length} — ${state.log.length} round result(s) below.`,
        }),
        jsx('div', {
          className: 'rounded-md px-2.5 py-2 text-center text-[0.9rem] font-semibold',
          style: { border: '1px solid var(--ui-accent)', color: 'var(--ui-accent)' },
          children: safeText(state.champion.label),
        }),
        jsx('div', {
          className: 'flex flex-col gap-1 text-[0.7rem] text-(--ui-text-tertiary)',
          children: state.log.map((entry, i) =>
            jsx('div', {
              key: `${entry.round}-${i}`,
              children: entry.bye
                ? `Round ${entry.round}: ${entry.winner_key} — bye`
                : `Round ${entry.round}: ${entry.winner_key} beat ${entry.loser_key}`,
            })
          ),
        }),
        jsx(ConfirmButton, {
          disabled: false,
          resolving,
          onClick: () =>
            onResolve(decision.id, safeText(state.champion.label), {
              champion_key: state.champion.key,
              bracket_log: state.log,
            }),
          children: 'Confirm champion',
        }),
      ],
    })
  }

  const a = state.queue[state.pairIndex]
  const b = state.queue[state.pairIndex + 1]

  if (!a || !b) {
    // Transient state between an auto-applied bye and the next render —
    // the useEffect above resolves this on the next tick.
    return jsx('div', {
      className: 'text-[0.75rem] text-(--ui-text-tertiary)',
      children: 'Advancing bye…',
    })
  }

  const remaining = state.queue.length - state.pairIndex
  const totalRemaining = remaining + state.nextRound.length

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: `Round ${state.round} — ${totalRemaining} still standing. Click the winner.`,
      }),
      jsx('div', {
        className: 'grid grid-cols-2 gap-2',
        children: [a, b].map((seed, idx) =>
          jsx('button', {
            key: seed.key,
            type: 'button',
            disabled: resolving,
            onClick: () => setState((prev) => pairwiseDuelApplyWin(prev, idx)),
            className: cn(
              'rounded-md px-2 py-3 text-center text-[0.8rem] font-medium transition-colors',
              'hover:bg-(--chrome-action-hover) disabled:opacity-50'
            ),
            style: { border: '1px solid var(--ui-stroke-secondary)' },
            children: safeText(seed.label),
          })
        ),
      }),
    ],
  })
}

function spiderPolygonPoints(values, cx, cy, r) {
  // values: array of 0..1 radial weights, one per axis, in axis order.
  // Regular N-gon vertex placement via trig, starting at 12 o'clock and
  // going clockwise — same "compute geometry from state, don't hand-author
  // coordinates" spirit as the other SVG-free renderers in this file.
  const n = values.length
  return values
    .map((v, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
      const x = cx + r * v * Math.cos(angle)
      const y = cy + r * v * Math.sin(angle)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

function SpiderCompareCard({ decision, onResolve, resolving }) {
  // card_payload: { option_a: {key,label}, option_b: {key,label},
  //                 axes: [{key,label}, ...] }
  const payload = decision.card_payload && typeof decision.card_payload === 'object' ? decision.card_payload : {}
  const optionA = payload.option_a && typeof payload.option_a === 'object' ? payload.option_a : null
  const optionB = payload.option_b && typeof payload.option_b === 'object' ? payload.option_b : null
  const axes = safeArray(payload.axes).filter((a) => a && typeof a === 'object' && a.key !== undefined && a.key !== null)
  const [picks, setPicks] = React.useState({}) // axis_key -> 'a' | 'b' | 'tie'

  if (!optionA || !optionB || !optionA.key || !optionB.key || axes.length < 3) {
    // Need exactly 2 valid options and at least 3 axes for a sane polygon;
    // anything malformed (missing options, non-array axes, <3 axes) falls
    // back to the plain choice list rather than risking a crash or a
    // degenerate 1-2 vertex "shape".
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const labelA = safeText(optionA.label, safeText(optionA.key))
  const labelB = safeText(optionB.label, safeText(optionB.key))
  const allPicked = axes.every((ax) => picks[ax.key])
  const winsA = axes.filter((ax) => picks[ax.key] === 'a').length
  const winsB = axes.filter((ax) => picks[ax.key] === 'b').length
  const ties = axes.filter((ax) => picks[ax.key] === 'tie').length

  const pick = (axisKey, side) => {
    setPicks((prev) => ({ ...prev, [axisKey]: side }))
  }

  // Radial weight per axis: 1.0 toward the winner, 0.5 for a tie or an
  // as-yet-unpicked axis (keeps the polygon a legible regular shape before
  // all picks are in, rather than snapping to zero).
  const valuesA = axes.map((ax) => {
    const p = picks[ax.key]
    return p === 'a' ? 1 : p === 'b' ? 0 : 0.5
  })
  const valuesB = axes.map((ax) => {
    const p = picks[ax.key]
    return p === 'b' ? 1 : p === 'a' ? 0 : 0.5
  })

  const cx = 100
  const cy = 100
  const r = 78
  const n = axes.length
  const axisLines = axes.map((ax, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n
    const x = cx + r * Math.cos(angle)
    const y = cy + r * Math.sin(angle)
    const lx = cx + (r + 14) * Math.cos(angle)
    const ly = cy + (r + 14) * Math.sin(angle)
    return { key: safeText(ax.key), x1: cx, y1: cy, x2: x, y2: y, lx, ly, label: safeText(ax.label, safeText(ax.key)) }
  })
  const outlinePoints = spiderPolygonPoints(axes.map(() => 1), cx, cy, r)

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: `For each criterion, pick which option wins — or call it a tie. The shape below is a read-only summary, it does not accept clicks.`,
      }),
      jsx('div', {
        className: 'flex justify-center',
        children: jsxs('svg', {
          viewBox: '0 0 200 200',
          width: 180,
          height: 180,
          role: 'img',
          'aria-label': 'Spider comparison chart (read-only summary)',
          children: [
            jsx('polygon', {
              points: outlinePoints,
              fill: 'none',
              stroke: 'var(--ui-stroke-secondary)',
              strokeWidth: 1,
            }),
            ...axisLines.map((al) =>
              jsx('line', {
                key: `spoke-${al.key}`,
                x1: al.x1,
                y1: al.y1,
                x2: al.x2,
                y2: al.y2,
                stroke: 'var(--ui-stroke-secondary)',
                strokeWidth: 1,
              })
            ),
            jsx('polygon', {
              points: spiderPolygonPoints(valuesA, cx, cy, r),
              fill: 'var(--ui-accent)',
              fillOpacity: 0.25,
              stroke: 'var(--ui-accent)',
              strokeWidth: 1.5,
            }),
            jsx('polygon', {
              points: spiderPolygonPoints(valuesB, cx, cy, r),
              fill: 'orange',
              fillOpacity: 0.2,
              stroke: 'orange',
              strokeWidth: 1.5,
            }),
          ],
        }),
      }),
      jsx('div', {
        className: 'flex flex-col gap-1',
        children: axes.map((ax) => {
          const key = safeText(ax.key)
          const label = safeText(ax.label, key)
          const current = picks[key]
          return jsxs('div', {
            key,
            className: 'flex items-center justify-between gap-1 rounded-md px-2 py-1',
            style: { border: '1px solid var(--ui-stroke-secondary)' },
            children: [
              jsx('span', { className: 'text-[0.75rem] flex-1', children: label }),
              jsxs('div', {
                className: 'flex gap-1',
                children: [
                  jsx('button', {
                    type: 'button',
                    disabled: resolving,
                    onClick: () => pick(key, 'a'),
                    className: 'rounded px-1.5 py-0.5 text-[0.65rem] transition-colors hover:bg-(--chrome-action-hover)',
                    style: { border: `1px solid ${current === 'a' ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
                    children: labelA,
                  }),
                  jsx('button', {
                    type: 'button',
                    disabled: resolving,
                    onClick: () => pick(key, 'tie'),
                    className: 'rounded px-1.5 py-0.5 text-[0.65rem] transition-colors hover:bg-(--chrome-action-hover)',
                    style: { border: `1px solid ${current === 'tie' ? 'var(--ui-text-secondary)' : 'var(--ui-stroke-secondary)'}` },
                    children: 'Tie',
                  }),
                  jsx('button', {
                    type: 'button',
                    disabled: resolving,
                    onClick: () => pick(key, 'b'),
                    className: 'rounded px-1.5 py-0.5 text-[0.65rem] transition-colors hover:bg-(--chrome-action-hover)',
                    style: { border: `1px solid ${current === 'b' ? 'orange' : 'var(--ui-stroke-secondary)'}` },
                    children: labelB,
                  }),
                ],
              }),
            ],
          })
        }),
      }),
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: allPicked
          ? `${labelA}: ${winsA}  ·  ${labelB}: ${winsB}  ·  Ties: ${ties}`
          : 'Pick a winner (or tie) for every criterion to see the tally.',
      }),
      jsx(ConfirmButton, {
        disabled: !allPicked,
        resolving,
        onClick: () => {
          const perAxisWinner = Object.fromEntries(axes.map((ax) => [safeText(ax.key), picks[safeText(ax.key)]]))
          const leader = winsA === winsB ? null : winsA > winsB ? labelA : labelB
          const summary = leader
            ? `${leader} wins ${Math.max(winsA, winsB)} of ${axes.length} axes${ties > 0 ? `, ${ties} tie${ties === 1 ? '' : 's'}` : ''}`
            : `${labelA} and ${labelB} tied overall (${winsA}-${winsB})${ties > 0 ? `, ${ties} tie${ties === 1 ? '' : 's'} on individual axes` : ''}`
          onResolve(decision.id, summary, {
            per_axis_winner: perAxisWinner,
            tally: { a: winsA, b: winsB, tie: ties },
            option_a: optionA.key,
            option_b: optionB.key,
            summary,
          })
        },
        children: 'Confirm comparison',
      }),
    ],
  })
}

function VennOverlapCard({ decision, onResolve, resolving }) {
  // card_payload: { set_a: { key, label }, set_b: { key, label }, allow_neither?: bool }
  // Shared-vs-exclusive-membership shape: click A-only / B-only / overlap
  // (and optionally a 4th "neither" zone outside both circles).
  //
  // Region-hit approach: two overlapping <circle>s are drawn as plain
  // visual fill (fully transparent to pointer events via
  // pointer-events:none on the base circles) and THREE separate,
  // purpose-built hit-area shapes are layered on top in z-order:
  //   1. an optional full-card background <rect> for "neither" (bottom)
  //   2. two "-only" hit shapes built with SVG <path> using evenodd
  //      fill-rule (circle minus the other circle's bounding path) so the
  //      overlap sliver is naturally excluded from the -only click areas
  //   3. one small overlap hit <ellipse> centered on the lens intersection
  //      (top), sized to sit inside the visual overlap lens
  // This avoids needing a true circle-circle path intersection formula —
  // the two "-only" paths use evenodd subtraction (self-intersecting path:
  // outer circle other winding order minus inner circle) which SVG computes
  // for us, and the overlap ellipse is a simple visual approximation that's
  // "close enough" to click accurately since it's centered in the lens and
  // sized comfortably smaller than the true lens area. Each of the 3 (or 4)
  // hit shapes has its own onClick — independently clickable, never a
  // shared handler with post-hoc geometry math.
  const rawP = decision.card_payload
  const p = rawP && typeof rawP === 'object' && !Array.isArray(rawP) ? rawP : null
  const setA = p && p.set_a && typeof p.set_a === 'object' ? p.set_a : null
  const setB = p && p.set_b && typeof p.set_b === 'object' ? p.set_b : null
  if (!setA || !setB) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }
  const labelA = safeText(setA.label, safeText(setA.key, 'Set A'))
  const labelB = safeText(setB.label, safeText(setB.key, 'Set B'))
  const allowNeither = p.allow_neither === true

  const W = 260
  const H = 170
  const R = 60
  const cxA = W / 2 - 32
  const cxB = W / 2 + 32
  const cy = H / 2 - 6

  const resolveRegion = (region, label) => {
    onResolve(decision.id, `${label} (${region})`, { selected_region: region, summary: `${label} (${region})` })
  }

  return jsxs('div', {
    className: 'flex flex-col items-center gap-2',
    children: [
      jsxs('svg', {
        viewBox: `0 0 ${W} ${H}`,
        width: '100%',
        style: { maxWidth: 320, userSelect: 'none' },
        children: [
          // 4th "neither" zone: whole-card background rect, bottom of
          // z-order so it only catches clicks outside both circles.
          // Included as a clickable zone (not just implicit) whenever the
          // payload opts in via allow_neither, per the task's "use
          // judgment" call — most venn-style membership questions are
          // exhaustive (A/B/both), so it's opt-in rather than default-on.
          allowNeither
            ? jsx('rect', {
                x: 0,
                y: 0,
                width: W,
                height: H,
                fill: 'transparent',
                style: { cursor: 'pointer' },
                onClick: () => !resolving && resolveRegion('neither', 'Neither'),
              })
            : null,
          // Visual-only circles (no pointer events) purely for the fill/labels.
          jsx('circle', { cx: cxA, cy, r: R, fill: 'var(--ui-accent)', fillOpacity: 0.18, stroke: 'var(--ui-accent)', style: { pointerEvents: 'none' } }),
          jsx('circle', { cx: cxB, cy, r: R, fill: '#e5484d', fillOpacity: 0.18, stroke: '#e5484d', style: { pointerEvents: 'none' } }),
          // A-only hit area: circle A minus circle B, via evenodd subtraction path.
          jsx('path', {
            d: `M ${cxA - R} ${cy} A ${R} ${R} 0 1 0 ${cxA + R} ${cy} A ${R} ${R} 0 1 0 ${cxA - R} ${cy} Z ` +
               `M ${cxB - R} ${cy} A ${R} ${R} 0 1 0 ${cxB + R} ${cy} A ${R} ${R} 0 1 0 ${cxB - R} ${cy} Z`,
            fillRule: 'evenodd',
            fill: 'transparent',
            style: { cursor: 'pointer' },
            onClick: () => !resolving && resolveRegion('a_only', `${labelA} only`),
          }),
          // B-only hit area: circle B minus circle A, via evenodd subtraction path.
          jsx('path', {
            d: `M ${cxB - R} ${cy} A ${R} ${R} 0 1 0 ${cxB + R} ${cy} A ${R} ${R} 0 1 0 ${cxB - R} ${cy} Z ` +
               `M ${cxA - R} ${cy} A ${R} ${R} 0 1 0 ${cxA + R} ${cy} A ${R} ${R} 0 1 0 ${cxA - R} ${cy} Z`,
            fillRule: 'evenodd',
            fill: 'transparent',
            style: { cursor: 'pointer' },
            onClick: () => !resolving && resolveRegion('b_only', `${labelB} only`),
          }),
          // Overlap hit area: small ellipse centered in the lens, on top of
          // both "-only" paths so it wins the click there.
          jsx('ellipse', {
            cx: (cxA + cxB) / 2,
            cy,
            rx: (cxB - cxA) / 2,
            ry: R - 8,
            fill: 'transparent',
            style: { cursor: 'pointer' },
            onClick: () => !resolving && resolveRegion('overlap', `Both ${labelA} and ${labelB}`),
          }),
          jsx('text', { x: cxA - R + 8, y: cy - R - 6, className: 'text-[0.65rem]', fill: 'var(--ui-text-secondary)', children: labelA }),
          jsx('text', { x: cxB - 10, y: cy - R - 6, className: 'text-[0.65rem]', fill: 'var(--ui-text-secondary)', children: labelB }),
        ],
      }),
      jsx('div', {
        className: 'text-[0.65rem] text-(--ui-text-tertiary)',
        children: allowNeither
          ? `Click ${labelA}-only, ${labelB}-only, the overlap, or outside both for neither.`
          : `Click ${labelA}-only, ${labelB}-only, or the overlap.`,
      }),
    ],
  })
}

// size: 'default' (original, used by ModeRadialGaugeCard's larger card
// display) or 'compact' (roughly half the visual footprint, used by
// MetricDial inside the narrow MetricsSidebar). Only rendering constants
// (radius/stroke/viewBox/text size) change between sizes — the arc-angle
// math and the underlying value/fraction are identical either way.
function RadialGaugeDisplay({ value, min, max, unit, size = 'default' }) {
  const compact = size === 'compact'
  const cx = 100
  const cy = 100
  const r = compact ? 78 : 80
  const strokeWidth = compact ? 6 : 12
  const viewBoxHeight = compact ? 50 : 110
  const maxHeight = compact ? '65px' : '140px'
  const valueTextClass = compact ? 'text-[0.6rem] font-semibold' : 'text-[1.1rem] font-semibold'
  const valueTextY = compact ? cy - 4 : cy - 6
  const span = max - min
  const fraction = span > 0 ? Math.min(1, Math.max(0, (value - min) / span)) : 0

  // Angle 180° (left, = min) sweeping down to 0° (right, = max).
  const pointAt = (frac) => {
    const theta = (180 - frac * 180) * (Math.PI / 180)
    return { x: cx + r * Math.cos(theta), y: cy - r * Math.sin(theta) }
  }
  const start = pointAt(0) // min, always the left end of the track
  const end = pointAt(1) // max, always the right end of the track
  const valuePoint = pointAt(fraction)

  // Background track: full 180° semicircle, min -> max.
  // large-arc-flag hardcoded to 0 (sweep is exactly 180°, per the gotcha).
  const trackPath = `M ${start.x} ${start.y} A ${r} ${r} 0 0 1 ${end.x} ${end.y}`
  // Value arc: min -> current value. Sweep is <=180° by construction
  // (fraction is clamped to [0,1] over a fixed 180° span), so
  // large-arc-flag is hardcoded to 0 here too — NEVER computed from
  // fraction/percentage, per the documented pitfall.
  const valuePath = `M ${start.x} ${start.y} A ${r} ${r} 0 0 1 ${valuePoint.x} ${valuePoint.y}`

  return jsxs('svg', {
    viewBox: `0 0 200 ${viewBoxHeight}`,
    className: 'w-full',
    style: { maxHeight },
    children: [
      jsx('path', {
        d: trackPath,
        fill: 'none',
        stroke: 'var(--ui-stroke-secondary)',
        strokeWidth,
        strokeLinecap: 'round',
      }),
      jsx('path', {
        d: valuePath,
        fill: 'none',
        stroke: 'var(--ui-accent)',
        strokeWidth,
        strokeLinecap: 'round',
      }),
      jsx('text', {
        x: cx,
        y: valueTextY,
        textAnchor: 'middle',
        className: valueTextClass,
        fill: 'var(--ui-accent)',
        children: `${safeText(value)}${safeText(unit, '')}`,
      }),
    ],
  })
}

function ModeRadialGaugeCard({ decision, onResolve, resolving }) {
  // card_payload: { modes: [{ key, label, gauge_value, gauge_min, gauge_max, unit? }] }
  const rawModes = safeArray(decision.card_payload && decision.card_payload.modes)
  // Every mode must carry a key/label plus the three numeric gauge fields —
  // a mode missing any of these can't drive the view-only gauge safely, so
  // it's filtered out here rather than crashing mid-render.
  const modes = rawModes.filter(
    (m) =>
      m &&
      typeof m === 'object' &&
      m.key !== undefined &&
      m.key !== null &&
      typeof m.gauge_value === 'number' &&
      isFinite(m.gauge_value) &&
      typeof m.gauge_min === 'number' &&
      isFinite(m.gauge_min) &&
      typeof m.gauge_max === 'number' &&
      isFinite(m.gauge_max)
  )

  const [selectedKey, setSelectedKey] = React.useState(() => (modes[0] ? safeText(modes[0].key) : null))

  if (modes.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const selected = modes.find((m) => safeText(m.key) === selectedKey) || modes[0]

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsx('div', {
        className: 'flex flex-wrap justify-center gap-1.5',
        children: modes.map((m) => {
          const key = safeText(m.key)
          const isActive = key === safeText(selected.key)
          return jsx('button', {
            key,
            type: 'button',
            role: 'radio',
            'aria-checked': isActive,
            disabled: resolving,
            onClick: () => setSelectedKey(key),
            className: cn(
              'rounded-md px-2.5 py-1.5 text-[0.8rem] font-medium transition-colors',
              'hover:bg-(--chrome-action-hover) disabled:opacity-50'
            ),
            style: {
              border: `1px solid ${isActive ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}`,
              color: isActive ? 'var(--ui-accent)' : undefined,
            },
            children: safeText(m.label, key),
          })
        }),
      }),
      // Gauge is a pure display driven by `selected` — it has no onClick,
      // no drag handlers, and no pointer state of its own.
      jsx(RadialGaugeDisplay, {
        value: selected.gauge_value,
        min: selected.gauge_min,
        max: selected.gauge_max,
        unit: selected.unit,
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => {
          const key = safeText(selected.key)
          const label = safeText(selected.label, key)
          const unit = safeText(selected.unit, '')
          onResolve(decision.id, `${label}: ${selected.gauge_value}${unit}`, {
            selected_mode_key: selected.key,
            gauge_value_at_confirm: selected.gauge_value,
          })
        },
        children: `Confirm ${safeText(selected.label, safeText(selected.key))}`,
      }),
    ],
  })
}

function ContextReadoutCard({ decision, onResolve, resolving }) {
  const payload = decision.card_payload
  const variant = payload && payload.variant

  let body = null
  if (variant === 'stat_delta') {
    const value = payload.value
    const delta = payload.delta
    const validValue = typeof value === 'string' || typeof value === 'number'
    if (validValue && isFiniteNumber(delta)) {
      body = jsx(StatDeltaBody, { payload: { label: payload.label, value, delta, unit: payload.unit } })
    }
  } else if (variant === 'sparkline') {
    const points = safeArray(payload.points).filter(isFiniteNumber)
    if (points.length >= 2 && points.length === safeArray(payload.points).length) {
      body = jsx(SparklineBody, { payload: { label: payload.label, points, unit: payload.unit } })
    }
  } else if (variant === 'compare_bars') {
    const rawBars = safeArray(payload && payload.bars)
    const bars = rawBars.filter((b) => b && (typeof b.label === 'string' || typeof b.label === 'number') && isFiniteNumber(b.value))
    if (bars.length > 0 && bars.length === rawBars.length) {
      body = jsx(CompareBarsBody, { payload: { label: payload.label, bars, unit: payload.unit } })
    }
  }

  if (!body) {
    // Malformed/unrecognized variant, or variant-specific fields failed
    // their guard — never crash, fall back to the plain choice list. NOTE:
    // this is an odd fallback for a card that by definition has no
    // decision to make (DefaultChoiceCard will show real clickable
    // "choices" for a context-only row) but it's still strictly better
    // than a blank pane or a thrown error, and matches every other
    // renderer's malformed-payload contract in this file.
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      body,
      jsx(DismissButton, {
        resolving,
        onClick: () => onResolve(decision.id, 'Acknowledged', { acknowledged: true, variant }),
      }),
    ],
  })
}

function TimelinePlacementCard({ decision, onResolve, resolving }) {
  // card_payload: { ticks: [{ key, label }], default_tick_key }
  // Discrete dated track, NOT a continuous scalar (see ScalarSliderCard):
  // the marker only ever lands on one of `ticks`, never an in-between
  // pixel/value. Interaction choice: a native `input[type=range]` whose
  // value is the tick INDEX (min 0, max ticks.length-1, step 1) rather than
  // hand-rolled mousedown/mousemove/mouseup hit-testing — the browser's own
  // range-input drag/keyboard/touch handling already snaps to integer steps
  // for free, so there is no continuous position to round and no custom
  // pointer math that could produce an off-track index. A separate visual
  // track below renders the marker and tick labels at discrete x-positions
  // derived purely from the index (i / (len-1) * 100%), matching the range
  // input's value — the range input IS the drag surface, the track below is
  // the read-only visual representation of the same discrete state.
  const rawP = decision.card_payload
  const p = rawP && typeof rawP === 'object' && !Array.isArray(rawP) ? rawP : {}
  const ticks = safeArray(p.ticks).filter(
    (t) => t && typeof t === 'object' && t.key !== undefined && t.key !== null && t.label !== undefined
  )

  if (ticks.length < 2) {
    // Missing/malformed ticks, or fewer than 2 (nothing meaningful to place
    // onto a track) — never crash, fall back to the plain choice list.
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const defaultIdx = (() => {
    const idx = ticks.findIndex((t) => safeText(t.key) === safeText(p.default_tick_key))
    return idx >= 0 ? idx : 0
  })()
  const [index, setIndex] = React.useState(defaultIdx)
  // Guard against NaN/non-finite index (e.g. a malformed onChange value)
  // before clamping — Math.min/max propagate NaN silently otherwise, which
  // would index the ticks array out of bounds and crash the render below.
  const safeIndex = Number.isFinite(index) ? index : defaultIdx
  const clampedIndex = Math.round(Math.min(Math.max(safeIndex, 0), ticks.length - 1))
  const selected = ticks[clampedIndex]
  const pct = (i) => (ticks.length === 1 ? 0 : (i / (ticks.length - 1)) * 100)

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsx('div', {
        className: 'text-center text-sm font-semibold',
        style: { color: 'var(--ui-accent)' },
        children: safeText(selected.label, safeText(selected.key)),
      }),
      jsxs('div', {
        className: 'relative pt-3 pb-5',
        children: [
          // Track line
          jsx('div', {
            className: 'absolute left-0 right-0 top-1/2 h-0.5 -translate-y-1/2',
            style: { background: 'var(--ui-stroke-secondary)' },
          }),
          // Tick marks + labels, positioned at discrete percentages only
          ...ticks.map((t, i) =>
            jsxs('div', {
              key: safeText(t.key, `tick-${i}`),
              className: 'absolute top-0 flex -translate-x-1/2 flex-col items-center gap-1',
              style: { left: `${pct(i)}%` },
              children: [
                jsx('div', {
                  className: 'h-2 w-0.5',
                  style: { background: 'var(--ui-stroke-secondary)' },
                }),
                jsx('div', {
                  className: 'w-max max-w-[4.5rem] text-center text-[0.6rem] leading-tight text-(--ui-text-tertiary)',
                  children: safeText(t.label, safeText(t.key)),
                }),
              ],
            })
          ),
          // Draggable marker — visual position only ever reads the discrete
          // `clampedIndex`, never a raw pixel/event coordinate.
          jsx('div', {
            className: 'absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full',
            style: { left: `${pct(clampedIndex)}%`, background: 'var(--ui-accent)' },
          }),
        ],
      }),
      jsx('input', {
        type: 'range',
        min: 0,
        max: ticks.length - 1,
        step: 1,
        value: clampedIndex,
        disabled: resolving,
        onChange: (e) => setIndex(Number(e.target.value)),
        className: 'w-full',
        'aria-label': 'Timeline placement',
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => {
          const key = selected.key
          const label = safeText(selected.label, safeText(key))
          onResolve(decision.id, label, { selected_tick_key: key })
        },
        children: `Confirm ${safeText(selected.label, safeText(selected.key))}`,
      }),
    ],
  })
}

function TreePlacementCard({ decision, onResolve, resolving }) {
  const payload = safePlainObject(decision.card_payload) || {}
  const tree = safePlainObject(payload.tree)
  const items = safeArray(payload.items).filter((it) => it && typeof it === 'object' && it.key !== undefined && it.key !== null)

  const leafLabels = React.useMemo(() => {
    const out = {}
    if (tree) collectTreeLeaves(tree, 0, out)
    return out
  }, [tree])

  const [placements, setPlacements] = React.useState({}) // item_key -> leaf key
  const [activeItemKey, setActiveItemKey] = React.useState(null)
  const [expandedKeys, setExpandedKeys] = React.useState(
    () => new Set(tree && tree.key !== undefined && tree.key !== null ? [safeText(tree.key)] : [])
  )

  // Bail to the plain fallback for any malformed/missing shape: no tree
  // object, no key on the root, no reachable leaf categories, or an
  // empty/missing items array. This is checked AFTER the hooks above so
  // hook order stays stable across renders regardless of payload shape.
  const treeValid = !!tree && tree.key !== undefined && tree.key !== null && Object.keys(leafLabels).length > 0
  if (!treeValid || items.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const toggleExpand = (key) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const onPlaceActive = (leafKey) => {
    if (!activeItemKey) return
    setPlacements((prev) => ({ ...prev, [activeItemKey]: leafKey }))
    // advance to the next unplaced item, if any, for a faster placement flow
    const remaining = items.map((it) => safeText(it.key)).filter((k) => k !== activeItemKey && !placements[k])
    setActiveItemKey(remaining.length > 0 ? remaining[0] : null)
  }

  const allPlaced = items.every((it) => !!placements[safeText(it.key)])

  return jsxs('div', {
    className: 'flex flex-col gap-3',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: 'Click an item, then click a leaf category to place it.',
      }),
      jsx('div', {
        className: 'flex flex-wrap gap-1.5',
        children: items.map((it) => {
          const key = safeText(it.key)
          const label = safeText(it.label, key)
          const placedLeaf = placements[key]
          return jsxs('button', {
            type: 'button',
            key,
            disabled: resolving,
            onClick: () => setActiveItemKey(key === activeItemKey ? null : key),
            className: 'flex items-center gap-1 rounded-full px-2 py-1 text-[0.72rem] transition-colors hover:bg-(--chrome-action-hover)',
            style: {
              border: `1px solid ${key === activeItemKey ? 'var(--ui-accent)' : placedLeaf ? 'var(--ui-text-tertiary)' : 'var(--ui-stroke-secondary)'}`,
            },
            children: [
              label,
              placedLeaf ? jsx('span', { className: 'text-(--ui-text-tertiary)', children: `→ ${safeText(leafLabels[placedLeaf], placedLeaf)}` }) : null,
            ],
          })
        }),
      }),
      jsx('div', {
        className: 'flex flex-col gap-1 rounded-md p-1.5',
        style: { border: '1px solid var(--ui-stroke-secondary)' },
        children: jsx(TreeNode, {
          node: tree,
          depth: 0,
          expandedKeys,
          toggleExpand,
          placements,
          leafLabels,
          activeItem: activeItemKey,
          onPlaceActive,
        }),
      }),
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: allPlaced
          ? 'All items placed.'
          : `${items.filter((it) => !!placements[safeText(it.key)]).length}/${items.length} placed.`,
      }),
      jsx(ConfirmButton, {
        disabled: !allPlaced,
        resolving,
        onClick: () => {
          const summary = items
            .map((it) => {
              const key = safeText(it.key)
              const leafKey = placements[key]
              return `${safeText(it.label, key)} → ${safeText(leafLabels[leafKey], leafKey)}`
            })
            .join(', ')
          onResolve(decision.id, summary, { placements })
        },
        children: 'Confirm placement',
      }),
    ],
  })
}

const CARD_RENDERERS = {
  quad_choice: QuadChoiceCard,
  multi_select: MultiSelectCard,
  sequence_order: SequenceOrderCard,
  assemble_pieces: AssemblePiecesCard,
  balance_scale: BalanceScaleCard,
  weighted_allocation: WeightedAllocationCard,
  scalar_slider: ScalarSliderCard,
  zone_select: ZoneSelectCard,
  range_slider: RangeSliderCard,
  anchor_adjust: AnchorAdjustCard,
  wire_match: WireMatchCard,
  sort_to_bin: SortToBinCard,
  matrix_2x2: Matrix2x2Card,
  stacked_bar_split: StackedBarSplitCard,
  pairwise_duel: PairwiseDuelCard,
  spider_compare: SpiderCompareCard,
  venn_overlap: VennOverlapCard,
  mode_radial_gauge: ModeRadialGaugeCard,
  context_readout: ContextReadoutCard,
  timeline_placement: TimelinePlacementCard,
  tree_placement: TreePlacementCard,
  confidence_rating: ConfidenceRatingCard,
  constrained_budget_split: ConstrainedBudgetSplitCard,
}

// CardErrorBoundary: isolates a single card's render exception so a
// malformed/adversarial decision row (bad DB row, bad MCP push, future
// card_type bug) cannot take down the whole Decision HUD pane — every other
// card in the queue, including a batch_approval gate card, keeps rendering
// and stays actionable. Deliberately renders NO action buttons in the
// fallback (not even the plain choice list) so a decision whose payload
// blew up mid-render can never surface an "approve" (or any other) click
// target — the malformed row is surfaced read-only until fixed at the
// source.
class CardErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[decision-hud] card render error', this.props.decisionId, error, info)
  }

  render() {
    if (this.state.hasError) {
      return jsxs('div', {
        className: 'flex flex-col gap-1 rounded-md px-2.5 py-2 text-[0.75rem]',
        style: { border: '1px dashed var(--ui-danger, #e5484d)', color: 'var(--ui-danger, #e5484d)' },
        children: [
          jsx('div', { className: 'font-medium', children: '⚠ Malformed decision data' }),
          jsx('div', {
            className: 'text-(--ui-text-tertiary)',
            children: 'This card could not be rendered safely and has been isolated. No action was taken. Check the underlying decision row.',
          }),
        ],
      })
    }
    return this.props.children
  }
}

function DecisionCard({ decision, onResolve, onDefer, onDiscuss, onDismiss, resolving }) {
  const Body = CARD_RENDERERS[decision.card_type] || DefaultChoiceCard
  const isContextReadout = decision.card_type === 'context_readout'
  return jsxs('div', {
    className: cn(
      'flex flex-col gap-3 rounded-lg border p-4',
      isContextReadout ? '' : 'border-(--ui-stroke-secondary)'
    ),
    // Dashed border for Context Readout distinguishes it at a glance from
    // every solid-bordered real decision card in the stack.
    style: isContextReadout ? { border: '1px dashed var(--ui-stroke-secondary)' } : undefined,
    children: [
      jsx(CardHeader, { decision, onDismiss, resolving }),
      isContextReadout ? jsx(ContextReadoutTag, {}) : null,
      jsx(CardQuestion, { decision }),
      jsx(CardErrorBoundary, { decisionId: decision && decision.id, children: jsx(Body, { decision, onResolve, resolving }) }),
      // Shared across every card type (present vs future) — deliberately
      // outside Body so a new CARD_RENDERERS entry gets Defer/Discuss for
      // free without having to remember to wire them per-renderer. Dismiss
      // now lives in the header row (top-right, next to urgency) instead of
      // here; this row is right-aligned so Discuss/Defer sit flush right.
      // Discuss precedes Defer (owner-requested swap of the original
      // Defer-then-Discuss order).
      jsxs('div', {
        className: 'flex items-center justify-end gap-2',
        children: [
          jsx(DiscussButton, { disabled: resolving, onClick: () => onDiscuss(decision) }),
          jsx(DeferButton, { disabled: resolving, onClick: () => onDefer(decision.id) }),
        ],
      }),
    ],
  })
}

function useBoardSettings(boardSlug) {
  // Fetches dispatch_enabled/auto_decompose_enabled/review_dispatch_enabled for
  // one board. The installed CLI's `hermes kanban boards show` takes NO slug
  // argument and NO --json flag (it only prints the currently-active board
  // slug as plain text) — that API drifted out from under this plugin, which
  // used to call `boards show <slug> --json`. `boards list --json` still
  // returns the full per-board object including these fields, so filter that
  // instead of relying on the (now argument-less) `show` subcommand. Only
  // fetches when boardSlug is a real slug (never for "All" — selectedBoard
  // === null).
  const [state, setState] = React.useState({ settings: null, loading: false, error: null })

  const refresh = React.useCallback(async () => {
    if (!boardSlug) {
      setState({ settings: null, loading: false, error: null })
      return
    }
    setState((s) => ({ ...s, loading: true }))
    try {
      const boards = await cliExec(['kanban', 'boards', 'list', '--json'])
      const res = (Array.isArray(boards) ? boards : []).find((b) => b && b.slug === boardSlug)
      if (!res) {
        throw new Error(`board '${boardSlug}' not found in boards list`)
      }
      setState({
        settings: {
          dispatch_enabled: res.dispatch_enabled !== false,
          auto_decompose_enabled: res.auto_decompose_enabled !== false,
          review_dispatch_enabled: res.review_dispatch_enabled !== false,
        },
        loading: false,
        error: null,
      })
    } catch (e) {
      setState({ settings: null, loading: false, error: String(e.message || e) })
    }
  }, [boardSlug])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  return { ...state, refresh }
}

const BOARD_SETTINGS_FIELDS = [
  { key: 'dispatch_enabled', verb: 'set-dispatch', label: 'Dispatch' },
  { key: 'auto_decompose_enabled', verb: 'set-auto-decompose', label: 'Auto-decompose' },
  { key: 'review_dispatch_enabled', verb: 'set-review-dispatch', label: 'Review-dispatch' },
]

function ToggleSwitch({ checked, disabled, onClick, label }) {
  return jsx(Switch, {
    'aria-label': label,
    checked,
    disabled,
    size: 'xs',
    onCheckedChange: onClick,
  })
}

function BoardSettingsPanel({ boardSlug }) {
  // Per-board settings: dispatch_enabled / auto_decompose_enabled /
  // review_dispatch_enabled, added in commit 57803b97f3 (hermes kanban
  // boards set-dispatch / set-auto-decompose / set-review-dispatch).
  // Renders nothing for "All" (boardSlug === null) — this is a per-board
  // panel, not a global settings view.
  const { settings, loading, error, refresh } = useBoardSettings(boardSlug)
  const [pending, setPending] = React.useState(null) // field key currently in flight
  const [optimistic, setOptimistic] = React.useState(null) // local override while a toggle is in flight

  React.useEffect(() => {
    setOptimistic(null)
  }, [boardSlug])

  if (!boardSlug) return null

  const effective = optimistic || settings
  // Toggles reflect and let the user change per-field dispatch state UNLESS
  // the emergency stop is active (all three off) — while stopped, disable
  // (grey out) the toggles instead of letting them individually re-enable
  // dispatch out from under the E-stop; releasing E-stop restores whatever
  // combination was running before (see EmergencyStopButton), not "all on".
  const estopped = !!effective && !effective.dispatch_enabled && !effective.auto_decompose_enabled && !effective.review_dispatch_enabled

  const handleToggle = async (field) => {
    if (!effective || pending || estopped) return
    const nextVal = !effective[field.key]
    haptic('tap')
    setPending(field.key)
    setOptimistic({ ...effective, [field.key]: nextVal })
    try {
      await cliExec(['kanban', 'boards', field.verb, boardSlug, nextVal ? 'on' : 'off'])
      host.notify({ kind: 'success', message: `${field.label} ${nextVal ? 'enabled' : 'disabled'} for ${boardSlug}` })
      await refresh()
      setOptimistic(null)
    } catch (e) {
      // rollback
      setOptimistic(null)
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setPending(null)
    }
  }

  // Layout-shift fix: switching boards refetches settings for the new
  // board, and useBoardSettings keeps the PREVIOUS board's settings in
  // place while that fetch is in flight (loading: true, settings: stale).
  // The old version rendered a "…" text node ahead of the toggle row only
  // while `loading` was true and removed it once the fetch resolved — that
  // insert/remove on every single board switch is exactly what made the
  // toggles visibly slide left and right (confirmed live via screenshot: a
  // network round-trip on every switch, so the shift was reliably
  // reproducible, not an occasional flicker). Fix: only show the "…"
  // placeholder when there is NO settings data at all yet (first mount for
  // a board this panel has never fetched); once `effective` exists, keep
  // the toggle row mounted at a stable width and dim it in place while a
  // refetch is in flight, never insert/remove a sibling node for loading.
  const showInitialLoadingPlaceholder = loading && !effective

  return jsxs('div', {
    className: 'flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[0.7rem]',
    children: [
      error
        ? jsx('span', { className: 'text-(--ui-danger,#e5484d)', children: 'settings error' })
        : showInitialLoadingPlaceholder
          ? jsx('span', { className: 'text-(--ui-text-tertiary)', children: '…' })
          : null,
      effective
        ? jsx('div', {
            className: cn('flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1', loading && 'opacity-50'),
            children: BOARD_SETTINGS_FIELDS.map((field) =>
              jsxs('div', {
                key: field.key,
                className: 'flex shrink-0 items-center gap-1.5',
                children: [
                  jsx(ToggleSwitch, {
                    checked: !!effective[field.key],
                    disabled: pending !== null || estopped,
                    label: field.label,
                    onClick: () => handleToggle(field),
                  }),
                  jsx('span', { className: cn('text-(--ui-text-secondary)', estopped && 'opacity-40'), children: field.label }),
                ],
              })
            ),
          })
        : null,
    ],
  })
}

// EmergencyStopButton: one-click kill switch for all dispatch on a board.
// Sits left of the settings gear in the header (see mainColumn below).
// Off state = neutral icon button matching Settings' styling; pressed
// (all three dispatch toggles off) = solid red so the halted state is
// unmistakable at a glance.
function EmergencyStopButton({ boardSlug }) {
  const { settings } = useBoardSettings(boardSlug)
  const [pending, setPending] = React.useState(false)
  const preEstopRef = React.useRef(null)

  if (!boardSlug || !settings) return null

  const estopOn = !settings.dispatch_enabled && !settings.auto_decompose_enabled && !settings.review_dispatch_enabled

  const handleClick = async () => {
    if (pending) return
    const confirmMsg = estopOn
      ? `Resume dispatch for ${boardSlug}? This restores whichever toggles were on before the stop.`
      : `Emergency stop ${boardSlug}? This halts dispatch, auto-decompose, and review-dispatch immediately.`
    if (typeof window !== 'undefined' && window.confirm && !window.confirm(confirmMsg)) return
    haptic('tap')
    setPending(true)
    const target = estopOn
      ? (preEstopRef.current || { dispatch_enabled: true, auto_decompose_enabled: true, review_dispatch_enabled: true })
      : { dispatch_enabled: false, auto_decompose_enabled: false, review_dispatch_enabled: false }
    if (!estopOn) preEstopRef.current = { ...settings }
    try {
      await Promise.all(BOARD_SETTINGS_FIELDS.map((field) =>
        target[field.key] !== settings[field.key]
          ? cliExec(['kanban', 'boards', field.verb, boardSlug, target[field.key] ? 'on' : 'off'])
          : null
      ))
      host.notify({ kind: estopOn ? 'success' : 'error', message: estopOn ? `Dispatch resumed for ${boardSlug}` : `EMERGENCY STOP: all dispatch halted for ${boardSlug}` })
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setPending(false)
    }
  }

  return jsx('button', {
    type: 'button',
    'aria-label': estopOn ? 'Resume dispatch' : 'Emergency stop: halt all dispatch',
    title: estopOn ? 'Resume dispatch' : 'Emergency stop: halt all dispatch',
    onClick: handleClick,
    disabled: pending,
    className: cn(
      'flex h-6 items-center gap-1 rounded border px-2 text-[0.7rem] font-medium disabled:opacity-50',
      estopOn
        ? 'border-(--ui-danger,#e5484d) bg-(--ui-danger,#e5484d) text-white hover:opacity-90'
        : 'border-(--ui-stroke-secondary) text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)'
    ),
    children: jsx('span', { children: 'Emergency Stop' }),
  })
}

// Pure — no React/host dependency — sorts boards by pending-decision count
// descending (ties broken by original relative order, i.e. a stable sort;
// Array.prototype.sort is stable per spec since ES2019). `pendingBySlug` is
// keyed by board slug (not project_id) since that's what BoardSelector's
// caller already has on hand per-board; a board missing from the map (zero
// pending decisions — `decision projects` only returns projects with >=1
// pending row) sorts as pending: 0.
function sortBoardsByPending(boards, pendingBySlug) {
  if (!Array.isArray(boards)) return []
  return boards
    .map((b, i) => ({ b, i, pending: (pendingBySlug && pendingBySlug[b.slug]) || 0 }))
    .sort((x, y) => (y.pending - x.pending) || (x.i - y.i))
    .map((entry) => entry.b)
}

// Pending-decision counts per board, keyed by slug. Reuses the same
// `hermes decision projects` CLI verb useDecisionQueue already calls (see
// db.py list_projects() — one row per project_id with a pending count),
// joined onto each board's own project_id so BoardSelector can index by
// slug without knowing about decision-hud "projects" as a separate concept.
function usePendingDecisionCounts(boards) {
  const [state, setState] = React.useState({ pendingBySlug: {}, loading: true, error: null })

  const refresh = React.useCallback(async () => {
    try {
      const res = await cliExec(['decision', 'projects'])
      const projects = (res && res.projects) || []
      const pendingByProjectId = {}
      for (const p of projects) {
        if (p && p.project_id) pendingByProjectId[p.project_id] = p.pending || 0
      }
      const pendingBySlug = {}
      for (const b of boards) {
        if (b && b.slug && b.project_id) {
          pendingBySlug[b.slug] = pendingByProjectId[b.project_id] || 0
        }
      }
      setState({ pendingBySlug, loading: false, error: null })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }))
    }
  }, [boards])

  React.useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  return state.pendingBySlug
}

function BoardSelector({ boards, active, onSelect }) {
  const pendingBySlug = usePendingDecisionCounts(boards)
  const sortedBoards = React.useMemo(() => sortBoardsByPending(boards, pendingBySlug), [boards, pendingBySlug])
  const value = active || (sortedBoards.length > 0 ? sortedBoards[0].slug : '')
  return jsx(Select, {
    value,
    disabled: sortedBoards.length === 0,
    onValueChange: onSelect,
    children: [
      jsx(SelectTrigger, {
        'aria-label': 'Board',
        // w-40 alone doesn't clip: SelectValue's text has no truncate class,
        // so a long project name (e.g. "Scholastic Context Engineering")
        // forces the trigger button to grow past w-40 despite shrink-0 —
        // the flex row then overflows the header and the sibling label to
        // its left (Dispatch toggle) gets clipped by the pane's edge. min-w-0
        // on the trigger lets it actually shrink to w-40, and truncate on
        // the value span ellipsizes instead of forcing width.
        className: 'w-40 min-w-0 shrink-0 overflow-hidden',
        children: jsx(SelectValue, { className: 'block min-w-0 flex-1 truncate text-left' }),
      }),
      jsx(SelectContent, {
        children: sortedBoards.map((b) => {
          const pending = pendingBySlug[b.slug] || 0
          return jsx(SelectItem, {
            key: b.slug,
            value: b.slug,
            children: jsxs('div', {
              className: 'flex w-full items-center justify-between gap-2',
              children: [
                jsx('span', { className: 'truncate', children: b.name || b.slug }),
                pending > 0
                  ? jsx(Badge, { variant: 'success', size: 'xs', children: String(pending) })
                  : null,
              ],
            }),
          })
        }),
      }),
    ],
  })
}

const GRID_LAYOUT_STORAGE_KEY = 'decision-hud:grid-layout'
const GRID_MIN = 1
const GRID_MAX = 3

const SIDEBAR_SETTINGS_STORAGE_KEY = 'decision-hud:sidebar-settings'
const SIDEBAR_WIDTH_MIN = 140
const SIDEBAR_WIDTH_MAX = 320
const SIDEBAR_WIDTH_DEFAULT = 200
const DIAL_COLS_MIN = 1
const DIAL_COLS_MAX = 2

// Pane placement: workspace panels this plugin (and the sibling task-list
// plugin) register can live docked to the right of chat (the original
// layout) or as a session-zone tab beside SESSIONS/BOTS (same mechanism as
// the Kanban Bots pane) — the user's choice, not a fixed decision. Shared
// localStorage key so task-list's plugin.js (a separate blob-loaded file,
// no shared JS module scope) reads the same setting this Layout tab writes.
// Registration (ctx.register in each plugin's register()) runs once at
// plugin load, so a change here only takes effect after "Reload desktop
// plugins" — same constraint as any other registration-time plugin config.
const PANE_PLACEMENT_STORAGE_KEY = 'decision-hud:pane-placement'
const DEFAULT_PANE_PLACEMENT = { decisionHud: 'session-tab', agentDashboard: 'session-tab', taskList: 'session-tab' }

function loadPanePlacement() {
  try {
    const raw = localStorage.getItem(PANE_PLACEMENT_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_PANE_PLACEMENT }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PANE_PLACEMENT }
    const pick = (v) => (v === 'session-tab' ? 'session-tab' : 'right')
    return {
      decisionHud: pick(parsed.decisionHud),
      agentDashboard: pick(parsed.agentDashboard),
      taskList: pick(parsed.taskList),
    }
  } catch {
    return { ...DEFAULT_PANE_PLACEMENT }
  }
}

function savePanePlacement(settings) {
  try {
    localStorage.setItem(PANE_PLACEMENT_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // best-effort persistence only, matches saveSidebarSettings above
  }
}

// paneRegistrationData: turns a placement choice into the `data` object
// ctx.register expects — 'right' is the original right-docked-column shape,
// 'session-tab' is the Bots-pane shape (dock into the sessions zone as a
// center tab).
function paneRegistrationData(placement) {
  return placement === 'session-tab'
    ? { placement: 'left', width: '260px', collapsible: true, hideOnly: true, dock: { pane: 'sessions', pos: 'center', enforce: true } }
    : { placement: 'right', dock: { pane: 'workspace', pos: 'right' }, minWidth: '26rem' }
}

const PANE_PLACEMENT_OPTIONS = [
  { value: 'right', label: 'Docked (right of chat)' },
  { value: 'session-tab', label: 'Session tab' },
]

const DISMISSED_PANES_STORAGE_KEY = 'hermes.desktop.dismissedPanes.v1'

function resetDismissedPanes() {
  try {
    localStorage.removeItem(DISMISSED_PANES_STORAGE_KEY)
    host.notify({ kind: 'info', message: 'Dismissed panes cleared. Restart the app (not just Reload desktop plugins) to bring them back.' })
  } catch {
    host.notify({ kind: 'error', message: 'Could not clear dismissed panes — localStorage unavailable.' })
  }
}

function PanePlacementControls() {
  const [placement, setPlacement] = React.useState(loadPanePlacement)

  const update = (key, value) => {
    const next = { ...placement, [key]: value }
    setPlacement(next)
    savePanePlacement(next)
    host.notify({ kind: 'info', message: 'Reload desktop plugins to apply the new pane placement' })
  }

  const row = (key, label) =>
    jsxs('div', {
      key,
      className: 'flex items-center justify-between gap-3',
      children: [
        jsx('span', { className: 'text-[0.75rem] text-(--ui-text-secondary)', children: label }),
        jsxs(Select, {
          value: placement[key],
          onValueChange: (v) => update(key, v),
          children: [
            jsx(SelectTrigger, { className: 'h-7 w-44 text-[0.75rem]', children: jsx(SelectValue, {}) }),
            jsx(SelectContent, {
              children: PANE_PLACEMENT_OPTIONS.map((o) => jsx(SelectItem, { value: o.value, children: o.label }, o.value)),
            }),
          ],
        }),
      ],
    })

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', { className: 'text-sm font-medium', children: 'Pane placement' }),
      jsx('div', {
        className: 'text-[0.75rem] text-(--ui-text-secondary)',
        children: 'Docked pins the pane beside chat; session tab adds it next to SESSIONS/BOTS instead.',
      }),
      row('decisionHud', 'Decision HUD'),
      row('agentDashboard', 'Agent Dashboard / Metrics'),
      row('taskList', 'Task List'),
      jsx(Button, {
        variant: 'outline',
        size: 'xs',
        className: 'mt-1 w-fit',
        onClick: resetDismissedPanes,
        children: 'Reset dismissed panes',
      }),
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-secondary)',
        children: 'If a pane was ever closed by hand, it stays hidden until you clear this — placement changes alone won\u2019t bring it back.',
      }),
    ],
  })
}

const DEFAULT_SIDEBAR_SETTINGS = { side: 'left', widthPx: SIDEBAR_WIDTH_DEFAULT, dialCols: 1 }

// loadSidebarSettings/saveSidebarSettings: side (left/right), widthPx (the
// sidebar's max-width cap in px, replacing the old hardcoded 200), and
// dialCols (metric-dial grid column count) all live in one small settings
// object, same persistence pattern as loadGridLayout/saveGridLayout above.
function loadSidebarSettings() {
  try {
    const raw = localStorage.getItem(SIDEBAR_SETTINGS_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SIDEBAR_SETTINGS }
    const parsed = JSON.parse(raw)
    // parsed can legally be `null` here (`JSON.parse("null")` succeeds and
    // returns null, it does not throw) — property access on it (parsed.side
    // below) DOES throw, "Cannot read properties of null (reading 'side')",
    // which is exactly the live crash reported ("decision-hud:pane" failed
    // to render). Guard the object shape up front instead of relying on the
    // outer try/catch to paper over a null/non-object parse result.
    const safeParsed = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    const side = safeParsed.side === 'right' ? 'right' : 'left'
    const widthPx = Number.isFinite(safeParsed.widthPx)
      ? Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, safeParsed.widthPx))
      : SIDEBAR_WIDTH_DEFAULT
    const dialCols = Number.isInteger(safeParsed.dialCols)
      ? Math.min(DIAL_COLS_MAX, Math.max(DIAL_COLS_MIN, safeParsed.dialCols))
      : 1
    return { side, widthPx, dialCols }
  } catch {
    return { ...DEFAULT_SIDEBAR_SETTINGS }
  }
}

function saveSidebarSettings(settings) {
  try {
    localStorage.setItem(SIDEBAR_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // best-effort — a failed localStorage write just means these settings
    // reset to default next session, never a crash (same as saveGridLayout).
  }
}

function loadGridLayout() {
  try {
    const raw = localStorage.getItem(GRID_LAYOUT_STORAGE_KEY)
    if (!raw) return { cols: 1, rows: 3 }
    const parsed = JSON.parse(raw)
    const cols = Number.isInteger(parsed.cols) ? Math.min(GRID_MAX, Math.max(GRID_MIN, parsed.cols)) : 1
    const rows = Number.isInteger(parsed.rows) ? Math.min(GRID_MAX, Math.max(GRID_MIN, parsed.rows)) : 3
    return { cols, rows }
  } catch {
    return { cols: 1, rows: 3 }
  }
}

function saveGridLayout(layout) {
  try {
    localStorage.setItem(GRID_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // best-effort — a failed localStorage write (private mode, quota) just
    // means the layout resets to default next session, never a crash.
  }
}

// GridLayoutControls: a static (not resizable-by-drag) NxM picker, 1-3 cols
// x 1-3 rows, persisted across sessions. "Static" per the owner's request —
// this sets a fixed grid shape, it does not add drag-to-resize panes.
function GridLayoutControls({ layout, onChange }) {
  const stepper = (label, key, value) =>
    jsxs('div', {
      className: 'flex items-center gap-1',
      children: [
        jsx('span', { className: 'text-[0.65rem] text-(--ui-text-tertiary)', children: label }),
        jsx('button', {
          type: 'button',
          disabled: value <= GRID_MIN,
          onClick: () => onChange({ ...layout, [key]: Math.max(GRID_MIN, value - 1) }),
          className: 'h-5 w-5 rounded border border-(--ui-stroke-secondary) text-[0.7rem] disabled:opacity-30',
          children: '−',
        }),
        jsx('span', { className: 'w-3 text-center text-[0.7rem] tabular-nums', children: value }),
        jsx('button', {
          type: 'button',
          disabled: value >= GRID_MAX,
          onClick: () => onChange({ ...layout, [key]: Math.min(GRID_MAX, value + 1) }),
          className: 'h-5 w-5 rounded border border-(--ui-stroke-secondary) text-[0.7rem] disabled:opacity-30',
          children: '+',
        }),
      ],
    })
  return jsxs('div', {
    className: 'flex items-center gap-3 text-(--ui-text-secondary)',
    children: [
      jsx('span', { className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: 'Grid' }),
      stepper('cols', 'cols', layout.cols),
      stepper('rows', 'rows', layout.rows),
    ],
  })
}


// SidebarPositionControls: left/right toggle + width stepper for the
// metrics sidebar, persisted via loadSidebarSettings/saveSidebarSettings.
function SidebarPositionControls({ settings, onChange }) {
  return jsxs('div', {
    className: 'flex items-center gap-3 text-(--ui-text-secondary)',
    children: [
      jsx('span', { className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: 'Sidebar' }),
      jsxs('div', {
        className: 'flex items-center gap-1',
        children: [
          jsx('button', {
            type: 'button',
            'aria-label': 'Sidebar left',
            onClick: () => onChange({ ...settings, side: 'left' }),
            className: `h-5 rounded border px-1.5 text-[0.65rem] ${settings.side === 'left' ? 'border-(--ui-accent) text-(--ui-accent)' : 'border-(--ui-stroke-secondary)'}`,
            children: 'Left',
          }),
          jsx('button', {
            type: 'button',
            'aria-label': 'Sidebar right',
            onClick: () => onChange({ ...settings, side: 'right' }),
            className: `h-5 rounded border px-1.5 text-[0.65rem] ${settings.side === 'right' ? 'border-(--ui-accent) text-(--ui-accent)' : 'border-(--ui-stroke-secondary)'}`,
            children: 'Right',
          }),
        ],
      }),
      jsxs('div', {
        className: 'flex items-center gap-1',
        children: [
          jsx('button', {
            type: 'button',
            disabled: settings.widthPx <= SIDEBAR_WIDTH_MIN,
            onClick: () => onChange({ ...settings, widthPx: Math.max(SIDEBAR_WIDTH_MIN, settings.widthPx - 20) }),
            className: 'h-5 w-5 rounded border border-(--ui-stroke-secondary) text-[0.7rem] disabled:opacity-30',
            children: '−',
          }),
          jsx('span', { className: 'w-9 text-center text-[0.65rem] tabular-nums', children: `${settings.widthPx}px` }),
          jsx('button', {
            type: 'button',
            disabled: settings.widthPx >= SIDEBAR_WIDTH_MAX,
            onClick: () => onChange({ ...settings, widthPx: Math.min(SIDEBAR_WIDTH_MAX, settings.widthPx + 20) }),
            className: 'h-5 w-5 rounded border border-(--ui-stroke-secondary) text-[0.7rem] disabled:opacity-30',
            children: '+',
          }),
        ],
      }),
    ],
  })
}

// DialGridControls: grid-select (1 or 2 columns) for the metric dials'
// layout inside MetricsSidebar — distinct from GridLayoutControls, which
// controls the decision-card grid in the main column, not the dials.
function DialGridControls({ settings, onChange }) {
  return jsxs('div', {
    className: 'flex items-center gap-2 text-(--ui-text-secondary)',
    children: [
      jsx('span', { className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: 'Dials' }),
      jsx('div', {
        className: 'flex items-center gap-1',
        children: [DIAL_COLS_MIN, DIAL_COLS_MAX].map((n) =>
          jsx('button', {
            key: n,
            type: 'button',
            'aria-label': `${n} column${n > 1 ? 's' : ''}`,
            onClick: () => onChange({ ...settings, dialCols: n }),
            className: `h-5 rounded border px-1.5 text-[0.65rem] ${settings.dialCols === n ? 'border-(--ui-accent) text-(--ui-accent)' : 'border-(--ui-stroke-secondary)'}`,
            children: `${n}col`,
          })
        ),
      }),
    ],
  })
}


// SettingsPopover: small anchored dropdown/panel opened from the gear icon
// in the DecisionHudPane header. Deliberately generic ("settings panel with
// sections") so future settings can be added as additional labeled section
// divs — grid size, sidebar position/width, and dial grid are the sections
// today.
function SettingsPopover({ layout, onGridChange, sidebarSettings, onSidebarChange, onOpenFullscreen }) {
  return jsx('div', {
    // the old --ui-surface-primary token used here was not a real theme token (checked against
    // apps/desktop/src/styles.css — it doesn't exist), so it resolved to
    // transparent: the popover had no real background and the board
    // selector row underneath bled straight through its text, exactly the
    // "GRID SIZE / Shattered Flames Client" overlap the owner reported.
    // --ui-bg-elevated is the real token this app uses for floating
    // panels/drawers over other content (see kanban/drawer.tsx, the
    // layout-picker preset menu).
    className:
      'absolute right-0 top-full z-10 mt-1 w-max rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-2 shadow-lg',
    children: jsxs('div', {
      className: 'flex flex-col gap-2',
      children: [
        jsx('div', {
          className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)',
          children: 'Grid size',
        }),
        jsx(GridLayoutControls, { layout, onChange: onGridChange }),
        jsx(SidebarPositionControls, { settings: sidebarSettings, onChange: onSidebarChange }),
        jsx('div', { className: 'my-1 border-t border-(--ui-stroke-secondary)' }),
        jsx('button', {
          type: 'button',
          onClick: onOpenFullscreen,
          className:
            'h-6 rounded border border-(--ui-stroke-secondary) px-2 text-[0.7rem] text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)',
          children: 'All settings…',
        }),
      ],
    }),
  })
}


// --- Fullscreen Settings overlay ------------------------------------------
//
// Opened via the gear icon's "All settings…" row (or directly, see the gear
// onClick below). Covers the whole app window like a game's pause menu —
// position: fixed + inset-0 + a high z-index, no portal needed since this
// plugin's render tree already sits at the top of the pane's DOM subtree
// and `fixed` escapes any ancestor's overflow/clipping regardless.
// Tabs are plain client-side state; "Subagent Rules" is the first real tab,
// wired to `hermes decision settings-get/settings-set` (subagent skill
// injection: the pre_tool_call hook in this plugin's own __init__.py).
function useSubagentRuleSettings() {
  const [state, setState] = React.useState({ loading: true, enabled: true, rule: '', error: null })
  const refresh = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const res = await cliExec(['decision', 'settings-get'])
      const s = (res && res.settings) || {}
      setState({
        loading: false,
        enabled: s.subagent_inject_enabled !== '0',
        rule: s.subagent_inject_rule || '',
        error: null,
      })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }))
    }
  }, [])
  React.useEffect(() => { refresh() }, [refresh])
  const save = React.useCallback(async (key, value) => {
    await cliExec(['decision', 'settings-set', key, value])
  }, [])
  return { ...state, refresh, save }
}

function useUniversalSkills() {
  const [state, setState] = React.useState({ available: [], selected: [], loading: true, error: null })

  const refresh = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const [catalog, settings] = await Promise.all([
        host.request('skills.manage', { action: 'list' }),
        cliExec(['decision', 'settings-get']),
      ])
      const grouped = catalog && catalog.skills && typeof catalog.skills === 'object' && !Array.isArray(catalog.skills) ? catalog.skills : {}
      const available = [...new Set(Object.values(grouped).flat().filter((name) => typeof name === 'string'))].sort()
      let selected = []
      try {
        const parsed = JSON.parse(settings?.settings?.subagent_inject_skills || '[]')
        selected = Array.isArray(parsed) ? parsed.filter((name) => available.includes(name)) : []
      } catch {
        selected = []
      }
      setState({ available, selected, loading: false, error: null })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }))
    }
  }, [])

  React.useEffect(() => { refresh() }, [refresh])

  const save = React.useCallback(async (selected) => {
    await cliExec(['decision', 'settings-set', 'subagent_inject_skills', JSON.stringify(selected)])
    setState((s) => ({ ...s, selected }))
  }, [])

  return { ...state, refresh, save }
}

// useKanbanEscalationScope: persisted 3-way scope for which kanban_block()/
// kanban_request_review() calls auto-push a Decision HUD card. Same
// settings-get/settings-set bridge as useSubagentRuleSettings, so the value
// is owner-changeable from the pane without touching skill/code files.
function useKanbanEscalationScope() {
  const [state, setState] = React.useState({ loading: true, scope: 'needs_input', error: null })
  const refresh = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const res = await cliExec(['decision', 'settings-get'])
      const s = (res && res.settings) || {}
      setState({
        loading: false,
        scope: s.kanban_escalation_bridge_scope || 'needs_input',
        error: null,
      })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }))
    }
  }, [])
  React.useEffect(() => { refresh() }, [refresh])
  const save = React.useCallback(async (scope) => {
    await cliExec(['decision', 'settings-set', 'kanban_escalation_bridge_scope', scope])
    setState((s) => ({ ...s, scope }))
  }, [])
  return { ...state, refresh, save }
}

const KANBAN_ESCALATION_SCOPE_OPTIONS = [
  { value: 'off', label: 'Off', description: 'Never auto-push a Decision HUD card from kanban_block/kanban_request_review.' },
  { value: 'needs_input', label: 'Needs input only', description: "Only genuine owner decisions (kanban_block kind='needs_input'). Excludes capability/transient/dependency blocks — those are status, not decisions." },
  { value: 'all', label: 'All blocks + reviews', description: "needs_input blocks plus every kanban_request_review handoff. Broader net, more mcq_context fallback noise from ambiguous cards." },
]

// useKanbanProfileHooksExempt: JSON-array-of-names setting controlling which
// profiles kanban_profile_hooks_sync.py (cron, every 30m) must never patch
// hooks into. Same settings-get/settings-set bridge; the sync script reads
// it directly via `hermes decision settings-get`, so this tab is the only
// UI surface needed — no new CLI/RPC.
function useKanbanProfileHooksExempt() {
  const [state, setState] = React.useState({ loading: true, names: [], error: null })
  const refresh = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const res = await cliExec(['decision', 'settings-get'])
      const s = (res && res.settings) || {}
      let names = []
      try {
        const parsed = JSON.parse(s.kanban_profile_hooks_exempt || '[]')
        names = Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'string') : []
      } catch {
        names = []
      }
      setState({ loading: false, names, error: null })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }))
    }
  }, [])
  React.useEffect(() => { refresh() }, [refresh])
  const save = React.useCallback(async (names) => {
    await cliExec(['decision', 'settings-set', 'kanban_profile_hooks_exempt', JSON.stringify(names)])
    setState((s) => ({ ...s, names }))
  }, [])
  return { ...state, refresh, save }
}

function KanbanProfileHooksExemptSection() {
  const { loading, names, error, save } = useKanbanProfileHooksExempt()
  const [draft, setDraft] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => { if (!loading) setDraft(names.join(', ')) }, [loading, names])

  const commit = React.useCallback(async () => {
    const next = [...new Set(draft.split(',').map((s) => s.trim()).filter(Boolean))]
    setSaving(true)
    try {
      await save(next)
      setDraft(next.join(', '))
      host.notify({ kind: 'success', message: `Kanban hook exemptions updated (${next.length} profile(s))` })
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setSaving(false)
    }
  }, [draft, save])

  return jsxs('section', {
    className: 'flex flex-col gap-2 mt-4 pt-4 border-t border-(--ui-stroke-secondary)',
    children: [
      jsx('div', { className: 'text-sm font-medium', children: 'Kanban profile hook exemptions' }),
      jsx('p', {
        className: 'text-[0.8rem] text-(--ui-text-secondary)',
        children:
          "Profile names the kanban_profile_hooks_sync.py cron job (every 30m) must never patch escalation hooks into — an intentionally hookless profile stays that way instead of being silently re-patched on the next tick. Comma-separated.",
      }),
      error ? jsx('div', { className: 'text-[0.75rem] text-(--ui-danger,#e5484d)', children: error }) : null,
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('input', {
            type: 'text',
            value: draft,
            disabled: loading || saving,
            placeholder: 'e.g. sandbox-test, legacy-worker',
            onChange: (e) => setDraft(e.target.value),
            onBlur: commit,
            onKeyDown: (e) => { if (e.key === 'Enter') { e.currentTarget.blur() } },
            className: 'h-7 flex-1 rounded border border-(--ui-stroke-secondary) bg-transparent px-2 text-[0.8rem]',
          }),
        ],
      }),
    ],
  })
}
function KanbanEscalationScopeTab() {
  const { loading, scope, error, save } = useKanbanEscalationScope()
  const [saving, setSaving] = React.useState(false)

  const handleSelect = React.useCallback(async (value) => {
    if (value === scope) return
    setSaving(true)
    try {
      await save(value)
      host.notify({ kind: 'success', message: `Kanban escalation bridge scope set to '${value}'` })
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setSaving(false)
    }
  }, [scope, save])

  return jsxs('section', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', { className: 'text-sm font-medium', children: 'Kanban escalation bridge' }),
      jsx('p', {
        className: 'text-[0.8rem] text-(--ui-text-secondary)',
        children:
          'Controls which kanban_block/kanban_request_review calls auto-push a shaped Decision HUD card (via the card-type-gate classifier) instead of leaving the decision to sit as a plain board comment.',
      }),
      error ? jsx('div', { className: 'text-[0.75rem] text-(--ui-danger,#e5484d)', children: error }) : null,
      jsx('div', {
        className: 'flex flex-col gap-1',
        children: KANBAN_ESCALATION_SCOPE_OPTIONS.map((opt) =>
          jsxs('label', {
            key: opt.value,
            className: 'flex items-start gap-2 rounded border border-(--ui-stroke-secondary) p-2 text-[0.8rem]',
            children: [
              jsx('input', {
                type: 'radio',
                name: 'kanban-escalation-scope',
                value: opt.value,
                checked: scope === opt.value,
                disabled: loading || saving,
                onChange: () => handleSelect(opt.value),
                className: 'mt-0.5',
              }),
              jsxs('div', {
                className: 'flex flex-col',
                children: [
                  jsx('span', { className: 'font-medium', children: opt.label }),
                  jsx('span', { className: 'text-(--ui-text-tertiary)', children: opt.description }),
                ],
              }),
            ],
          })
        ),
      }),
      jsx(KanbanProfileHooksExemptSection, {}),
    ],
  })
}

function UniversalSubagentSkillsTab() {
  const { available, selected, loading, error, save } = useUniversalSkills()
  const [saving, setSaving] = React.useState(false)
  const [query, setQuery] = React.useState('')

  const toggle = async (name, checked) => {
    const next = checked ? [...selected, name] : selected.filter((item) => item !== name)
    setSaving(true)
    try {
      await save(next)
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setSaving(false)
    }
  }

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? available.filter((name) => name.toLowerCase().includes(q)) : available
  }, [available, query])

  return jsxs('section', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', { className: 'text-sm font-medium', children: 'Universal subagents skill select' }),
      jsx('div', {
        className: 'text-[0.75rem] text-(--ui-text-secondary)',
        children: 'Selected skills are injected into every subagent and Kanban card spawned from Hermes.',
      }),
      error ? jsx('div', { className: 'text-[0.75rem] text-(--ui-danger,#e5484d)', children: error }) : null,
      !loading
        ? jsx('input', {
            type: 'text',
            value: query,
            onChange: (e) => setQuery(e.target.value),
            placeholder: 'Search skills…',
            'aria-label': 'Search skills',
            className: 'w-full rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-[0.75rem]',
          })
        : null,
      loading
        ? jsx('div', { className: 'text-[0.75rem] text-(--ui-text-tertiary)', children: 'Loading skills…' })
        : jsx('div', {
            className: 'flex max-h-64 flex-col gap-1 overflow-y-auto rounded border border-(--ui-stroke-secondary) p-2',
            children: filtered.length > 0
              ? filtered.map((name) =>
                  jsxs('label', {
                    key: name,
                    className: 'flex items-center gap-2 py-0.5 text-[0.75rem]',
                    children: [
                      jsx(Switch, {
                        'aria-label': name,
                        checked: selected.includes(name),
                        disabled: saving,
                        size: 'xs',
                        onCheckedChange: (checked) => toggle(name, checked),
                      }),
                      jsx('span', { className: 'truncate', children: name }),
                    ],
                  })
                )
              : jsx('div', { className: 'text-[0.7rem] text-(--ui-text-tertiary)', children: 'No skills match' }),
          }),
    ],
  })
}

function SubagentRulesTab({ availableMetrics }) {
  const { loading, enabled, rule, error, refresh, save } = useSubagentRuleSettings()
  const [draftRule, setDraftRule] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  React.useEffect(() => { setDraftRule(rule) }, [rule])

  const handleToggle = React.useCallback(async () => {
    setSaving(true)
    try {
      await save('subagent_inject_enabled', enabled ? '0' : '1')
      await refresh()
      host.notify({ kind: 'success', message: enabled ? 'Subagent rule injection disabled' : 'Subagent rule injection enabled' })
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setSaving(false)
    }
  }, [enabled, save, refresh])

  const handleSaveRule = React.useCallback(async () => {
    setSaving(true)
    try {
      await save('subagent_inject_rule', draftRule)
      await refresh()
      host.notify({ kind: 'success', message: 'Rule saved' })
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setSaving(false)
    }
  }, [draftRule, save, refresh])

  return jsxs('div', {
    className: 'flex max-w-xl flex-col gap-4',
    children: [
      jsx('p', {
        className: 'text-[0.8rem] text-(--ui-text-secondary)',
        children:
          'Every delegate_task and kanban_create call is intercepted before dispatch (pre_tool_call hook) and, if the child\'s context/body doesn\'t already state a standing rule, this text is appended automatically — the equivalent of Claude Code\'s old SubagentStart hook, ported to Hermes.',
      }),
      error ? jsx('div', { className: 'text-[0.75rem] text-(--ui-danger,#e5484d)', children: error }) : null,
      jsxs('label', {
        className: 'flex items-center gap-2 text-[0.85rem]',
        children: [
          jsx(Switch, {
            'aria-label': 'Auto-inject into every subagent/kanban task',
            checked: enabled,
            disabled: loading || saving,
            size: 'xs',
            onCheckedChange: handleToggle,
          }),
          jsx('span', { children: 'Auto-inject into every subagent/kanban task' }),
        ],
      }),
      jsxs('div', {
        className: 'flex flex-col gap-1',
        children: [
          jsx('div', { className: 'text-[0.7rem] uppercase tracking-wide text-(--ui-text-tertiary)', children: 'Rule text' }),
          jsx('textarea', {
            value: draftRule,
            disabled: loading || saving,
            onChange: (e) => setDraftRule(e.target.value),
            rows: 6,
            className:
              'w-full rounded border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-2 text-[0.8rem] text-(--ui-text-primary)',
          }),
        ],
      }),
      jsxs('div', {
        className: 'flex gap-2',
        children: [
          jsx('button', {
            type: 'button',
            disabled: loading || saving || draftRule === rule,
            onClick: handleSaveRule,
            className:
              'h-7 rounded border border-(--ui-accent) px-3 text-[0.8rem] text-(--ui-accent) disabled:opacity-40',
            children: saving ? 'Saving…' : 'Save rule',
          }),
          jsx('button', {
            type: 'button',
            disabled: loading || saving || draftRule === rule,
            onClick: () => setDraftRule(rule),
            className:
              'h-7 rounded border border-(--ui-stroke-secondary) px-3 text-[0.8rem] text-(--ui-text-secondary) disabled:opacity-40',
            children: 'Revert',
          }),
        ],
      }),
      jsx(Separator, {}),
      jsx(UniversalSubagentSkillsTab, {}),
      jsx(Separator, {}),
      jsx(AgentHealthBarSettings, { availableMetrics }),
    ],
  })
}

function SettingsFullscreen({ isOpen, onClose, layout, onGridChange, sidebarSettings, onSidebarChange, availableMetrics }) {
  const [activeTab, setActiveTab] = React.useState('subagent-rules')

  React.useEffect(() => {
    if (!isOpen) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return jsx('div', {
    // Pane-local settings menu, contained by the main Decision HUD column.
    className: 'absolute inset-0 z-50 flex flex-col bg-(--ui-bg-elevated)/98 backdrop-blur-sm',
    onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() },
    children: jsxs('div', {
      className: 'mx-auto flex h-full w-full max-w-2xl flex-col gap-5 overflow-y-auto p-6',
      children: [
        jsxs('div', {
          className: 'flex items-center justify-between',
          children: [
            jsx('div', { className: 'text-lg font-medium', children: 'Decision HUD Settings' }),
            jsx('button', {
              type: 'button',
              'aria-label': 'Close settings',
              onClick: onClose,
              className: 'flex h-8 w-8 items-center justify-center rounded border border-(--ui-stroke-secondary) text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)',
              children: '✕',
            }),
          ],
        }),
        jsxs('div', {
          className: 'flex min-h-0 flex-1 gap-6',
          children: [
            jsxs('nav', {
              'aria-label': 'Decision HUD settings',
              className: 'flex w-40 shrink-0 flex-col gap-1 border-r border-(--ui-stroke-secondary) pr-3',
              children: [
                jsx('button', {
                  type: 'button',
                  onClick: () => setActiveTab('subagent-rules'),
                  className: `rounded px-2 py-1.5 text-left text-[0.8rem] ${activeTab === 'subagent-rules' ? 'bg-(--chrome-action-hover) text-foreground' : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'}`,
                  children: 'Subagent Rules',
                }),
                jsx('button', {
                  type: 'button',
                  onClick: () => setActiveTab('layout'),
                  className: `rounded px-2 py-1.5 text-left text-[0.8rem] ${activeTab === 'layout' ? 'bg-(--chrome-action-hover) text-foreground' : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'}`,
                  children: 'Layout',
                }),
                jsx('button', {
                  type: 'button',
                  onClick: () => setActiveTab('kanban-escalation'),
                  className: `rounded px-2 py-1.5 text-left text-[0.8rem] ${activeTab === 'kanban-escalation' ? 'bg-(--chrome-action-hover) text-foreground' : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'}`,
                  children: 'Kanban Escalation',
                }),
              ],
            }),
            jsx('div', {
              className: 'min-w-0 flex-1 overflow-y-auto',
              children: activeTab === 'subagent-rules'
                ? jsx(SubagentRulesTab, { availableMetrics })
                : activeTab === 'kanban-escalation'
                ? jsx(KanbanEscalationScopeTab, {})
                : jsxs('section', {
                    className: 'flex flex-col gap-3',
                    children: [
                      jsx('div', { className: 'text-sm font-medium', children: 'Layout' }),
                      jsx(GridLayoutControls, { layout, onChange: onGridChange }),
                      jsx(SidebarPositionControls, { settings: sidebarSettings, onChange: onSidebarChange }),
                      jsx(Separator, {}),
                      jsx(PanePlacementControls, {}),
                    ],
                  }),
            }),
          ],
        }),
      ],
    }),
  })
}


// --- Left-hand metrics/dials sidebar -------------------------------------
//
// Real numbers only, computed from data this pane already polls (decisions,
// boards) plus one extra lightweight CLI call for the necessity rate —
// never fabricated placeholders. A metric with no real signal yet (e.g. no
// resolved rows) renders as an explicit "n/a", matching the same
// honest-gap convention as decision-hub-integration/metrics_dashboard.py.
function useHudMetrics(decisions, boards) {
  const [necessity, setNecessity] = React.useState({ loading: true, rate: null, marked: 0, error: null })

  React.useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const res = await cliExec(['decision', 'necessity-rate'])
        if (cancelled) return
        setNecessity({
          loading: false,
          rate: typeof res.escalation_necessity_rate === 'number' ? res.escalation_necessity_rate : null,
          marked: res.marked_count || 0,
          error: null,
        })
      } catch (e) {
        if (cancelled) return
        setNecessity((s) => ({ ...s, loading: false, error: String(e.message || e) }))
      }
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  return React.useMemo(() => {
    const pendingCount = decisions.length
    const highUrgencyCount = decisions.filter((d) => d.urgency === 'high').length
    const cardCount = decisions.filter((d) => d.card_type).length
    const cardCoverage = pendingCount > 0 ? cardCount / pendingCount : null
    // "Gated" = review_dispatch_enabled: the kanban-side knob closest to a
    // batch-approval-style gate today (dispatch requires a review pass
    // before landing). This is still a proxy metric, not a direct count of
    // boards with an actual OPEN/pending batch_approval row for their linked
    // project — the board<->project_id join now exists (DecisionHudPane's
    // selectedBoardProjectId) and COULD support that tighter count, but
    // nothing has wired it through to this metric yet.
    const boardsGated = boards.filter((b) => b && b.review_dispatch_enabled).length
    return {
      pendingCount,
      highUrgencyCount,
      cardCoverage,
      boardsTotal: boards.length,
      boardsGated,
      necessity,
    }
  }, [decisions, boards, necessity])
}

// useAgentHealth: sorted agent-health roster for the metrics sidebar.
//
// Real numbers only, same convention as useHudMetrics above: this pulls the
// known-agent roster from `hermes kanban assignees --json` (confirmed shape:
// a bare array of `{ name, on_disk, counts }`, where `counts` is commonly
// `{}` in an environment with no active task data — never assume it has any
// particular status keys) plus `hermes kanban stats --json` (confirmed
// shape: `{ by_status, by_assignee, oldest_ready_age_seconds, now }`, also
// commonly empty). Per-agent blocked/running task counts would ideally come
// from `by_assignee`, but when that's empty (as observed) there is no real
// per-agent signal available today — this renders those agents as
// "no data" rather than inventing a fabricated score. This is a deliberately
// simple MVP: sort by blocked-task count descending (most stuck first), then
// running-task count descending, as tie-break. See
// decision-hub-integration/research-composite-health-score-agent4.md for the
// future EWMA composite design — not implemented here.
// useAgentTelemetryMetrics: real per-agent Agent Metrics telemetry (the same
// Postgres-backed read model AgentDashboard/AgentMetricsPage render), scoped
// to the given projectId. Metric keys are whatever the telemetry pipeline
// has actually emitted for this project — no hardcoded vocabulary — so the
// health-bar picker below always reflects real available metrics, never a
// guessed list. Requires a project-scoped actor token (same
// `hermes decision issue-token --project-id` mint AgentDashboard uses);
// returns per-agent metric maps plus the sorted list of distinct metric keys
// seen across all agents.
function useAgentTelemetryMetrics(projectId, rest) {
  const [state, setState] = React.useState({ byAgent: {}, metricKeys: [], loading: true, error: null })
  const [token, setToken] = React.useState(null)

  React.useEffect(() => {
    let active = true
    if (!projectId) {
      setToken(null)
      return () => { active = false }
    }
    cliExec(['decision', 'issue-token', '--actor', 'desktop-pane', '--project-id', projectId])
      .then((res) => { if (active && res && res.ok && res.actor_token) setToken(res.actor_token) })
      .catch(() => { if (active) setToken(null) })
    return () => { active = false }
  }, [projectId])

  const refresh = React.useCallback(async () => {
    if (!projectId || !token || typeof rest !== 'function') {
      setState((s) => ({ ...s, loading: false }))
      return
    }
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const query = { limit: DASHBOARD_MAX_ROWS, project_id: projectId }
      const headers = { Authorization: `Bearer ${token}` }
      const response = await rest(DASHBOARD_READ_MODEL_PATH, { method: 'GET', query, headers })
      const snapshot = validateDashboardSnapshot(response)
      const byAgent = {}
      const keySet = new Set()
      for (const metric of snapshot.metrics) {
        if (!isDashboardRecord(metric) || typeof metric.agent_id !== 'string' || typeof metric.key !== 'string') continue
        if (!dashboardFiniteNumber(metric.value)) continue // bars need a numeric magnitude
        if (!byAgent[metric.agent_id]) byAgent[metric.agent_id] = {}
        byAgent[metric.agent_id][metric.key] = metric.value
        keySet.add(metric.key)
      }
      setState({ byAgent, metricKeys: [...keySet].sort(), loading: false, error: null })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }))
    }
  }, [projectId, token, rest])

  React.useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  return { ...state, refresh }
}

function useAgentHealth(telemetryByAgent) {
  const [state, setState] = React.useState({ agents: [], loading: true, error: null })

  const refresh = React.useCallback(async () => {
    try {
      const [assigneesRes, statsRes] = await Promise.all([
        cliExec(['kanban', 'assignees', '--json']),
        cliExec(['kanban', 'stats', '--json']),
      ])
      const roster = Array.isArray(assigneesRes) ? assigneesRes : []
      const byAssignee = (statsRes && typeof statsRes === 'object' && statsRes.by_assignee) || {}

      const agents = roster.map((a) => {
        const name = (a && a.name) || 'unknown'
        // Prefer real per-agent breakdowns from kanban stats' by_assignee
        // when present; fall back to the roster's own `counts` field
        // (also real CLI data, just from a different endpoint). Neither is
        // guaranteed to carry any status keys in a quiet environment.
        const fromStats = byAssignee[name] || null
        const fromRoster = (a && a.counts) || {}
        const kanbanCounts = fromStats && typeof fromStats === 'object' ? fromStats : fromRoster
        // Agent Metrics telemetry (real per-agent Postgres-backed values,
        // see useAgentTelemetryMetrics) takes priority over kanban task
        // counts for the health-bar values when telemetry has data for this
        // agent — kanban counts remain the fallback so bars aren't just
        // blank in a project with no telemetry pipeline wired up yet.
        const telemetryCounts = telemetryByAgent && telemetryByAgent[name]
        const counts = telemetryCounts && Object.keys(telemetryCounts).length > 0 ? telemetryCounts : kanbanCounts
        const blocked = typeof kanbanCounts.blocked === 'number' ? kanbanCounts.blocked : 0
        const running = typeof kanbanCounts.running === 'number' ? kanbanCounts.running : 0
        const hasData = Object.keys(counts).length > 0
        return {
          name,
          onDisk: Boolean(a && a.on_disk),
          blocked,
          running,
          counts,
          hasData,
        }
      })

      // Unhealthiest first: most blocked work first, running count as
      // tie-break. Agents with no real signal float to the bottom, shown as
      // neutral "no data" rather than sorted as if they were healthy.
      agents.sort((x, y) => {
        if (x.hasData !== y.hasData) return x.hasData ? -1 : 1
        if (y.blocked !== x.blocked) return y.blocked - x.blocked
        return y.running - x.running
      })

      setState({ agents, loading: false, error: null })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }))
    }
  }, [telemetryByAgent])

  React.useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  return { ...state, refresh }
}

// Agent health bars ("HP/MP/stamina" style, in Hermes' own visual language):
// three configurable stat bars per agent card, bound to real Agent Metrics
// telemetry keys when telemetry is available for the current project
// (useAgentTelemetryMetrics), falling back to kanban task-count keys
// (done/todo/blocked/review) otherwise — see useAgentHealth above for the
// merge. Selection is mutually exclusive across the three slots (one
// dropdown each) plus a display checkbox per slot, persisted via the same
// settings-get/-set backend as subagent injection (hud_settings table, key
// `agent_health_bars`, see cli.py's _SETTINGS_KEYS default).
const FALLBACK_AGENT_HEALTH_METRICS = [
  { key: 'done', label: 'Done' },
  { key: 'todo', label: 'Todo' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'review', label: 'Review' },
]
const AGENT_HEALTH_BAR_COLORS = ['bg-(--ui-success,#3dd68c)', 'bg-(--ui-accent,#5b8def)', 'bg-(--ui-danger,#e5484d)']
const DEFAULT_AGENT_HEALTH_BARS = [
  { metric: 'done', enabled: true },
  { metric: 'todo', enabled: true },
  { metric: 'blocked', enabled: true },
]

function useAgentHealthBarSettings(availableMetrics) {
  const [state, setState] = React.useState({ bars: DEFAULT_AGENT_HEALTH_BARS, loading: true, error: null })
  const metricKeys = availableMetrics && availableMetrics.length > 0
    ? availableMetrics.map((m) => m.key)
    : FALLBACK_AGENT_HEALTH_METRICS.map((m) => m.key)

  const refresh = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const res = await cliExec(['decision', 'settings-get'])
      const raw = (res && res.settings && res.settings.agent_health_bars) || '[]'
      let bars
      try {
        const parsed = JSON.parse(raw)
        bars = Array.isArray(parsed) && parsed.length === 3
          ? parsed.map((b, i) => ({
              metric: metricKeys.includes(b?.metric) ? b.metric : metricKeys[i] || metricKeys[0],
              enabled: Boolean(b?.enabled),
            }))
          : DEFAULT_AGENT_HEALTH_BARS
      } catch {
        bars = DEFAULT_AGENT_HEALTH_BARS
      }
      setState({ bars, loading: false, error: null })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }))
    }
  }, [metricKeys.join(',')])

  React.useEffect(() => { refresh() }, [refresh])

  const save = React.useCallback(async (bars) => {
    await cliExec(['decision', 'settings-set', 'agent_health_bars', JSON.stringify(bars)])
    setState((s) => ({ ...s, bars }))
  }, [])

  return { ...state, refresh, save }
}

// AgentHealthBarSettings: lives on the same settings page as Subagent
// Rules/Universal skill select. Three rows, each a metric dropdown
// (mutually exclusive — picking a metric already used elsewhere swaps it)
// plus a "display" checkbox that toggles that bar's visibility on cards.
// `availableMetrics` is real Agent Metrics telemetry keys for the current
// project when telemetry exists there; otherwise the fallback kanban
// task-count vocabulary (done/todo/blocked/review) — see useAgentHealth.
function AgentHealthBarSettings({ availableMetrics }) {
  const metrics = availableMetrics && availableMetrics.length > 0 ? availableMetrics : FALLBACK_AGENT_HEALTH_METRICS
  const { bars, loading, error, save } = useAgentHealthBarSettings(metrics)
  const [saving, setSaving] = React.useState(false)

  const updateSlot = async (index, patch) => {
    const next = bars.map((b, i) => (i === index ? { ...b, ...patch } : b))
    if (patch.metric) {
      // Enforce mutual exclusivity: if another slot already had this
      // metric, swap it for the slot being replaced's old metric.
      const displaced = bars[index].metric
      next.forEach((b, i) => {
        if (i !== index && b.metric === patch.metric) next[i] = { ...b, metric: displaced }
      })
    }
    setSaving(true)
    try {
      await save(next)
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setSaving(false)
    }
  }

  return jsxs('section', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', { className: 'text-sm font-medium', children: 'Agent health bars' }),
      jsx('div', {
        className: 'text-[0.75rem] text-(--ui-text-secondary)',
        children: availableMetrics && availableMetrics.length > 0
          ? 'Pick up to three Agent Metrics telemetry stats to show as stat bars on each agent card.'
          : 'No Agent Metrics telemetry yet for this board\u2019s project — showing kanban task-count stats as stat bars on each agent card.',
      }),
      error ? jsx('div', { className: 'text-[0.75rem] text-(--ui-danger,#e5484d)', children: error }) : null,
      loading
        ? jsx('div', { className: 'text-[0.75rem] text-(--ui-text-tertiary)', children: 'Loading…' })
        : jsx('div', {
            className: 'flex flex-col gap-2',
            children: bars.map((bar, index) =>
              jsxs('div', {
                key: index,
                className: 'flex items-center gap-3',
                children: [
                  jsx(Switch, {
                    'aria-label': `Display bar ${index + 1}`,
                    checked: bar.enabled,
                    disabled: saving,
                    size: 'xs',
                    onCheckedChange: (checked) => updateSlot(index, { enabled: checked }),
                  }),
                  jsxs(Select, {
                    value: bar.metric,
                    disabled: saving,
                    onValueChange: (value) => updateSlot(index, { metric: value }),
                    children: [
                      jsx(SelectTrigger, { className: 'h-7 w-32 text-[0.75rem]', children: jsx(SelectValue, {}) }),
                      jsx(SelectContent, {
                        children: metrics.map((m) => jsx(SelectItem, { value: m.key, children: m.label }, m.key)),
                      }),
                    ],
                  }),
                ],
              })
            ),
          }),
    ],
  })
}


// AgentHealthCard: a compact per-agent "stat card" — three small bars (the
// video-game HP/MP/stamina shape, restyled with Hermes' own tokens instead
// of game terminology) driven by whichever kanban metrics are configured
// in AgentHealthBarSettings. Bar length is metric-value clamped against the
// largest value for that metric across all agents (own-relative scale —
// there's no fixed "max tasks" ceiling to normalize against).
// humanizeAgentName: "adversarial-reviewer" -> "Adversarial Reviewer". Purely
// cosmetic — the raw hyphenated id is still used for keys/lookups/title attrs.
function humanizeAgentName(name) {
  return String(name || '')
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function AgentHealthCard({ agent, bars, maxByMetric }) {
  const visibleBars = bars.filter((b) => b.enabled)
  return jsxs('div', {
    className: 'flex flex-col gap-1 rounded border border-(--ui-stroke-secondary) px-2 py-1.5',
    children: [
      jsx('div', {
        className: 'truncate text-[0.7rem] font-medium text-(--ui-text-secondary)',
        title: agent.name,
        children: humanizeAgentName(agent.name),
      }),
      !agent.hasData
        ? jsx('div', { className: 'text-[0.6rem] text-(--ui-text-tertiary) opacity-50', children: 'no data' })
        : jsx('div', {
            className: 'flex flex-col gap-0.5',
            children: visibleBars.map((bar, i) => {
              const value = typeof agent.counts?.[bar.metric] === 'number' ? agent.counts[bar.metric] : 0
              const max = maxByMetric[bar.metric] || 1
              const pct = Math.max(0, Math.min(100, (value / max) * 100))
              return jsxs('div', {
                key: bar.metric,
                className: 'flex items-center gap-1.5',
                children: [
                  jsx('span', {
                    className: 'w-10 shrink-0 truncate uppercase tracking-wide text-(--ui-text-tertiary)',
                    style: { fontSize: '0.55rem', lineHeight: '0.75rem' },
                    title: `${bar.metric}: ${value}`,
                    children: bar.metric,
                  }),
                  jsx('div', {
                    className: 'h-1.5 flex-1 overflow-hidden rounded-full bg-(--ui-stroke-secondary)',
                    children: jsx('div', {
                      className: `h-full rounded-full ${AGENT_HEALTH_BAR_COLORS[i % AGENT_HEALTH_BAR_COLORS.length]}`,
                      style: { width: `${pct}%` },
                    }),
                  }),
                ],
              })
            }),
          }),
    ],
  })
}

// AgentHealthList: compact card stack below the dials, one per known agent,
// sorted unhealthiest-first (see useAgentHealth). Honest empty/neutral
// states instead of a fabricated ranking, matching the "n/a" / "no pending
// rows" convention used elsewhere in this sidebar.
function AgentHealthList({ health, availableMetrics }) {
  const { agents, loading, error } = health
  const metrics = availableMetrics && availableMetrics.length > 0 ? availableMetrics : FALLBACK_AGENT_HEALTH_METRICS
  const { bars } = useAgentHealthBarSettings(metrics)

  if (error) {
    return jsx('div', {
      className: 'text-[0.65rem] text-(--ui-danger,#e5484d)',
      children: 'agent health: error',
    })
  }
  if (loading) {
    return jsx('div', {
      className: 'text-center text-[0.65rem] text-(--ui-text-tertiary)',
      children: 'agent health: loading…',
    })
  }
  if (agents.length === 0) {
    return jsx('div', {
      className: 'text-center text-[0.65rem] text-(--ui-text-tertiary)',
      children: 'agent health: no agents',
    })
  }

  const anyData = agents.some((a) => a.hasData)
  const maxByMetric = {}
  for (const bar of bars) {
    maxByMetric[bar.metric] = Math.max(1, ...agents.map((a) => (typeof a.counts?.[bar.metric] === 'number' ? a.counts[bar.metric] : 0)))
  }

  return jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      jsx('div', {
        className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)',
        children: 'Agent health',
      }),
      !anyData
        ? jsx('div', {
            className: 'text-center text-[0.6rem] text-(--ui-text-tertiary)',
            children: 'n/a (no per-agent task data yet)',
          })
        : jsx('div', {
            className: 'flex flex-col gap-1',
            children: agents.map((a) => jsx(AgentHealthCard, { key: a.name, agent: a, bars, maxByMetric })),
          }),
    ],
  })
}

function MetricDial({ label, value, min, max, unit, subtitle }) {
  return jsxs('div', {
    className: 'flex flex-col items-center gap-1 rounded-lg border border-(--ui-stroke-secondary) p-2',
    children: [
      jsx('div', {
        className: 'w-full',
        children: jsx(RadialGaugeDisplay, { value, min, max, unit, size: 'compact' }),
      }),
      jsx('div', { className: 'text-center text-[0.7rem] font-medium', children: label }),
      subtitle
        ? jsx('div', { className: 'text-center text-[0.6rem] text-(--ui-text-tertiary)', children: subtitle })
        : null,
    ],
  })
}

// MetricsSidebar: dials/metrics panel, matching the plugin header comment's
// original "switchable visualization" placeholder — this is the real
// implementation of that slot, not a further placeholder. Side (left/right)
// and width are now user-configurable settings instead of a hardcoded
// left-only w-1/4/max-w-[200px] class.
function MetricsSidebar({ agentHealth, side, widthPx, availableMetrics }) {
  const borderClass = side === 'right' ? 'border-l pl-3' : 'border-r pr-3'
  return jsx('div', {
    className: `flex shrink-0 flex-col gap-3 overflow-y-auto border-(--ui-stroke-secondary) ${borderClass}`,
    style: { width: `${widthPx}px`, maxWidth: `${widthPx}px` },
    children: jsx(AgentHealthList, { health: agentHealth, availableMetrics }),
  })
}


function DecisionHudPane({ rest }) {
  // The selected board is the sole project scope: boards and projects are
  // intentionally one-to-one.
  // Initialized from + persisted to SELECTED_BOARD_STORAGE_KEY so the
  // routed Agent Dashboard / Agent Metrics panes (useProjectDashboardScope,
  // near the top of this file) see the same board selection — they are
  // separate registered panes with no shared React tree, so localStorage
  // plus a same-origin 'storage' listener is the cross-pane channel.
  const [selectedBoard, setSelectedBoardState] = React.useState(loadSelectedBoardSlug)
  const setSelectedBoard = React.useCallback((slug) => {
    setSelectedBoardState(slug)
    saveSelectedBoardSlug(slug)
  }, [])
  const [resolving, setResolving] = React.useState(false)
  const [gridLayout, setGridLayout] = React.useState(loadGridLayout)
  const [sidebarSettings, setSidebarSettings] = React.useState(loadSidebarSettings)
  const [settingsFullscreenOpen, setSettingsFullscreenOpen] = React.useState(false)
  const { boards, error: boardsError } = useKanbanBoards()

  React.useEffect(() => {
    if (!selectedBoard && boards.length > 0) {
      // Same "default"-slug preference as useProjectDashboardScope, so
      // Decision HUD and Agent Dashboard/Metrics converge on the same
      // auto-picked board instead of racing to different boards[0]s.
      const fallback = pickDefaultBoardSlug(boards)
      if (fallback) setSelectedBoard(fallback)
    }
  }, [boards, selectedBoard, setSelectedBoard])

  const boardForControls = selectedBoard || pickDefaultBoardSlug(boards)

  // Board/project scope is one-to-one: the selected board resolves directly
  // to the single project whose decisions should be shown.
  const selectedBoardProjectId = React.useMemo(() => {
    if (!boardForControls) return null
    const board = boards.find((b) => b && b.slug === boardForControls)
    return board ? board.project_id || null : null
  }, [boards, boardForControls])

  const { decisions, loading, error, refresh } = useDecisionQueue(selectedBoardProjectId)
  const telemetry = useAgentTelemetryMetrics(selectedBoardProjectId, rest)
  const agentHealth = useAgentHealth(telemetry.byAgent)
  const availableMetrics = React.useMemo(
    () => telemetry.metricKeys.map((key) => ({ key, label: key })),
    [telemetry.metricKeys]
  )

  const handleGridChange = React.useCallback((next) => {
    setGridLayout(next)
    saveGridLayout(next)
  }, [])

  const handleSidebarSettingsChange = React.useCallback((next) => {
    setSidebarSettings(next)
    saveSidebarSettings(next)
  }, [])

  const handleResolve = React.useCallback(
    async (id, choice, payload) => {
      haptic('tap')
      setResolving(true)
      try {
        const actorToken = await getActorToken()
        const argv = ['decision', 'resolve', id, choice, '--actor-token', actorToken]
        if (payload) {
          argv.push('--payload', JSON.stringify(payload))
        }
        await cliExec(argv)
        host.notify({ kind: 'success', message: `Resolved: ${choice}` })
        await refresh()
      } catch (e) {
        host.notify({ kind: 'error', message: String(e.message || e) })
      } finally {
        setResolving(false)
      }
    },
    [refresh]
  )

  const handleDefer = React.useCallback(
    async (id) => {
      // Deliberately NOT handleResolve: defer never touches
      // resolved_choice/resolved_at, it's a "skip for now" note.
      haptic('tap')
      setResolving(true)
      try {
        await cliExec(['decision', 'defer', id])
        host.notify({ kind: 'success', message: 'Deferred' })
        await refresh()
      } catch (e) {
        host.notify({ kind: 'error', message: String(e.message || e) })
      } finally {
        setResolving(false)
      }
    },
    [refresh]
  )

  const handleDismiss = React.useCallback(
    async (id) => {
      // Dismiss = resolve with a reserved sentinel choice, reusing the same
      // resolve_decision() path (and its actor-token gate) rather than a new
      // delete endpoint — the row and its history stay in the DB, just
      // permanently off the pending queue, unlike Defer which resurfaces.
      if (!window.confirm('Dismiss this decision? It will be marked resolved and removed from the queue.')) {
        return
      }
      haptic('tap')
      setResolving(true)
      try {
        const actorToken = await getActorToken()
        await cliExec(['decision', 'resolve', id, DISMISS_SENTINEL_CHOICE, '--actor-token', actorToken])
        host.notify({ kind: 'success', message: 'Dismissed' })
        await refresh()
      } catch (e) {
        host.notify({ kind: 'error', message: String(e.message || e) })
      } finally {
        setResolving(false)
      }
    },
    [refresh]
  )

  const handleDiscuss = React.useCallback(
    async (decision) => {
      // Open a brand-new chat session with this decision's context already
      // sent as the first turn, so the user lands in a live conversation
      // instead of an empty composer. host.newChat has no way to pre-seed a
      // draft (PluginNewChatOptions carries only workspaceMode/
      // workspaceOwnerKey — see apps/desktop/src/sdk/index.ts), so this goes
      // through the general-purpose host.request RPC door this file already
      // relies on for cli.exec: create a session, submit the prompt into
      // it, then host.openSession to bring it into view. NOT host.navigate
      // (banned — see palette-navigate-safety.test.mjs) and this is NOT the
      // "session.create + navigate" combo that comment warns about either;
      // host.openSession is a documented, proven SDK door for opening a
      // session, unlike host.navigate. Any failure anywhere in this chain
      // (older desktop, RPC rejected, etc.) falls back to the original
      // clipboard-copy behavior so the action never dead-ends.
      haptic('tap')
      const lines = [`Let's discuss this decision at length:\n\n**${decision.question || '(no question text)'}**`]
      if (Array.isArray(decision.choices) && decision.choices.length > 0) {
        lines.push(`\nChoices on the card: ${decision.choices.join(', ')}`)
      }
      if (decision.project_slug || decision.project_id) {
        lines.push(`\nProject: ${decision.project_slug || decision.project_id}`)
      }
      const seedText = lines.join('\n')
      try {
        const created = await host.request('session.create', { source: 'desktop' })
        // host.openSession expects the STORED session id — $selectedStoredSessionId
        // and session-tile lookups are keyed by it, not the live runtime
        // session_id. Passing the live id here meant openSession could never
        // find a matching tile/route, so the surface-healthy check in
        // waitForFocusedSessionHydration never passed and the hydration wait
        // ran out the clock — surfacing to the user as an indefinite spinner
        // after clicking Discuss. stored_session_id is what session.create
        // actually returns for this purpose; session_id/id are last-resort
        // fallbacks for an older/nonstandard backend response shape only.
        const sessionId = created && (created.stored_session_id || created.session_id || created.id)
        if (!sessionId) throw new Error('session.create returned no session_id')
        // session.create can return before the session is registered for
        // session-scoped RPCs — the core hits the same race and retries once
        // on "session not found" (see use-prompt-actions/utils.ts
        // withSessionNotFoundResume, session-gone-latch.ts). One short-delay
        // retry here mirrors that convention instead of reinventing it.
        try {
          await host.request('prompt.submit', { session_id: sessionId, text: seedText })
        } catch (submitErr) {
          if (!/session not found/i.test(String(submitErr && submitErr.message || submitErr))) throw submitErr
          await new Promise((resolve) => setTimeout(resolve, 300))
          await host.request('prompt.submit', { session_id: sessionId, text: seedText })
        }
        if (typeof host.openSession === 'function') {
          host.openSession(sessionId, { intent: 'tab' })
        }
        host.notify({ kind: 'success', message: 'Opened a new chat with this decision' })
        return
      } catch (e) {
        // Fall through to clipboard — see rationale above. Logged so a
        // silent failure here is diagnosable from desktop.log instead of
        // looking identical to "the RPC door doesn't exist on this desktop".
        console.error('[decision-hud] handleDiscuss: session open failed, falling back to clipboard', e)
      }
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
          throw new Error('Clipboard API unavailable in this environment')
        }
        await navigator.clipboard.writeText(seedText)
        host.notify({ kind: 'success', message: 'Copied — paste into a chat to discuss' })
      } catch (e) {
        host.notify({ kind: 'error', message: String(e.message || e) })
      }
    },
    []
  )

  // Defensive fallback: sidebarSettings comes from useState(loadSidebarSettings)
  // and every setter path also goes through loadSidebarSettings-shaped
  // objects, so this should always be a real object — but this is the exact
  // spot the live "Cannot read properties of undefined (reading 'side')"
  // crash would resurface if that ever stopped being true (e.g. a future
  // change that calls setSidebarSettings(null) directly). Falling back to
  // the same defaults loadSidebarSettings() itself returns on a bad parse
  // keeps this component from being a second place that bug can hide.
  const safeSidebarSettings = sidebarSettings && typeof sidebarSettings === 'object' ? sidebarSettings : DEFAULT_SIDEBAR_SETTINGS
  const metricsSidebar = jsx(MetricsSidebar, {
    agentHealth,
    side: safeSidebarSettings.side, widthPx: safeSidebarSettings.widthPx,
    availableMetrics,
  })
  const mainColumn = jsxs('div', {
    className: 'relative flex min-w-0 flex-1 flex-col gap-3',
    children: [
      jsxs('div', {
        className: 'relative flex flex-wrap items-center gap-x-2 gap-y-1',
        children: [
          jsxs('div', {
            className: 'flex min-w-0 flex-wrap items-center gap-2',
            children: [
              jsx('div', { className: 'shrink-0 font-medium', children: 'Decision HUD' }),
              jsx(BoardSettingsPanel, { boardSlug: boardForControls }),
              jsx(BoardSelector, { boards, active: boardForControls, onSelect: setSelectedBoard }),
              jsx(TriageBlockedWorkButton, { boardSlug: boardForControls, projectId: selectedBoardProjectId, onComplete: refresh }),
            ],
          }),
          jsx('div', {
            className: 'ml-auto flex shrink-0 items-center gap-2',
            children: [
              jsx(EmergencyStopButton, { boardSlug: boardForControls }),
              jsx('button', {
                type: 'button',
                'aria-label': 'Settings',
                onClick: () => setSettingsFullscreenOpen(true),
                // the old --ui-surface-secondary hover token used here was also a non-existent
                // token (same class of bug as SettingsPopover's background
                // above) — --chrome-action-hover is the real hover token
                // this app uses on icon buttons everywhere else.
                className:
                  'flex h-6 w-6 items-center justify-center rounded border border-(--ui-stroke-secondary) text-[0.8rem] text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)',
                children: jsx(Codicon, { name: 'settings-gear', size: '0.8rem' }),
              }),
            ],
          }),
        ],
      }),
      boardsError
        ? jsx('div', { className: 'text-[0.75rem] text-(--ui-danger,#e5484d)', children: boardsError })
        : null,
      error
        ? jsx('div', { className: 'text-[0.75rem] text-(--ui-danger,#e5484d)', children: error })
        : null,
      jsx('div', {
        className: 'flex flex-1 flex-col overflow-y-auto',
        children:
          decisions.length === 0
            ? jsx('div', {
                className: 'flex h-full items-center justify-center text-(--ui-text-tertiary)',
                children: loading ? 'Loading…' : 'Queue clear.',
              })
            : jsx('div', {
                // Static NxM grid, 1-3 cols x 1-3 rows (user-adjustable via
                // GridLayoutControls above, persisted to localStorage) —
                // "static" means a fixed cell count, not drag-resizable
                // panes. Shows up to cols*rows cards; anything beyond
                // that count stays in the queue and appears once a slot
                // frees up on the next poll/resolve.
                className: 'grid gap-3',
                style: {
                  gridTemplateColumns: `repeat(${gridLayout.cols}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${gridLayout.rows}, auto)`,
                },
                children: decisions
                  .slice(0, gridLayout.cols * gridLayout.rows)
                  .map((d) =>
                    jsx(DecisionCard, { key: d.id, decision: d, onResolve: handleResolve, onDefer: handleDefer, onDiscuss: handleDiscuss, onDismiss: handleDismiss, resolving })
                  ),
              }),
      }),
      jsx(SettingsFullscreen, {
        isOpen: settingsFullscreenOpen,
        onClose: () => setSettingsFullscreenOpen(false),
        layout: gridLayout, onGridChange: handleGridChange,
        sidebarSettings, onSidebarChange: handleSidebarSettingsChange,
        availableMetrics,
      }),
    ],
  })

  return jsx('div', {
    className: 'relative flex h-full gap-3 p-3 text-sm',
    // Sidebar renders on whichever side the user picked in settings — left
    // is the historical default (sidebar first in the children array),
    // right means the main column renders first instead.
    children: safeSidebarSettings.side === 'right'
      ? [mainColumn, metricsSidebar]
      : [metricsSidebar, mainColumn],
  })
}

const PANE_ID = `${PLUGIN_ID}:pane`

// --- New-decision toast watcher -------------------------------------------
// Independent of the pane's own poll loop (useDecisionQueue is scoped to one
// board/project and only runs while its pane is mounted): this watcher polls
// EVERY project's pending decisions and toasts once per newly-seen id, so a
// decision surfaces even if the user never opens the Decision HUD pane.
// Seen-id set persists in localStorage (survives reload; a fresh install or
// a cleared browser storage just re-toasts current pending decisions once,
// which is harmless).
const SEEN_DECISIONS_STORAGE_KEY = 'decision-hud:seen-decision-ids'

function loadSeenDecisionIds() {
  try {
    const raw = localStorage.getItem(SEEN_DECISIONS_STORAGE_KEY)
    return new Set(raw ? JSON.parse(raw) : [])
  } catch {
    return new Set()
  }
}

function saveSeenDecisionIds(ids) {
  try {
    // Cap so this never grows unbounded across a long-lived install.
    localStorage.setItem(SEEN_DECISIONS_STORAGE_KEY, JSON.stringify([...ids].slice(-500)))
  } catch {
    // localStorage unavailable — toasts still fire, just may repeat across reloads.
  }
}

function startNewDecisionToastWatcher() {
  const seen = loadSeenDecisionIds()
  let primed = false // first tick marks existing pending decisions as seen without toasting

  const tick = async () => {
    let decisions
    try {
      const res = await cliExec(['decision', 'list', '--limit', '50'])
      decisions = res.decisions || []
    } catch {
      return // transient CLI/gateway hiccup — next tick retries
    }
    const currentIds = new Set(decisions.map((d) => d.id))
    if (!primed) {
      for (const id of currentIds) seen.add(id)
      saveSeenDecisionIds(seen)
      primed = true
      return
    }
    for (const d of decisions) {
      if (seen.has(d.id)) continue
      seen.add(d.id)
      host.notify({
        kind: d.urgency === 'high' ? 'error' : 'info',
        message: `Decision HUD: ${d.question}`,
      })
    }
    saveSeenDecisionIds(seen)
  }

  tick()
  setInterval(tick, POLL_MS)
}

export default {
  id: PLUGIN_ID,
  name: 'Decision HUD',
  register(ctx) {
    startNewDecisionToastWatcher()
    // Docked pane: registering ONLY on `panes` (never on ROUTES_AREA as the
    // sole surface) is what makes it survive chat/session switching. A page
    // mounted directly on ROUTES_AREA occupies the main content slot, so
    // navigating to any chat session (also a route change) evicts it — the
    // original "why did my Decision HUD disappear" bug. `panes` docks a
    // sibling tab beside the workspace (same mechanism the Kanban Bots pane
    // and the terminal pane use) — it stays mounted, and its poll loop keeps
    // running, no matter which chat session is active or focused.
    ctx.register({
      id: PANE_ID,
      area: 'panes',
      title: 'Decision HUD',
      // Placement is now a user setting (Layout tab -> Pane placement),
      // not a fixed choice: 'right' is the original docked column, while
      // 'session-tab' docks into the SESSIONS zone as a center tab, same
      // pattern as the Kanban Bots pane
      // (apps/desktop/src/plugins/hermes-bots/plugin.tsx). Read once at
      // registration time — like any plugin config, a change here needs
      // "Reload desktop plugins" to take effect.
      data: paneRegistrationData(loadPanePlacement().decisionHud),
      render: () => jsx(DecisionHudPane, { rest: ctx.rest }),
    })
    // Agent Metrics full page: same DASHBOARD_READ_MODEL_PATH read model as
    // the (now-removed) docked Agent Dashboard pane, at full page size,
    // reachable only by direct deep link — no sidebar-nav row, no palette
    // command (see the palette-registration comment further below for why).
    ctx.register({
      id: 'agent-metrics-route',
      area: ROUTES_AREA,
      data: { path: AGENT_METRICS_ROUTE_PATH },
      render: () => jsx(AgentMetricsPage, { rest: ctx.rest }),
    })
    // Separate route/surface for the agent_metrics_snapshot.py-backed
    // widget set (heatmap/scatter/parallel-coords/treemap/radar/sankey) —
    // different data source than AgentMetricsPage above (Kanban SQLite via
    // cli.exec, not the Postgres DASHBOARD_READ_MODEL_PATH read model).
    // Same reachable-by-direct-deep-link-only pattern as agent-metrics-route.
    ctx.register({
      id: 'agent-metrics-widgets-route',
      area: ROUTES_AREA,
      data: { path: AGENT_METRICS_WIDGETS_ROUTE_PATH },
      render: () => jsx(AgentMetricsWidgetsPage, {}),
    })
    // No SIDEBAR_NAV_AREA rows anymore: both panes now default to
    // 'session-tab' placement (see DEFAULT_PANE_PLACEMENT above), which docks
    // them as real tabs in the SESSIONS zone tab strip — the same mechanism
    // the built-in Bots pane uses (apps/desktop/src/plugins/hermes-bots/
    // plugin.tsx registers `panes` + `dock: { pane: 'sessions', ... }` with NO
    // sidebar-nav row and NO route at all). A SidebarNavContribution only
    // takes a `path` (no onClick), so it always routes through ROUTES_AREA
    // first; even the reveal-and-redirect placeholder pattern (navigate away,
    // then host.revealPane + history.back()) produced a visible flash/reload
    // on every click — confirmed live, this is the bug this fix removes.
    // Clicking the tab strip entry switches tabs directly; no navigation
    // event, no placeholder page, no flash. AGENT_METRICS_ROUTE_PATH's full
    // page (registered just above) stays reachable by direct deep link only.
    // Palette command to re-surface the docked pane specifically (e.g. after
    // closing/minimizing its tab) without going through the route at all.
    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: 'decision-hud.open',
        label: 'Decision HUD: Show pane',
        keywords: ['decision', 'hud', 'queue', 'pin', 'pane'],
        run: () => host.revealPane(PANE_ID),
      },
    })
    // No palette command for the Agent Metrics full page: unlike every other
    // affordance in this file, reaching a ROUTES_AREA page from a palette
    // command has no mechanism here that's proven live. host.revealPane
    // targets a `panes` registration (PANE_ID here), not a route, so it
    // can't front this page; the only thing that CAN change the active
    // route is host.navigate, which this file never calls anywhere else and
    // which the test harness's fake @hermes/plugin-sdk stubs out as a no-op
    // identical in shape to its revealPane stub — a green test here would
    // prove nothing about whether the real desktop app's host.navigate
    // actually works (see commit 9d31e1a, where an equally test-clean but
    // unverified mechanism broke live). The page is already reachable
    // through 'agent-metrics-nav' above, which uses the SAME `path` field
    // the router already resolves for every other route in this plugin —
    // no new, unverified capability required.
  },
}
