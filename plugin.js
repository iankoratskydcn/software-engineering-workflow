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

import { Badge, Button, cn, Codicon, haptic, host, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Separator, Switch, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import * as React from 'react'

// Spec Digest read boundary: persisted criteria may be corrupt or wrong-shaped.
function parseSpecCriteria(criteria_json) {
  if (!criteria_json) return { items: [], error: null }
  try {
    const parsed = JSON.parse(criteria_json)
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      return { items: [], error: 'malformed criteria' }
    }
    return { items: parsed, error: null }
  } catch {
    return { items: [], error: 'malformed criteria' }
  }
}

const PLUGIN_ID = 'decision-hud'
const POLL_MS = 4000
const MAX_DECISION_ROWS = 1000
const DISMISS_SENTINEL_CHOICE = '__dismissed__'
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

// Shared by DecisionHudPane's own auto-select effect: when nothing is persisted yet, prefer
// the board literally named/slugged "default" (matches the common
// single-board setup, e.g. the "Default" option seen in the board
// dropdown) over just grabbing boards[0] — a board list is not guaranteed
// to return "default" first, and picking an arbitrary board would scope
// back to the first board when there is no "default"-slugged one.
function pickDefaultBoardSlug(boards) {
  if (!Array.isArray(boards) || boards.length === 0) return null
  const named = boards.find((b) => b && String(b.slug).toLowerCase() === 'default')
  return (named || boards[0]).slug || null
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


const kanbanBoardsCache = { boards: [], loaded: false, error: null }

function useKanbanBoards() {
  const [state, setState] = React.useState(() => ({
    boards: kanbanBoardsCache.boards,
    loading: !kanbanBoardsCache.loaded,
    error: kanbanBoardsCache.error,
  }))

  const refresh = React.useCallback(async () => {
    try {
      const boardsRes = await cliExec(['kanban', 'boards', 'list', '--json'])
      const boards = Array.isArray(boardsRes) ? boardsRes : []
      Object.assign(kanbanBoardsCache, { boards, loaded: true, error: null })
      setState({ boards, loading: false, error: null })
    } catch (e) {
      const error = String(e.message || e)
      Object.assign(kanbanBoardsCache, { loaded: true, error })
      setState((s) => ({ ...s, loading: false, error }))
    }
  }, [])

  React.useEffect(() => {
    if (!kanbanBoardsCache.loaded) refresh()
  }, [refresh])

  return { ...state, refresh }
}

function useProjectDashboardScope() {
  const [boardSlug, setBoardSlug] = React.useState(loadSelectedBoardSlug)
  const { boards, loading: boardsLoading, error: boardsError } = useKanbanBoards()

  React.useEffect(() => {
    if (boardSlug || boardsLoading || boards.length === 0) return
    const fallback = pickDefaultBoardSlug(boards)
    if (fallback) {
      setBoardSlug(fallback)
      saveSelectedBoardSlug(fallback)
    }
  }, [boardSlug, boardsLoading, boards])

  const projectId = React.useMemo(
    () => boards.find((board) => board && board.slug === boardSlug)?.project_id || null,
    [boards, boardSlug],
  )

  return { boardSlug, projectId, loading: boardsLoading, error: boardsError }
}

// limit: how many pending decisions to fetch, so the grid can actually
// fill to cols*rows cards. Was hardcoded to 5, which silently capped the
// queue below a 3x3 (9-card) grid layout no matter how many decisions were
// pending — the grid would show gaps or never exceed 5 cards even at a
// larger layout. Caller passes gridLayout.cols*gridLayout.rows.
function useDecisionQueue(projectId, limit) {
  const [state, setState] = React.useState({ decisions: [], projects: [], loading: true, error: null })
  const effectiveLimit = Number.isInteger(limit) && limit > 0 ? limit : 5

  const refresh = React.useCallback(async () => {
    try {
      const [listRes, projRes] = await Promise.all([
        cliExec(['decision', 'list', '--limit', String(effectiveLimit), ...(projectId ? ['--project-id', projectId] : [])]),
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
  }, [projectId, effectiveLimit])

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

function kanbanResolutionPayload(decision, choice) {
  const contract = decision && decision.card_payload && decision.card_payload._kanban_resolution
  const action = contract && contract.actions && contract.actions[choice]
  if (!action || contract.contract_version !== 1) return null
  return { action, contract_version: contract.contract_version }
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
          decision.card_type
            ? jsx('span', {
                className: 'rounded px-1.5 py-0.5 font-medium text-(--ui-text-tertiary)',
                style: { border: '1px dashed var(--ui-stroke-secondary)' },
                title: 'Rendering card_type (see decision-hud-cards taxonomy)',
                children: decision.card_type,
              })
            : null,
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
  // Explicit border (matches Clear response / Defer's bordered look) so
  // this reads as a button at a glance — it was already a semantic
  // <button type="button">, but the tinted-background-only styling with no
  // border was visually indistinguishable from a plain blue text link
  // (owner-reported).
  return jsx('button', {
    type: 'button',
    disabled: disabled || resolving,
    onClick,
    className: cn(
      'mt-1 rounded-md border px-3 py-1.5 text-[0.8rem] font-medium',
      'border-(--ui-accent) bg-(--ui-accent)/15 text-(--ui-accent)',
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
          onClick: () => onResolve(decision.id, choice, kanbanResolutionPayload(decision, choice)),
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
// MetricDial rendering constants vary only by size; the arc-angle math and value/fraction are shared.
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

function BinaryToggleCard({ decision, onResolve, resolving }) {
  // decision.choices: exactly 2 labels, e.g. ["Enable", "Disable"] --
  // choices[0] is the "on" state, choices[1] the "off" state. No
  // card_payload needed, just a Switch instead of the plain button list.
  const choices = safeArray(decision.choices)
  const [checked, setChecked] = React.useState(true)

  // push_decision accepts 2-4 choices in general; binary_toggle only
  // means something for exactly 2 -- 3+ choices fall back to the plain
  // list instead of silently dropping everything past index 1.
  if (choices.length !== 2) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }
  const onLabel = choices[0]
  const offLabel = choices[1]

  return jsxs('div', {
    className: 'flex flex-col items-center gap-3 py-1',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2.5',
        children: [
          jsx('span', {
            className: 'text-[0.75rem]',
            style: { color: checked ? 'var(--ui-text-tertiary)' : 'var(--ui-accent)', fontWeight: checked ? 400 : 600 },
            children: safeText(offLabel),
          }),
          jsx(Switch, { 'aria-label': safeText(decision.question), checked, disabled: resolving, onCheckedChange: setChecked }),
          jsx('span', {
            className: 'text-[0.75rem]',
            style: { color: checked ? 'var(--ui-accent)' : 'var(--ui-text-tertiary)', fontWeight: checked ? 600 : 400 },
            children: safeText(onLabel),
          }),
        ],
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => onResolve(decision.id, checked ? onLabel : offLabel, { value: checked }),
        children: `Confirm ${checked ? safeText(onLabel) : safeText(offLabel)}`,
      }),
    ],
  })
}

function RankedScoreCard({ decision, onResolve, resolving }) {
  // card_payload: { scale: number[] (Fibonacci by convention: 1,2,3,5,8,
  // 13,21...), items: [{ id, label }] }. Each item is scored independently,
  // in any order -- the selected button is the only indicator, items never
  // move -- distinct from rating_grid (independent items, no comparison
  // implied, continuous_independent) and from a fixed-total split (no sum
  // constraint here, continuous_constrained's other leaf).
  const payload = decision.card_payload
  const scale = safeArray(payload && payload.scale).filter((n) => typeof n === 'number')
  const items = safeArray(payload && payload.items)
  const defaultScore = scale.length ? scale[0] : 1
  const idOf = (it, i) => (it && it.id !== undefined && it.id !== null ? safeText(it.id) : `item-${i}`)
  const [scores, setScores] = React.useState(() => Object.fromEntries(items.map((it, i) => [idOf(it, i), defaultScore])))

  if (items.length === 0 || scale.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const ranked = items.map((it, i) => ({ id: idOf(it, i), label: safeText(it && it.label, idOf(it, i)), score: scores[idOf(it, i)] }))

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', { className: 'text-[0.7rem] text-(--ui-text-tertiary)', children: 'Score each item independently, in any order.' }),
      jsx('div', {
        className: 'flex flex-col gap-1.5',
        children: ranked.map((r) =>
          jsxs('div', {
            key: r.id,
            className: 'flex items-center gap-2 rounded-md px-2.5 py-1.5',
            style: { border: '1px solid var(--ui-stroke-secondary)' },
            children: [
              jsx('span', { className: 'flex-1 truncate text-[0.8rem]', children: r.label }),
              jsx('div', {
                className: 'flex gap-0.5',
                role: 'group',
                'aria-label': `Score for ${r.label}`,
                children: scale.map((n) =>
                  jsx('button', {
                    key: n,
                    type: 'button',
                    disabled: resolving,
                    'aria-pressed': r.score === n,
                    'aria-label': `${r.label}: ${n}`,
                    onClick: () => setScores((prev) => ({ ...prev, [r.id]: n })),
                    className: 'rounded px-1 py-0.5 text-[0.65rem] transition-colors hover:bg-(--chrome-action-hover)',
                    style: { border: `1px solid ${r.score === n ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
                    children: n,
                  })
                ),
              }),
            ],
          })
        ),
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => {
          const summary = ranked.map((r) => `${r.label}=${r.score}`).join(', ')
          onResolve(decision.id, summary, { scores })
        },
        children: 'Confirm ranking',
      }),
    ],
  })
}

function SpotlightPickCard({ decision, onResolve, resolving }) {
  // card_payload: { criterion: string, options: [{ label, value }] } --
  // one deciding factor, its value shown per option; thinner than
  // spider_compare (one factor, not several) and not 2-sided like
  // balance_scale. Click selects, ConfirmButton resolves -- every card in
  // this app confirms before resolving, this one is no exception.
  const payload = decision.card_payload
  const criterion = safeText(payload && payload.criterion)
  const options = safeArray(payload && payload.options)
  // Indexed, not keyed by label -- two options can share a display label
  // with different values, and label equality would conflate them.
  const [pickedIndex, setPickedIndex] = React.useState(null)

  if (options.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const picked = pickedIndex !== null ? options[pickedIndex] : null
  const pickedLabel = picked ? safeText(picked.label, `Option ${pickedIndex + 1}`) : null

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      criterion ? jsx('div', { className: 'text-[0.7rem] text-(--ui-text-tertiary)', children: `Deciding factor: ${criterion}` }) : null,
      jsx('div', {
        className: 'flex flex-col gap-1.5',
        children: options.map((opt, i) => {
          const label = safeText(opt && opt.label, `Option ${i + 1}`)
          return jsx('button', {
            key: i,
            type: 'button',
            disabled: resolving,
            'aria-pressed': pickedIndex === i,
            onClick: () => setPickedIndex(i),
            className: 'flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[0.8rem] transition-colors hover:bg-(--chrome-action-hover)',
            style: { border: `1px solid ${pickedIndex === i ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
            children: [
              jsx('span', { children: label }),
              jsx('span', { className: 'text-[0.75rem] font-semibold', style: { color: 'var(--ui-accent)' }, children: safeText(opt && opt.value) }),
            ],
          })
        }),
      }),
      jsx(ConfirmButton, {
        disabled: !picked,
        resolving,
        onClick: () => onResolve(decision.id, pickedLabel, { picked: pickedLabel, value: picked && picked.value }),
        children: 'Confirm pick',
      }),
    ],
  })
}

function ClusterOverlapCard({ decision, onResolve, resolving }) {
  // card_payload: { groups: [{ key, label }], items: [{ id, label }] } --
  // 3+ overlapping groups; items can belong to any number of them.
  // Rendered as an item x group toggle grid rather than a true N-circle
  // Venn (circle-intersection geometry doesn't generalize past 2 circles
  // the way VennOverlapCard's evenodd-path trick does; venn_overlap stays
  // the dedicated 2-set card for that case).
  const payload = decision.card_payload
  const groups = safeArray(payload && payload.groups)
  const items = safeArray(payload && payload.items)
  const [membership, setMembership] = React.useState({}) // item_key -> Set(group_key)

  if (groups.length < 2 || items.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const itemKeyOf = (it, i) => (it && it.id !== undefined && it.id !== null ? safeText(it.id) : `item-${i}`)
  const groupKeyOf = (g, i) => (g && g.key !== undefined && g.key !== null ? safeText(g.key) : `group-${i}`)

  const toggle = (itemKey, groupKey) => {
    setMembership((prev) => {
      const current = new Set(prev[itemKey] || [])
      current.has(groupKey) ? current.delete(groupKey) : current.add(groupKey)
      return { ...prev, [itemKey]: current }
    })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2 overflow-x-auto',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: 'Click a cell to toggle whether that item belongs to that group — items can belong to more than one.',
      }),
      jsxs('table', {
        className: 'w-full border-collapse text-[0.75rem]',
        children: [
          jsx('thead', {
            children: jsxs('tr', {
              children: [
                jsx('th', { className: 'text-left font-normal' }),
                ...groups.map((g, i) =>
                  jsx('th', {
                    key: groupKeyOf(g, i),
                    className: 'px-1.5 pb-1 text-center font-normal',
                    style: { color: 'var(--ui-text-tertiary)' },
                    children: safeText(g && g.label, groupKeyOf(g, i)),
                  })
                ),
              ],
            }),
          }),
          jsx('tbody', {
            children: items.map((it, i) => {
              const itemKey = itemKeyOf(it, i)
              return jsxs('tr', {
                key: itemKey,
                children: [
                  jsx('td', { className: 'py-1 pr-2 text-left', children: safeText(it && it.label, itemKey) }),
                  ...groups.map((g, gi) => {
                    const groupKey = groupKeyOf(g, gi)
                    const checked = (membership[itemKey] || new Set()).has(groupKey)
                    return jsx('td', {
                      key: groupKey,
                      className: 'px-1.5 text-center',
                      children: jsx('button', {
                        type: 'button',
                        disabled: resolving,
                        onClick: () => toggle(itemKey, groupKey),
                        className: 'h-5 w-5 rounded transition-colors hover:bg-(--chrome-action-hover)',
                        style: {
                          border: `1px solid ${checked ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}`,
                          background: checked ? 'var(--ui-accent)' : 'transparent',
                        },
                      }),
                    })
                  }),
                ],
              })
            }),
          }),
        ],
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => {
          const result = Object.fromEntries(
            items.map((it, i) => {
              const key = itemKeyOf(it, i)
              return [key, [...(membership[key] || [])]]
            })
          )
          const summary = Object.entries(result).map(([k, gs]) => `${k}: ${gs.join('+') || 'none'}`).join(', ')
          onResolve(decision.id, summary, { membership: result })
        },
        children: 'Confirm groups',
      }),
    ],
  })
}

function BipartiteAssignCard({ decision, onResolve, resolving }) {
  // card_payload: { left: [{ key, label }], right: [{ key, label }] } --
  // many-to-many assignment between two named sides, unlike wire_match's
  // strict one line per item. Click a left item, then click any number of
  // right items to toggle links; click the left item again to switch
  // which left item you're linking from.
  const payload = decision.card_payload
  const left = safeArray(payload && payload.left)
  const right = safeArray(payload && payload.right)
  const [selectedLeft, setSelectedLeft] = React.useState(null)
  const [links, setLinks] = React.useState({}) // left_key -> Set(right_key)
  const [paths, setPaths] = React.useState([])
  const wrapRef = React.useRef(null)
  const leftRefs = React.useRef({})
  const rightRefs = React.useRef({})

  const leftKeyOf = (it, i) => (it && it.key !== undefined && it.key !== null ? safeText(it.key) : `left-${i}`)
  const rightKeyOf = (it, i) => (it && it.key !== undefined && it.key !== null ? safeText(it.key) : `right-${i}`)

  const recalc = React.useCallback(() => {
    if (!wrapRef.current) return
    const wrapRect = wrapRef.current.getBoundingClientRect()
    const next = []
    for (const [lk, rks] of Object.entries(links)) {
      const ln = leftRefs.current[lk]
      if (!ln) continue
      for (const rk of rks) {
        const rn = rightRefs.current[rk]
        if (!rn) continue
        const lr = ln.getBoundingClientRect()
        const rr = rn.getBoundingClientRect()
        const x1 = lr.right - wrapRect.left
        const y1 = lr.top - wrapRect.top + lr.height / 2
        const x2 = rr.left - wrapRect.left
        const y2 = rr.top - wrapRect.top + rr.height / 2
        const mx = (x1 + x2) / 2
        next.push(`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`)
      }
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
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const toggleLink = (rightKey) => {
    if (!selectedLeft) return
    setLinks((prev) => {
      const current = new Set(prev[selectedLeft] || [])
      current.has(rightKey) ? current.delete(rightKey) : current.add(rightKey)
      return { ...prev, [selectedLeft]: current }
    })
  }

  const anyLinks = Object.values(links).some((s) => s && s.size > 0)

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: 'Click a left item, then any number of right items to link them. Click the left item again to switch.',
      }),
      jsxs('div', {
        ref: wrapRef,
        className: 'relative flex items-stretch justify-between gap-8',
        children: [
          jsx('svg', {
            className: 'pointer-events-none absolute inset-0 h-full w-full overflow-visible',
            children: paths.map((d, i) => jsx('path', { key: i, d, fill: 'none', stroke: 'var(--ui-accent)', strokeWidth: 2 })),
          }),
          jsx('div', {
            className: 'flex flex-1 flex-col gap-2',
            children: left.map((it, i) => {
              const key = leftKeyOf(it, i)
              const count = (links[key] || new Set()).size
              return jsxs('button', {
                key,
                type: 'button',
                ref: (el) => { leftRefs.current[key] = el },
                disabled: resolving,
                onClick: () => setSelectedLeft((prev) => (prev === key ? null : key)),
                className: cn(
                  'flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[0.8rem] transition-colors',
                  'hover:bg-(--chrome-action-hover)'
                ),
                style: { border: `1px solid ${selectedLeft === key ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
                children: [safeText(it && it.label, key), count > 0 ? jsx('span', { className: 'text-(--ui-text-tertiary)', children: count }) : null],
              })
            }),
          }),
          jsx('div', {
            className: 'flex flex-1 flex-col gap-2',
            children: right.map((it, i) => {
              const key = rightKeyOf(it, i)
              const linked = Boolean(selectedLeft) && (links[selectedLeft] || new Set()).has(key)
              return jsx('button', {
                key,
                type: 'button',
                ref: (el) => { rightRefs.current[key] = el },
                disabled: resolving || !selectedLeft,
                onClick: () => toggleLink(key),
                className: cn(
                  'rounded-md px-2.5 py-1.5 text-left text-[0.8rem] transition-colors',
                  'hover:bg-(--chrome-action-hover) disabled:opacity-50'
                ),
                style: { border: `1px solid ${linked ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
                children: safeText(it && it.label, key),
              })
            }),
          }),
        ],
      }),
      jsx(ConfirmButton, {
        disabled: !anyLinks,
        resolving,
        onClick: () => {
          const pairs = []
          for (const [lk, rks] of Object.entries(links)) {
            for (const rk of rks) pairs.push({ left_key: lk, right_key: rk })
          }
          const summary = pairs.map((p) => `${p.left_key}→${p.right_key}`).join(', ')
          onResolve(decision.id, summary, { pairs })
        },
        children: 'Confirm assignments',
      }),
    ],
  })
}

function FieldGroupCard({ decision, onResolve, resolving }) {
  // card_payload.fields: [{ key, label, type: "date"|"number"|"text"|
  // "select", options? }]. A compound value -- several linked fields of
  // possibly mixed type (a date range, a schedule, a color), not one
  // scalar and not one category.
  const fields = safeArray(decision.card_payload && decision.card_payload.fields)
  const [values, setValues] = React.useState({})

  if (fields.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const keyOf = (f, i) => (f && f.key !== undefined && f.key !== null ? safeText(f.key) : `field-${i}`)
  const allFilled = fields.every((f, i) => {
    const v = values[keyOf(f, i)]
    return v !== undefined && v !== ''
  })

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'flex flex-col gap-1.5',
        children: fields.map((f, i) => {
          const key = keyOf(f, i)
          const type = safeText(f && f.type, 'text')
          const label = safeText(f && f.label, key)
          const options = safeArray(f && f.options)
          return jsxs('label', {
            key,
            className: 'flex flex-col gap-0.5 text-[0.75rem]',
            children: [
              jsx('span', { className: 'text-(--ui-text-tertiary)', children: label }),
              type === 'select'
                ? jsx('select', {
                    value: values[key] ?? '',
                    disabled: resolving,
                    onChange: (e) => setValues((prev) => ({ ...prev, [key]: e.target.value })),
                    className: 'rounded-md px-2 py-1',
                    style: { border: '1px solid var(--ui-stroke-secondary)', background: 'transparent' },
                    children: [
                      jsx('option', { value: '', children: '— select —' }),
                      ...options.map((opt) => jsx('option', { key: safeText(opt), value: safeText(opt), children: safeText(opt) })),
                    ],
                  })
                : jsx('input', {
                    type: type === 'date' ? 'date' : type === 'number' ? 'number' : 'text',
                    value: values[key] ?? '',
                    disabled: resolving,
                    onChange: (e) => setValues((prev) => ({ ...prev, [key]: e.target.value })),
                    className: 'rounded-md px-2 py-1',
                    style: { border: '1px solid var(--ui-stroke-secondary)', background: 'transparent' },
                  }),
            ],
          })
        }),
      }),
      jsx(ConfirmButton, {
        disabled: !allFilled,
        resolving,
        onClick: () => {
          const summary = fields.map((f, i) => `${keyOf(f, i)}=${values[keyOf(f, i)]}`).join(', ')
          onResolve(decision.id, summary, { values })
        },
        children: 'Confirm',
      }),
    ],
  })
}

function PrecedenceGraphCard({ decision, onResolve, resolving }) {
  // card_payload: { items: [{ id, label }] } -- directed edges within ONE
  // set ("which blocks which"), not a two-sided pairing like wire_match.
  // Click a "from" item, then a "to" item to add a directed edge; edges
  // list below with a remove control. No left/right SVG lines needed --
  // there's no spatial two-column split for a single-set graph.
  const items = safeArray(decision.card_payload && decision.card_payload.items)
  const [from, setFrom] = React.useState(null)
  const [edges, setEdges] = React.useState([]) // [{ from, to }]

  if (items.length < 2) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  const idOf = (it, i) => (it && it.id !== undefined && it.id !== null ? safeText(it.id) : `item-${i}`)
  const labelOf = (id) => {
    const i = items.findIndex((it, idx) => idOf(it, idx) === id)
    return i >= 0 ? safeText(items[i] && items[i].label, id) : id
  }

  const addEdge = (to) => {
    if (!from || from === to) return
    setEdges((prev) => (prev.some((e) => e.from === from && e.to === to) ? prev : [...prev, { from, to }]))
    setFrom(null)
  }

  const removeEdge = (i) => setEdges((prev) => prev.filter((_, idx) => idx !== i))

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'text-[0.7rem] text-(--ui-text-tertiary)',
        children: from ? `Blocking: ${labelOf(from)} — click what it blocks.` : 'Click the item that blocks something first.',
      }),
      jsx('div', {
        className: 'flex flex-wrap gap-1',
        children: items.map((it, i) => {
          const id = idOf(it, i)
          return jsx('button', {
            key: id,
            type: 'button',
            disabled: resolving,
            onClick: () => (from ? addEdge(id) : setFrom(id)),
            className: 'rounded-md px-2 py-1 text-[0.75rem] transition-colors hover:bg-(--chrome-action-hover)',
            style: { border: `1px solid ${from === id ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}` },
            children: safeText(it && it.label, id),
          })
        }),
      }),
      edges.length > 0
        ? jsx('div', {
            className: 'flex flex-col gap-1',
            children: edges.map((e, i) =>
              jsxs('div', {
                key: `${e.from}->${e.to}`,
                className: 'flex items-center justify-between rounded-md px-2 py-1 text-[0.75rem]',
                style: { border: '1px solid var(--ui-stroke-secondary)' },
                children: [
                  jsx('span', { children: `${labelOf(e.from)} blocks ${labelOf(e.to)}` }),
                  jsx('button', {
                    type: 'button',
                    disabled: resolving,
                    onClick: () => removeEdge(i),
                    className: 'text-(--ui-text-tertiary) hover:text-(--ui-accent)',
                    children: '✕',
                  }),
                ],
              })
            ),
          })
        : null,
      jsx(ConfirmButton, {
        disabled: edges.length === 0,
        resolving,
        onClick: () => {
          const summary = edges.map((e) => `${labelOf(e.from)}→${labelOf(e.to)}`).join(', ')
          onResolve(decision.id, summary, { edges })
        },
        children: 'Confirm dependencies',
      }),
    ],
  })
}

function RatingGridCard({ decision, onResolve, resolving }) {
  // card_payload: { items: [{ id, label, min, max, default }], unit? } --
  // each item gets its own independent scalar value; no sum constraint,
  // no cross-item comparison (unlike ranked_score, items don't re-sort
  // against each other here).
  const payload = decision.card_payload
  const items = safeArray(payload && payload.items)
  const unit = safeText(payload && payload.unit, '')
  const idOf = (it, i) => (it && it.id !== undefined && it.id !== null ? safeText(it.id) : `item-${i}`)
  const [values, setValues] = React.useState(() =>
    Object.fromEntries(
      items.map((it, i) => [idOf(it, i), typeof (it && it.default) === 'number' ? it.default : (it && typeof it.min === 'number' ? it.min : 0)])
    )
  )

  if (items.length === 0) {
    return jsx(DefaultChoiceCard, { decision, onResolve, resolving })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', {
        className: 'flex flex-col gap-2',
        children: items.map((it, i) => {
          const key = idOf(it, i)
          const min = typeof (it && it.min) === 'number' ? it.min : 0
          const max = typeof (it && it.max) === 'number' ? it.max : 10
          return jsxs('div', {
            key,
            className: 'flex flex-col gap-0.5',
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between text-[0.75rem]',
                children: [
                  jsx('span', { children: safeText(it && it.label, key) }),
                  jsx('span', { className: 'font-semibold', style: { color: 'var(--ui-accent)' }, children: `${values[key]}${unit}` }),
                ],
              }),
              jsx('input', {
                type: 'range',
                min,
                max,
                value: values[key],
                disabled: resolving,
                onChange: (e) => setValues((prev) => ({ ...prev, [key]: Number(e.target.value) })),
                className: 'w-full',
              }),
            ],
          })
        }),
      }),
      jsx(ConfirmButton, {
        disabled: false,
        resolving,
        onClick: () => {
          const summary = items.map((it, i) => `${idOf(it, i)}=${values[idOf(it, i)]}${unit}`).join(', ')
          onResolve(decision.id, summary, { values })
        },
        children: 'Confirm ratings',
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
  binary_toggle: BinaryToggleCard,
  ranked_score: RankedScoreCard,
  spotlight_pick: SpotlightPickCard,
  cluster_overlap: ClusterOverlapCard,
  bipartite_assign: BipartiteAssignCard,
  field_group: FieldGroupCard,
  precedence_graph: PrecedenceGraphCard,
  rating_grid: RatingGridCard,
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

function OtherCommentsField({ value, onChange, disabled }) {
  // Shared, independent "Other comments" box (owner-requested) — lives in
  // DecisionCard, not any individual renderer, so every card type gets it
  // for free. Deliberately non-exclusive: typing here never requires or
  // clears whatever the card's own control (choice/slider/mapping/...)
  // selected, and a selection never clears this text — same
  // non-mutually-exclusive rule the decision-hud-cards skill already
  // requires for the MCQ-plus-free-text fallback card, generalized to
  // every shaped card too.
  return jsxs('label', {
    className: 'flex flex-col gap-1',
    children: [
      jsx('span', {
        className: 'text-[0.65rem] uppercase tracking-wide text-(--ui-text-tertiary)',
        children: 'Other comments',
      }),
      jsx('textarea', {
        value,
        disabled,
        onChange: (e) => onChange(e.target.value),
        placeholder: 'Optional — additional context, caveats, or notes',
        rows: 2,
        className: cn(
          'w-full resize-y rounded-md px-2.5 py-1.5 text-[0.8rem]',
          'bg-transparent placeholder:text-(--ui-text-tertiary) disabled:opacity-40'
        ),
        style: { border: '1px solid var(--ui-stroke-secondary)' },
      }),
    ],
  })
}

function DecisionCard({ decision, onResolve, onDefer, onDiscuss, onDismiss, resolving }) {
  const Body = CARD_RENDERERS[decision.card_type] || DefaultChoiceCard
  const isContextReadout = decision.card_type === 'context_readout'
  const [comment, setComment] = React.useState('')

  // Wrap onResolve so every renderer's own Confirm action (however it
  // builds its summary/payload) transparently gets the comment merged in,
  // without each of the 20+ CARD_RENDERERS entries needing to know this
  // field exists. Empty/whitespace-only comment is omitted entirely rather
  // than persisted as ''.
  const handleResolve = React.useCallback(
    (id, summary, payload) => {
      const trimmed = comment.trim()
      if (!trimmed) {
        onResolve(id, summary, payload)
        return
      }
      const mergedPayload = payload && typeof payload === 'object' ? { ...payload, comment: trimmed } : { comment: trimmed }
      const mergedSummary = summary ? `${summary} (comment: ${trimmed})` : `(comment: ${trimmed})`
      onResolve(id, mergedSummary, mergedPayload)
    },
    [comment, onResolve]
  )

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
      jsx(CardErrorBoundary, { decisionId: decision && decision.id, children: jsx(Body, { decision, onResolve: handleResolve, resolving }) }),
      // Shared across every card type (present vs future) — deliberately
      // outside Body, same rationale as Discuss/Defer below: a new
      // CARD_RENDERERS entry gets the comments field for free without
      // having to remember to wire it per-renderer. Context Readout has no
      // real Confirm (Dismiss-only), so it's excluded — there is nothing
      // for a comment to attach to.
      isContextReadout ? null : jsx(OtherCommentsField, { value: comment, onChange: setComment, disabled: resolving }),
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
const DEFAULT_PANE_PLACEMENT = { decisionHud: 'right', agentDashboard: 'right', taskList: 'right' }

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
    // best-effort persistence only.
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
      row('agentDashboard', 'Retrospective'),
      jsx('div', { className: 'text-[0.7rem] text-(--ui-text-tertiary)', children: 'Task List remains docked beside chat.' }),
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


// SettingsPopover: small anchored dropdown/panel opened from the gear icon
// in the DecisionHudPane header. Deliberately generic ("settings panel with
// sections") so future settings can be added as additional labeled section
// divs — grid size, sidebar position/width, and dial grid are the sections
// today.
function SettingsPopover({ layout, onGridChange, onOpenFullscreen }) {
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

// useKanbanCompletionToasts: persisted foreground-toast preference consumed
// by the desktop Kanban plugin before it emits terminal-event notifications.
function useKanbanCompletionToasts() {
  const [state, setState] = React.useState({ loading: true, enabled: true, error: null })
  const refresh = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const res = await cliExec(['decision', 'settings-get'])
      const s = (res && res.settings) || {}
      setState({ loading: false, enabled: s.kanban_completion_toasts !== '0', error: null })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }))
    }
  }, [])
  React.useEffect(() => { refresh() }, [refresh])
  const save = React.useCallback(async (enabled) => {
    await cliExec(['decision', 'settings-set', 'kanban_completion_toasts', enabled ? '1' : '0'])
    setState((s) => ({ ...s, enabled }))
  }, [])
  return { ...state, refresh, save }
}

function KanbanNotificationsTab() {
  const { loading, enabled, error, save } = useKanbanCompletionToasts()
  const [saving, setSaving] = React.useState(false)

  const handleToggle = React.useCallback(async () => {
    setSaving(true)
    try {
      await save(!enabled)
      host.notify({ kind: 'success', message: `Kanban task toasts ${enabled ? 'disabled' : 'enabled'}` })
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setSaving(false)
    }
  }, [enabled, save])

  return jsxs('section', {
    className: 'flex flex-col gap-3',
    children: [
      jsx('div', { className: 'text-sm font-medium', children: 'Kanban Notifications' }),
      jsx('p', {
        className: 'text-[0.8rem] text-(--ui-text-secondary)',
        children: 'Control the foreground toast shown when a Kanban task completes, blocks, times out, crashes, or is routed to triage. Native OS notifications have a separate Hermes setting.',
      }),
      error ? jsx('div', { className: 'text-[0.75rem] text-(--ui-danger,#e5484d)', children: error }) : null,
      jsxs('label', {
        className: 'flex items-center justify-between gap-3 rounded border border-(--ui-stroke-secondary) p-2 text-[0.8rem]',
        children: [
          jsxs('span', {
            className: 'flex flex-col',
            children: [
              jsx('span', { className: 'font-medium', children: 'Show Kanban task toasts' }),
              jsx('span', { className: 'text-(--ui-text-tertiary)', children: 'Disable this to hide the in-app completion cards.' }),
            ],
          }),
          jsx(ToggleSwitch, {
            checked: enabled,
            disabled: loading || saving,
            onClick: handleToggle,
            label: 'Show Kanban task toasts',
          }),
        ],
      }),
    ],
  })
}

// useTelemetrySyncInterval: configurable interval for the
// "decision-hud telemetry checkpoint sync (all boards)" cron job
// (~/.hermes/scripts/sync-decision-hud-telemetry.sh, see
// backend/scripts/sync_kanban_telemetry.py --all-boards). Two things have
// to move together on save: the job's actual `hermes cron edit --schedule`
// (what makes it really run more/less often) AND a settings-set record of
// the chosen minutes (what lets this tab show the current value back
// without re-parsing cron's free-text schedule string). The job_id is
// fixed/hardcoded — this is the one recurring sync job this plugin owns,
// same as BoardSettingsPanel hardcoding its `kanban boards` CLI shape.
const TELEMETRY_SYNC_JOB_ID = '25f76e363778'
const TELEMETRY_SYNC_JOB_NAME = 'decision-hud telemetry checkpoint sync (all boards)'
const TELEMETRY_SYNC_INTERVAL_OPTIONS = [1, 5, 10, 15, 30, 60]
const TELEMETRY_SYNC_INTERVAL_DEFAULT = 15

function useTelemetrySyncInterval() {
  const [state, setState] = React.useState({ loading: true, minutes: TELEMETRY_SYNC_INTERVAL_DEFAULT, error: null })
  const refresh = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const res = await cliExec(['decision', 'settings-get'])
      const s = (res && res.settings) || {}
      const parsed = parseInt(s.telemetry_sync_interval_minutes, 10)
      setState({
        loading: false,
        minutes: Number.isFinite(parsed) && parsed > 0 ? parsed : TELEMETRY_SYNC_INTERVAL_DEFAULT,
        error: null,
      })
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e.message || e) }))
    }
  }, [])
  React.useEffect(() => { refresh() }, [refresh])
  const save = React.useCallback(async (minutes) => {
    // Order matters for a failure mid-way: apply the real schedule change
    // FIRST, only persist the displayed value once cron actually accepted
    // it — an early settings-set would show a minutes value the job isn't
    // really running at.
    await cliExec(['cron', 'edit', TELEMETRY_SYNC_JOB_ID, '--schedule', `every ${minutes}m`])
    await cliExec(['decision', 'settings-set', 'telemetry_sync_interval_minutes', String(minutes)])
    setState((s) => ({ ...s, minutes }))
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

function TelemetrySyncIntervalTab() {
  const { loading, minutes, error, save } = useTelemetrySyncInterval()
  const [saving, setSaving] = React.useState(false)

  const handleSelect = React.useCallback(async (value) => {
    if (value === minutes) return
    setSaving(true)
    try {
      await save(value)
      host.notify({ kind: 'success', message: `Telemetry sync interval set to every ${value}m` })
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setSaving(false)
    }
  }, [minutes, save])

  return jsxs('section', {
    className: 'flex flex-col gap-2',
    children: [
      jsx('div', { className: 'text-sm font-medium', children: 'Telemetry sync interval' }),
      jsx('p', {
        className: 'text-[0.8rem] text-(--ui-text-secondary)',
        children:
          `How often the "${TELEMETRY_SYNC_JOB_NAME}" cron job writes a fresh Agent Health checkpoint into Postgres. Shorter intervals give a more detailed history/percentile/z-score view sooner, at the cost of more frequent writes.`,
      }),
      error ? jsx('div', { className: 'text-[0.75rem] text-(--ui-danger,#e5484d)', children: error }) : null,
      jsx('div', {
        className: 'flex flex-col gap-1',
        children: TELEMETRY_SYNC_INTERVAL_OPTIONS.map((value) =>
          jsxs('label', {
            key: value,
            className: 'flex items-start gap-2 rounded border border-(--ui-stroke-secondary) p-2 text-[0.8rem]',
            children: [
              jsx('input', {
                type: 'radio',
                name: 'telemetry-sync-interval',
                value: String(value),
                checked: minutes === value,
                disabled: loading || saving,
                onChange: () => handleSelect(value),
                className: 'mt-0.5',
              }),
              jsx('span', { className: 'font-medium', children: `Every ${value} minute${value === 1 ? '' : 's'}` }),
            ],
          })
        ),
      }),
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

function SubagentRulesTab() {
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
    ],
  })
}

function SettingsFullscreen({ isOpen, onClose, layout, onGridChange }) {
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
                jsx('button', {
                  type: 'button',
                  onClick: () => setActiveTab('kanban-notifications'),
                  className: `rounded px-2 py-1.5 text-left text-[0.8rem] ${activeTab === 'kanban-notifications' ? 'bg-(--chrome-action-hover) text-foreground' : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'}`,
                  children: 'Kanban Notifications',
                }),
                jsx('button', {
                  type: 'button',
                  onClick: () => setActiveTab('telemetry-sync'),
                  className: `rounded px-2 py-1.5 text-left text-[0.8rem] ${activeTab === 'telemetry-sync' ? 'bg-(--chrome-action-hover) text-foreground' : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'}`,
                  children: 'Telemetry Sync',
                }),
              ],
            }),
            jsx('div', {
              className: 'min-w-0 flex-1 overflow-y-auto',
              children: activeTab === 'subagent-rules'
                ? jsx(SubagentRulesTab, {})
                : activeTab === 'kanban-escalation'
                ? jsx(KanbanEscalationScopeTab, {})
                : activeTab === 'kanban-notifications'
                ? jsx(KanbanNotificationsTab, {})
                : activeTab === 'telemetry-sync'
                ? jsx(TelemetrySyncIntervalTab, {})
                : jsxs('section', {
                    className: 'flex flex-col gap-3',
                    children: [
                      jsx('div', { className: 'text-sm font-medium', children: 'Layout' }),
                      jsx(GridLayoutControls, { layout, onChange: onGridChange }),
                                    jsx(Separator, {}),
                      jsx('div', { className: 'text-[0.75rem] text-(--ui-text-tertiary)', children: 'Decision HUD and Retrospective open as full workspace pages. Task List remains docked beside chat.' }),
                    ],
                  }),
            }),
          ],
        }),
      ],
    }),
  })
}


const VALID_HIERARCHY_STATUS_COLORS = {
  pending: 'grey',
  in_progress: 'blue',
  blocked: 'red',
  done: 'green',
}

function parseHierarchyTreeResponse(res) {
  if (!res || typeof res.output !== 'string') throw new Error('hierarchy tree output unavailable')
  const payload = parseTrailingJson(res.output)
  return payload && payload.tree ? payload.tree : payload
}

function hierarchyNodeStatus(node) {
  if (node && VALID_HIERARCHY_STATUS_COLORS[node.status]) return node.status
  if (!node || !node.total_count) return 'pending'
  if (node.done_count === node.total_count) return 'done'
  if (node.done_count > 0) return 'in_progress'
  return 'blocked'
}

function HierarchyStatusDot({ node }) {
  const status = hierarchyNodeStatus(node)
  return jsx('span', {
    className: 'inline-block h-2 w-2 shrink-0 rounded-full',
    style: { backgroundColor: VALID_HIERARCHY_STATUS_COLORS[status] },
    title: status,
    'aria-label': `${status} status`,
  })
}

function hierarchyDecisionMatchesNode(decision, nodeId) {
  if (!decision || !nodeId) return false
  const payload = decision.card_payload
  const parsed = typeof payload === 'string' ? (() => { try { return JSON.parse(payload) } catch { return null } })() : payload
  return !!parsed && parsed._hierarchy_node_id === nodeId
}

function useHierarchyDecisions(projectId) {
  const [state, setState] = React.useState({ decisions: [], loading: true, error: null })
  const refresh = React.useCallback(async () => {
    if (!projectId) {
      setState({ decisions: [], loading: false, error: null })
      return
    }
    try {
      const result = await cliExec(['decision', 'list', '--limit', String(MAX_DECISION_ROWS), '--project-id', projectId])
      setState({ decisions: Array.isArray(result?.decisions) ? result.decisions : [], loading: false, error: null })
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: String(error.message || error) }))
    }
  }, [projectId])
  React.useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])
  return { ...state, refresh }
}

function HierarchyKanbanLink({ node, boardSlug, onChanged }) {
  const [taskIdInput, setTaskIdInput] = React.useState('')
  const [task, setTask] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)

  React.useEffect(() => {
    let active = true
    if (!node.kanban_task_id || !boardSlug) {
      setTask(null)
      return () => { active = false }
    }
    cliExec(['kanban', '--board', boardSlug, 'show', node.kanban_task_id, '--json'])
      .then((value) => active && setTask(value && value.task ? value.task : value))
      .catch((e) => active && setError(String(e.message || e)))
    return () => { active = false }
  }, [boardSlug, node.kanban_task_id])

  const link = async () => {
    const taskId = taskIdInput.trim()
    if (!taskId || busy) return
    setBusy(true)
    setError(null)
    try {
      const value = await cliExec(['kanban', '--board', boardSlug, 'show', taskId, '--json'])
      if (!value || value.ok === false) throw new Error((value && value.error) || 'Kanban card not found')
      await cliExec(['decision', 'node', 'link-kanban', node.id, taskId])
      setTaskIdInput('')
      onChanged()
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  const unlink = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await cliExec(['decision', 'node', 'update', node.id, '--kanban-task', ''])
      onChanged()
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  if (node.kanban_task_id) {
    return jsxs('div', {
      className: 'ml-6 flex flex-wrap items-center gap-2 text-xs text-(--ui-text-secondary)',
      children: [
        jsx('span', { children: task ? `${task.title || node.kanban_task_id} (${task.status || 'unknown'})` : node.kanban_task_id }),
        jsx('button', { type: 'button', disabled: busy, onClick: unlink, className: 'underline disabled:opacity-50', children: 'Unlink' }),
        error ? jsx('span', { className: 'text-(--ui-danger,#e5484d)', children: error }) : null,
      ],
    })
  }

  return jsxs('div', {
    className: 'ml-6 flex flex-wrap items-center gap-2',
    children: [
      jsx('input', {
        value: taskIdInput,
        onChange: (event) => setTaskIdInput(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter') link() },
        placeholder: 'Kanban task ID',
        'aria-label': `Link ${node.title} to Kanban card`,
        className: 'h-6 w-36 rounded border border-(--ui-stroke-secondary) bg-transparent px-1.5 text-xs',
        disabled: busy || !boardSlug,
      }),
      jsx('button', { type: 'button', disabled: busy || !taskIdInput.trim() || !boardSlug, onClick: link, className: 'h-6 rounded border border-(--ui-stroke-secondary) px-2 text-xs disabled:opacity-50', children: busy ? 'Linking…' : 'Link to Kanban card' }),
      error ? jsx('span', { className: 'text-xs text-(--ui-danger,#e5484d)', children: error }) : null,
    ],
  })
}

function HierarchyNodeInspector({ node, decisions, decisionsLoading, decisionsError, projectId, onClose, onDecisionChanged }) {
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!node) return null
  let criteria = []
  try {
    const parsed = node.criteria_json ? JSON.parse(node.criteria_json) : []
    criteria = Array.isArray(parsed) ? parsed : []
  } catch {
    criteria = []
  }
  return jsx('div', {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': `Inspect ${node.title}`,
    className: 'fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6',
    onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
    children: jsxs('div', {
      className: 'flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) shadow-2xl',
      children: [
        jsxs('header', {
          className: 'flex items-start justify-between gap-4 border-b border-(--ui-stroke-secondary) px-6 py-5',
          children: [
            jsxs('div', { children: [
              jsx('div', { className: 'mb-1 text-xs uppercase tracking-wide text-(--ui-text-tertiary)', children: `${node.kind || 'node'} · level ${node.level ?? '—'}` }),
              jsx('h2', { className: 'text-xl font-semibold', children: node.title }),
              jsx('div', { className: 'mt-1 text-sm text-(--ui-text-secondary)', children: node.status || 'draft' }),
            ] }),
            jsx('button', { type: 'button', 'aria-label': 'Close node inspector', onClick: onClose, className: 'rounded border border-(--ui-stroke-secondary) px-3 py-1.5 text-sm text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)', children: 'Close' }),
          ],
        }),
        jsxs('div', {
          className: 'grid min-h-0 flex-1 gap-6 overflow-y-auto p-6 md:grid-cols-[1.2fr_0.8fr]',
          children: [
            jsxs('section', { className: 'flex flex-col gap-5', children: [
              jsxs('div', { children: [jsx('div', { className: 'mb-2 text-xs uppercase tracking-wide text-(--ui-text-tertiary)', children: 'Context' }), jsx('p', { className: 'whitespace-pre-wrap text-sm text-(--ui-text-secondary)', children: node.description || node.note || 'No context recorded yet.' })] }),
              jsxs('div', {
                children: [
                  jsx('div', { className: 'mb-2 text-xs uppercase tracking-wide text-(--ui-text-tertiary)', children: 'Acceptance criteria' }),
                  criteria.length > 0
                    ? jsx('ul', {
                        className: 'flex flex-col gap-2',
                        children: criteria.map((item, index) => jsxs('li', {
                          className: 'flex gap-2 text-sm text-(--ui-text-secondary)',
                          children: [jsx('span', { className: 'text-(--ui-success,#59c18a)', children: '□' }), jsx('span', { children: item })],
                        }, `${node.id}-criteria-${index}`)),
                      })
                    : jsx('div', { className: 'text-sm text-(--ui-text-tertiary)', children: 'No criteria recorded yet.' }),
                ],
              }),
              jsxs('div', { children: [jsx('div', { className: 'mb-2 text-xs uppercase tracking-wide text-(--ui-text-tertiary)', children: 'Rationale' }), jsx('p', { className: 'whitespace-pre-wrap text-sm text-(--ui-text-secondary)', children: node.rationale || 'No rationale recorded yet.' })] }),
            ] }),
            jsxs('aside', { className: 'flex flex-col gap-4 rounded border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-4', children: [
              jsx('div', { className: 'text-xs uppercase tracking-wide text-(--ui-text-tertiary)', children: 'Linked work' }),
              jsxs('div', { className: 'grid gap-2 text-sm', children: [jsx('div', { children: jsxs('span', { className: 'text-(--ui-text-tertiary)', children: ['Node ID: ', jsx('code', { children: node.id })] }) }), jsx('div', { className: 'text-(--ui-text-secondary)', children: node.kanban_task_id ? `Kanban link: ${node.kanban_task_id}` : 'No Kanban link' }), jsx('div', { className: 'text-(--ui-text-secondary)', children: node.total_count > 0 ? `${node.done_count || 0}/${node.total_count} descendants done` : 'No descendant progress yet' })] }),
              jsx('div', { className: 'h-px bg-(--ui-stroke-secondary)' }),
              jsx('div', { className: 'text-xs uppercase tracking-wide text-(--ui-text-tertiary)', children: 'Attached decisions' }),
              decisionsLoading ? jsx('div', { className: 'text-sm text-(--ui-text-tertiary)', children: 'Loading decisions…' }) : null,
              decisionsError ? jsx('div', { className: 'text-sm text-(--ui-danger,#e5484d)', children: decisionsError }) : null,
              decisions.length > 0 ? jsx('div', { className: 'flex flex-col gap-2', children: decisions.map((decision) => jsx(HierarchyAttachedDecision, { key: decision.id, decision, onChanged: onDecisionChanged })) }) : jsx('div', { className: 'text-sm text-(--ui-text-tertiary)', children: 'No decisions attached.' }),
              jsx(HierarchyDecisionComposer, { projectId, selectedNode: node, onPushed: onDecisionChanged }),
            ] }),
          ],
        }),
      ],
    }),
  })
}

function HierarchyTreeNode({ node, depth = 0, boardSlug, projectId, onChanged, onSelect, selectedNodeId, onInspect }) {
  const [expanded, setExpanded] = React.useState(depth < 2)
  const [loadedChildren, setLoadedChildren] = React.useState(Array.isArray(node?.children) ? node.children : [])
  const children = loadedChildren
  const hasChildren = children.length > 0 || node?.level === 4
  const selectNode = () => onSelect(node)
  const handleKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      selectNode()
      return
    }
    if (event.key === 'ArrowRight' && hasChildren && !expanded) {
      event.preventDefault()
      toggleExpanded(event)
      return
    }
    if (event.key === 'ArrowLeft' && hasChildren && expanded) {
      event.preventDefault()
      setExpanded(false)
    }
  }
  const toggleExpanded = async (event) => {
    event.stopPropagation()
    if (!expanded && node?.level === 4 && children.length === 0 && projectId) {
      try {
        const result = await cliExec(['decision', 'node', 'list', '--project', projectId, '--parent', node.id])
        setLoadedChildren(Array.isArray(result?.nodes) ? result.nodes : [])
      } catch (error) {
        host.notify({ kind: 'error', message: String(error.message || error) })
      }
    }
    setExpanded((value) => !value)
  }
  return jsxs('div', {
    className: 'flex flex-col gap-1',
    style: { marginLeft: `${depth * 16}px` },
    children: [
      jsxs('div', {
        role: 'treeitem',
        tabIndex: selectedNodeId === node.id || (selectedNodeId == null && depth === 0) ? 0 : -1,
        'aria-level': depth + 1,
        'aria-selected': selectedNodeId === node.id,
        'aria-expanded': hasChildren ? expanded : undefined,
        className: cn(
          'flex items-center gap-2 rounded px-2 py-1 hover:bg-(--chrome-action-hover)',
          selectedNodeId === node.id ? 'bg-(--chrome-action-active)' : '',
        ),
        onClick: selectNode,
        onDoubleClick: () => onInspect(node),
        onKeyDown: handleKeyDown,
        children: [
          hasChildren
            ? jsx('button', {
                type: 'button',
                className: 'w-4 text-(--ui-text-secondary)',
                'aria-label': expanded ? `Collapse ${node.title}` : `Expand ${node.title}`,
                onClick: toggleExpanded,
                children: expanded ? '▾' : '▸',
              })
            : jsx('span', { className: 'w-4' }),
          jsx(HierarchyStatusDot, { node }),
          jsx('span', { className: 'min-w-0 flex-1 truncate', children: node.title }),
          selectedNodeId === node.id
            ? jsx('button', { type: 'button', 'aria-label': `Inspect ${node.title}`, onClick: (event) => { event.stopPropagation(); onInspect(node) }, className: 'rounded border border-(--ui-stroke-secondary) px-1.5 text-xs text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)', children: 'Inspect' })
            : null,
          node.total_count > 0
            ? jsx('span', { className: 'text-xs text-(--ui-text-tertiary)', children: `${node.done_count}/${node.total_count} done` })
            : null,
        ],
      }),
      node?.level >= 4 && node?.level <= 5
        ? jsx(HierarchyKanbanLink, { node, boardSlug, onChanged })
        : null,
      expanded
        ? children.length > 0
          ? children.map((child) => jsx(HierarchyTreeNode, { key: child.id, node: child, depth: depth + 1, boardSlug, projectId, onChanged, onSelect, selectedNodeId, onInspect }))
          : node?.level === 4
            ? jsx('div', { className: 'pl-8 text-xs text-(--ui-text-tertiary)', children: 'Tasks load when available.' })
            : null
        : null,
    ],
  })
}

function HierarchyDecisionComposer({ projectId, selectedNode, onPushed }) {
  const [question, setQuestion] = React.useState('')
  const [choices, setChoices] = React.useState(['', ''])
  const [pending, setPending] = React.useState(false)
  const push = async () => {
    const cleanQuestion = question.trim()
    const cleanChoices = choices.map((choice) => choice.trim()).filter(Boolean)
    if (!projectId || !selectedNode || !cleanQuestion || cleanChoices.length < 2 || pending) return
    setPending(true)
    try {
      await cliExec([
        'decision', 'push', '--project-id', projectId, '--question', cleanQuestion,
        ...cleanChoices.flatMap((choice) => ['--choice', choice]),
        '--card-payload', JSON.stringify({ _hierarchy_node_id: selectedNode.id }),
      ])
      setQuestion('')
      setChoices(['', ''])
      await onPushed()
      host.notify({ kind: 'success', message: 'Decision attached' })
    } catch (error) {
      host.notify({ kind: 'error', message: String(error.message || error) })
    } finally {
      setPending(false)
    }
  }
  return jsxs('div', { className: 'flex flex-col gap-2 rounded border border-(--ui-stroke-secondary) p-2', children: [
    jsx('div', { className: 'font-medium', children: `Attach decision to ${selectedNode.title}` }),
    jsx('input', { value: question, placeholder: 'Question', onChange: (event) => setQuestion(event.target.value), className: 'rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1' }),
    ...choices.map((choice, index) => jsx('input', { key: index, value: choice, placeholder: `Choice ${index + 1}`, onChange: (event) => setChoices((current) => current.map((item, i) => i === index ? event.target.value : item)), className: 'rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1' })),
    jsx('button', { type: 'button', disabled: pending, onClick: push, className: 'self-start rounded border border-(--ui-stroke-secondary) px-2 py-1 disabled:opacity-50', children: pending ? 'Attaching…' : 'Attach decision' }),
  ] })
}

function HierarchyAttachedDecision({ decision, onChanged }) {
  const [resolving, setResolving] = React.useState(false)
  const resolve = async (id, choice, payload) => {
    setResolving(true)
    try {
      const actorToken = await getActorToken()
      const argv = ['decision', 'resolve', id, choice, '--actor-token', actorToken]
      if (payload) argv.push('--payload', JSON.stringify(payload))
      await cliExec(argv)
      await onChanged()
    } catch (error) {
      host.notify({ kind: 'error', message: String(error.message || error) })
    } finally {
      setResolving(false)
    }
  }
  const defer = async (id) => {
    setResolving(true)
    try {
      await cliExec(['decision', 'defer', id])
      await onChanged()
    } catch (error) {
      host.notify({ kind: 'error', message: String(error.message || error) })
    } finally {
      setResolving(false)
    }
  }
  const dismiss = async (id) => resolve(id, DISMISS_SENTINEL_CHOICE)
  return jsx(DecisionCard, {
    decision,
    onResolve: resolve,
    onDefer: defer,
    onDiscuss: () => {},
    onDismiss: dismiss,
    resolving,
  })
}

function parseFlowResponse(res) {
  if (!res || typeof res.output !== 'string') throw new Error('flow output unavailable')
  const payload = parseTrailingJson(res.output)
  if (!payload || payload.ok !== true) {
    const error = payload?.error
    const message = error && typeof error === 'object' ? error.message : error
    throw new Error(message || 'flow request failed')
  }
  return payload
}

function deriveFlowLayout(steps) {
  const rows = Array.isArray(steps) ? steps : []
  const byId = new Map(rows.map((step) => [step.id, step]))
  const depths = new Map()
  const visit = (id, depth, path = new Set()) => {
    if (path.has(id)) return
    depths.set(id, Math.max(depths.get(id) || 0, depth))
    const next = byId.get(id)?.next || []
    next.forEach((child) => visit(child, depth + 1, new Set([...path, id])))
  }
  if (rows[0]) visit(rows[0].id, 0)
  rows.forEach((step) => { if (!depths.has(step.id)) depths.set(step.id, 0) })
  return rows.map((step, index) => ({ ...step, x: (depths.get(step.id) || 0) * 180, y: index * 72 }))
}

function StarterWorkflowButton({ projectId, boardName, onGenerated }) {
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState(null)
  const run = async () => {
    if (!projectId || busy) return
    setBusy(true)
    setMessage(null)
    try {
      await cliExec(['decision', 'workflow', 'seed-demo', '--project-id', projectId, ...(boardName ? ['--root-title', boardName] : [])])
      setMessage('Starter workflow generated')
      onGenerated?.()
    } catch (error) {
      setMessage(String(error.message || error))
    } finally {
      setBusy(false)
    }
  }
  return jsxs('div', { className: 'flex items-center gap-2', children: [
    jsx('button', { type: 'button', disabled: busy || !projectId, onClick: run, className: 'rounded border border-(--ui-stroke-secondary) px-2 py-1 disabled:opacity-50', children: busy ? 'Generating…' : 'Generate starting workflow' }),
    message ? jsx('span', { role: 'status', className: message === 'Starter workflow generated' ? 'text-(--ui-success,#59c18a)' : 'text-(--ui-danger,#e5484d)', children: message }) : null,
  ] })
}

function FlowchartsPane() {
  const [boardSlug] = React.useState(loadSelectedBoardSlug)
  const { boards, loading: boardsLoading, error: boardsError } = useKanbanBoards()
  const effectiveBoardSlug = boardSlug || pickDefaultBoardSlug(boards)
  const projectId = React.useMemo(() => boards.find((item) => item?.slug === effectiveBoardSlug)?.project_id || null, [boards, effectiveBoardSlug])
  const [state, setState] = React.useState({ loading: true, flows: [], error: null })
  const [selectedId, setSelectedId] = React.useState(null)
  const [revision, setRevision] = React.useState(0)
  const [newName, setNewName] = React.useState(() => '')
  const [rename, setRename] = React.useState('')
  const [stepsText, setStepsText] = React.useState('[]')
  const [mutationLoading, setMutationLoading] = React.useState(false)

  const runFlowCommand = async (argv) => {
    if (mutationLoading) return false
    setMutationLoading(true)
    try {
      const response = await host.request('cli.exec', { argv, timeout: 30 })
      parseFlowResponse(response)
      setState((current) => ({ ...current, error: null }))
      setRevision((value) => value + 1)
      return true
    } catch (error) {
      setState((current) => ({ ...current, error: String(error.message || error) }))
      return false
    } finally {
      /* mutationLoading false after every mutation */
      setMutationLoading(false)
    }
  }

  React.useEffect(() => {
    let active = true
    if (!projectId) { setState((current) => ({ ...current, loading: false, flows: [], error: null })); return () => { active = false } }
    setState((current) => ({ ...current, loading: true, error: null }))
    host.request('cli.exec', { argv: ['decision', 'flow', 'list', '--project', projectId], timeout: 30 })
      .then((res) => { if (!active) return; try { setState((current) => ({ ...current, loading: false, flows: parseFlowResponse(res).flows || [], error: null })) } catch (error) { setState((current) => ({ ...current, loading: false, error: String(error.message || error) })) } })
      .catch((error) => active && setState((current) => ({ ...current, loading: false, error: String(error.message || error) })))
    return () => { active = false }
  }, [projectId, revision])

  const selected = state.flows.find((flow) => flow.id === selectedId) || state.flows[0]
  // Preserve selected identity across refreshes: [selected?.id]
  React.useEffect(() => { setStepsText(selected?.steps_json || '[]'); setRename(selected?.name || '') }, [selected?.id, selected?.steps_json, selected?.name])
  let steps = []
  let malformed = false
  if (selected) { try { steps = JSON.parse(selected.steps_json); if (!Array.isArray(steps)) malformed = true } catch { malformed = true } }
  const layout = malformed ? [] : deriveFlowLayout(steps)
  const content = boardsLoading || state.loading ? 'Loading flowcharts…' : boardsError || state.error ? (boardsError || state.error) : !selected ? 'No flowcharts yet' : malformed ? 'Malformed graph' : steps.length === 0 ? 'No flow steps yet' : layout.map((step) => jsx('div', { key: step.id, className: 'rounded border border-(--ui-stroke-secondary) p-2', style: { marginLeft: `${step.x}px` }, children: `${step.label} (${(step.next || []).join(', ') || 'end'})` }))
  return jsxs('div', { className: 'flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm', children: [
    jsx('div', { className: 'font-medium', children: 'Flowcharts' }),
    state.flows.length > 0 ? jsx('select', { value: selected?.id || '', onChange: (event) => setSelectedId(event.target.value), className: 'rounded border border-(--ui-stroke-secondary) bg-transparent p-1', children: state.flows.map((flow) => jsx('option', { value: flow.id, children: flow.name }, flow.id)) }) : null,
    selected ? jsxs('div', { className: 'flex gap-2', children: [
      jsx('input', { value: rename, placeholder: 'Flow name', 'aria-label': 'Flow name', onChange: (event) => setRename(event.target.value), className: 'min-w-0 flex-1 rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1' }),
      jsx('button', { type: 'button', disabled: mutationLoading || !rename.trim(), onClick: () => runFlowCommand(['decision', 'flow', 'update', '--project', projectId, selected.id, '--name', rename]), className: 'rounded border border-(--ui-stroke-secondary) px-2 py-1 disabled:opacity-50', children: 'Rename flow' }),
    ] }) : null,
    selected ? jsx('textarea', { value: stepsText, onChange: (event) => setStepsText(event.target.value), 'aria-label': 'Flow steps JSON', className: 'min-h-24 rounded border border-(--ui-stroke-secondary) bg-transparent p-2 font-mono text-xs' }) : null,
    selected ? jsx('button', { type: 'button', disabled: mutationLoading, onClick: () => runFlowCommand(['decision', 'flow', 'set-steps', '--project', projectId, selected.id, '--steps', stepsText]), className: 'self-start rounded border border-(--ui-stroke-secondary) px-2 py-1 disabled:opacity-50', children: 'Save steps' }) : null,
    projectId ? jsxs('div', { className: 'flex gap-2', children: [
      jsx('input', { value: newName, placeholder: 'New flow name', onChange: (event) => setNewName(event.target.value), className: 'min-w-0 flex-1 rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1' }),
      jsx('button', { type: 'button', disabled: mutationLoading || !newName.trim(), onClick: async () => { if (await runFlowCommand(['decision', 'flow', 'add', '--project', projectId, '--name', newName])) setNewName('') }, className: 'rounded border border-(--ui-stroke-secondary) px-2 py-1 disabled:opacity-50', children: 'Add' }),
    ] }) : null,
    jsx('div', { className: 'flex flex-col gap-2', children: content }),
    selected && projectId ? jsx('button', { type: 'button', onClick: () => setRevision((value) => value + 1), className: 'self-start rounded border border-(--ui-stroke-secondary) px-2 py-1', children: 'Refresh' }) : null,
  ] })
}

function RoadmapPane() {
  const { projectId, loading: scopeLoading, error: scopeError } = useProjectDashboardScope()
  const [state, setState] = React.useState({ loading: true, lanes: [], items: [], error: null })
  const [revision, setRevision] = React.useState(0)
  const [mutationLoading, setMutationLoading] = React.useState(false)
  const [laneDraft, setLaneDraft] = React.useState('')
  const [itemDraft, setItemDraft] = React.useState({ laneId: '', title: '', description: '', status: 'planned', sortOrder: '0', dependsOn: '', links: '' })
  const [drafts, setDrafts] = React.useState({})
  const setError = (error) => setState((current) => ({ ...current, loading: false, error: String(error.message || error) }))
  const setLoading = (value) => setMutationLoading(value)

  const refresh = React.useCallback(() => setRevision((value) => value + 1), [])
  const reload = refresh


  React.useEffect(() => {
    let active = true
    if (!projectId) {
      setState({ loading: false, lanes: [], items: [], error: null })
      return () => { active = false }
    }
    setState((current) => ({ ...current, loading: true, error: null }))
    const roadmapListCommand = ['roadmap', 'list', '--project-id', projectId]
    cliExec(roadmapListCommand)
      .then((res) => {
        if (!active) return
        const roadmap = res?.roadmap || res || {}
        setState({ loading: false, lanes: Array.isArray(roadmap.lanes) ? roadmap.lanes : [], items: Array.isArray(roadmap.items) ? roadmap.items : [], error: null })
      })
      .then(null, (error) => {
        if (!active) return
        setError(error)
      })
    return () => { active = false }
  }, [projectId, revision])
  React.useEffect(() => {}, [projectId])

  // runUpdate('roadmap', 'item', 'update') is the item mutation shape.
  async function runUpdate(argv) {
    if (!projectId || mutationLoading) return false
    setLoading(true)
    try {
      return await cliExec(argv).then(() => true)
    } finally {
      setLoading(false)
    }
  }

  const submit = async (operation, draftKey, argv, onSuccess) => {
    try {
      if (await runUpdate(argv)) {
        setDraft('')
        setDrafts((current) => ({ ...current, [draftKey]: '' }))
        setState((current) => ({ ...current, error: null }))
        refresh()
        onSuccess?.()
      }
    } catch (error) {
      setError(error)
    }
  }
  const setDraft = (value) => setDrafts((current) => ({ ...current, last: value }))

  const listValues = (value) => value.split('\n').map((entry) => entry.trim()).filter(Boolean)
  const relationshipArgs = (draft) => {
    const argv = []
    if (draft.dependsOn !== null && draft.dependsOn !== undefined) {
      listValues(draft.dependsOn).forEach((value) => argv.push('--depends-on', value))
      if (listValues(draft.dependsOn).length === 0) argv.push('--clear-depends-on')
    }
    if (draft.links !== null && draft.links !== undefined) {
      listValues(draft.links).forEach((value) => argv.push('--link', value))
      if (listValues(draft.links).length === 0) argv.push('--clear-links')
    }
    return argv
  }
  const content = scopeLoading || state.loading
    ? 'Loading roadmap…'
    : scopeError || state.error
      ? (scopeError || state.error)
      : state.lanes.length === 0
        ? 'No roadmap lanes yet'
        : state.lanes.map((lane) => {
          const laneItems = state.items.filter((item) => item.lane_id === lane.id)
          const laneTitle = drafts[`lane:${lane.id}`] ?? lane.title ?? ''
          return jsxs('section', { key: lane.id, className: 'flex flex-col gap-2 rounded border border-(--ui-stroke-secondary) p-2', children: [
            jsxs('div', { className: 'flex gap-2', children: [
              jsx('input', { value: laneTitle, 'aria-label': `Lane ${lane.id}`, onChange: (event) => setDrafts((current) => ({ ...current, [`lane:${lane.id}`]: event.target.value })), className: 'min-w-0 flex-1 rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1' }),
              jsx('button', { type: 'button', disabled: mutationLoading || !laneTitle.trim(), onClick: () => submit('lane', `lane:${lane.id}`, ['roadmap', 'lane', 'update', '--project-id', projectId, '--lane-id', lane.id, '--title', laneTitle, '--sort-order', String(lane.sort_order ?? 0), '--expected-updated-at', String(lane.updated_at ?? '')]), children: 'Save lane' }),
            ] }),
            laneItems.map((item) => {
              const itemId = item.id
              const updatedAt = item.updated_at
              const draft = drafts[`item:${itemId}`] || { title: item.title || '', description: item.description || '', status: item.status || 'planned', laneId: item.lane_id, sortOrder: String(item.sort_order ?? 0), dependsOn: null, links: null }
              const setDraft = (field, value) => setDrafts((current) => ({ ...current, [`item:${item.id}`]: { ...draft, [field]: value } }))
              const argv = ['roadmap', 'item', 'update', '--project-id', projectId, '--item-id', itemId, '--lane-id', draft.laneId, '--title', draft.title, '--description', draft.description, '--status', draft.status, '--sort-order', String(draft.sortOrder), '--expected-updated-at', String(updatedAt ?? ''), ...relationshipArgs(draft)]
              return jsxs('div', { key: item.id, className: 'flex flex-col gap-1 border-t border-(--ui-stroke-secondary) pt-2', children: [
                jsx('input', { value: draft.title, 'aria-label': `Item ${item.id} title`, onChange: (event) => setDraft('title', event.target.value) }),
                jsx('textarea', { value: draft.description, 'aria-label': `Item ${item.id} description`, onChange: (event) => setDraft('description', event.target.value) }),
                jsx('input', { value: draft.status, 'aria-label': `Item ${item.id} status`, onChange: (event) => setDraft('status', event.target.value) }),
                jsx('textarea', { value: draft.dependsOn ?? '', 'aria-label': `Item ${item.id} dependencies`, onChange: (event) => setDraft('dependsOn', event.target.value) }),
                jsx('textarea', { value: draft.links ?? '', 'aria-label': `Item ${item.id} links`, onChange: (event) => setDraft('links', event.target.value) }),
                jsx('button', { type: 'button', disabled: mutationLoading || !draft.title.trim(), onClick: () => submit('item', `item:${item.id}`, argv), children: 'Save item' }),
              ] })
            }),
          ] })
        })

  return jsxs('div', { className: 'flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm', children: [
    jsx('div', { className: 'font-medium', children: 'Roadmap' }),
    projectId ? jsxs('div', { className: 'flex gap-2', children: [
      jsx('input', { value: laneDraft, placeholder: 'New lane', onChange: (event) => setLaneDraft(event.target.value) }),
      jsx('button', { type: 'button', disabled: mutationLoading || !laneDraft.trim(), onClick: () => submit('lane', 'new-lane', ['roadmap', 'lane', 'add', '--project-id', projectId, '--title', laneDraft, '--sort-order', '0'], () => setLaneDraft('')), children: 'Add lane' }),
    ] }) : null,
    projectId && state.lanes.length > 0 ? jsxs('div', { className: 'flex gap-2', children: [
      jsx('select', { value: itemDraft.laneId || state.lanes[0]?.id || '', onChange: (event) => setItemDraft((current) => ({ ...current, laneId: event.target.value })), children: state.lanes.map((lane) => jsx('option', { value: lane.id, children: lane.title }, lane.id)) }),
      jsx('input', { value: itemDraft.title, placeholder: 'New item', onChange: (event) => setItemDraft((current) => ({ ...current, title: event.target.value })) }),
      jsx('button', { type: 'button', disabled: mutationLoading || !itemDraft.title.trim(), onClick: () => submit('item', 'new-item', ['roadmap', 'item', 'add', '--project-id', projectId, '--lane-id', itemDraft.laneId || state.lanes[0]?.id || '', '--title', itemDraft.title, '--description', itemDraft.description, '--status', itemDraft.status, '--sort-order', itemDraft.sortOrder, ...listValues(itemDraft.dependsOn).flatMap((value) => ['--depends-on', value]), ...listValues(itemDraft.links).flatMap((value) => ['--link', value])], () => setItemDraft({ laneId: '', title: '', description: '', status: 'planned', sortOrder: '0', dependsOn: '', links: '' })), children: 'Add item' }),
    ] }) : null,
    jsx('div', { className: 'flex flex-col gap-2', children: content }),
    projectId ? jsx('button', { type: 'button', onClick: reload, children: 'Refresh' }) : null,
  ] })
}

function HierarchyMapPane() {
  const [boardSlug] = React.useState(loadSelectedBoardSlug)
  const { boards, loading: boardsLoading, error: boardsError } = useKanbanBoards()
  const effectiveBoardSlug = boardSlug || pickDefaultBoardSlug(boards)
  const projectId = React.useMemo(() => {
    const board = boards.find((item) => item && item.slug === effectiveBoardSlug)
    return board ? board.project_id || null : null
  }, [boards, effectiveBoardSlug])
  const boardName = React.useMemo(() => {
    const board = boards.find((item) => item && item.slug === effectiveBoardSlug)
    return board?.name || effectiveBoardSlug || null
  }, [boards, effectiveBoardSlug])
  const [state, setState] = React.useState({ loading: true, tree: null, error: null })
  const [treeRevision, setTreeRevision] = React.useState(0)
  const [selectedNode, setSelectedNode] = React.useState(null)
  const [inspectedNode, setInspectedNode] = React.useState(null)
  const { decisions, loading: decisionsLoading, error: decisionsError, refresh: refreshDecisions } = useHierarchyDecisions(projectId)

  React.useEffect(() => {
    if (inspectedNode && selectedNode && inspectedNode.id === selectedNode.id) setInspectedNode(selectedNode)
  }, [selectedNode, inspectedNode])
  React.useEffect(() => {
    let active = true
    if (!projectId) {
      setState({ loading: false, tree: null, error: null })
      return () => { active = false }
    }
    setState({ loading: true, tree: null, error: null })
    host.request('cli.exec', { argv: ['decision', 'node', 'tree', '--project', projectId], timeout: 30 })
      .then((res) => {
        if (!active) return
        if (res && res.code !== 0 && /no hierarchy root/i.test(res.output || '')) {
          setState({ loading: false, tree: null, error: null })
          return
        }
        try {
          setState({ loading: false, tree: parseHierarchyTreeResponse(res), error: null })
        } catch (error) {
          setState({ loading: false, tree: null, error: String(error.message || error) })
        }
      })
      .catch((error) => active && setState({ loading: false, tree: null, error: String(error.message || error) }))
    return () => { active = false }
  }, [projectId, treeRevision])

  const attachedDecisions = selectedNode ? decisions.filter((decision) => hierarchyDecisionMatchesNode(decision, selectedNode.id)) : []
  const inspectedDecisions = inspectedNode ? decisions.filter((decision) => hierarchyDecisionMatchesNode(decision, inspectedNode.id)) : []
  const content = boardsLoading || state.loading
    ? 'Loading map…'
    : boardsError || state.error
      ? (boardsError || state.error)
      : !state.tree
        ? jsx('section', { className: 'flex max-w-xl flex-col gap-3 rounded border border-(--ui-stroke-secondary) p-4', children: [
            jsx('div', { className: 'font-medium', children: 'No workflow data yet' }),
            jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'Generate the project-scoped starter MindMap, roadmap, flowchart, architecture, risk, tradeoff, and Scrum Planning items.' }),
            jsx(StarterWorkflowButton, { projectId, boardName, onGenerated: () => setTreeRevision((value) => value + 1) }),
          ] })
        : jsx('div', {
            role: 'tree',
            'aria-label': 'Project hierarchy',
            className: 'flex flex-col gap-1',
            children: jsx(HierarchyTreeNode, {
              key: treeRevision,
              node: state.tree,
              boardSlug: effectiveBoardSlug,
              projectId,
              onChanged: () => setTreeRevision((value) => value + 1),
              onSelect: setSelectedNode,
              onInspect: setInspectedNode,
              selectedNodeId: selectedNode?.id,
            }),
          })
  return jsx('div', { className: 'flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm', children: [
    jsx('div', { className: 'font-medium', children: 'Map' }),
    content,
    selectedNode ? jsxs('section', { className: 'flex flex-col gap-2 border-t border-(--ui-stroke-secondary) pt-3', children: [
      jsx('div', { className: 'font-medium', children: `Decisions for ${selectedNode.title}` }),
      decisionsLoading ? jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'Loading decisions…' }) : null,
      decisionsError ? jsx('div', { className: 'text-(--ui-danger,#e5484d)', children: decisionsError }) : null,
      ...attachedDecisions.map((decision) => jsx(HierarchyAttachedDecision, { key: decision.id, decision, onChanged: refreshDecisions })),
      jsx(HierarchyDecisionComposer, { projectId, selectedNode, onPushed: refreshDecisions }),
    ] }) : null,
    inspectedNode
      ? jsx(HierarchyNodeInspector, {
          node: inspectedNode,
          decisions: inspectedDecisions,
          decisionsLoading,
          decisionsError,
          projectId,
          onClose: () => setInspectedNode(null),
          onDecisionChanged: refreshDecisions,
        })
      : null,
  ] })
}

const SCRUM_PLANNING_STATUSES = ["backlog", "ready", "in_progress", "done", "cancelled"]
const SCRUM_PLANNING_ESTIMATES = [1, 2, 3, 5, 8, 13]

function ScrumPlanningPane() {
  const { projectId, loading: scopeLoading, error: scopeError } = useProjectDashboardScope()
  const [state, setState] = React.useState({ loading: true, items: [], error: null })
  const [busy, setBusy] = React.useState(false)
  const [revision, setRevision] = React.useState(0)

  React.useEffect(() => {
    let active = true
    if (!projectId) {
      setState({ loading: false, items: [], error: null })
      return () => { active = false }
    }
    setState((current) => ({ ...current, loading: true, error: null }))
    cliExec(['scrum', 'plan', 'list', '--project-id', projectId]).then((result) => {
      if (active) setState({ loading: false, items: Array.isArray(result?.planning_items) ? result.planning_items : [], error: null })
    }).catch((error) => {
      if (active) setState({ loading: false, items: [], error: String(error.message || error) })
    })
    return () => { active = false }
  }, [projectId, revision])

  const mutate = async (argv) => {
    if (busy) return
    setBusy(true)
    try {
      await cliExec(argv)
      setRevision((value) => value + 1)
    } catch (error) {
      setState((current) => ({ ...current, error: String(error.message || error) }))
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    const specNodeId = window.prompt('Spec node ID')
    const title = window.prompt('Planning item title')
    const sprint = window.prompt('Sprint number', '1')
    if (!projectId || !specNodeId?.trim() || !title?.trim() || !sprint?.trim()) return
    await mutate(['scrum', 'plan', 'add', '--project-id', projectId, '--spec-node-id', specNodeId.trim(), '--title', title.trim(), '--status', 'backlog', '--estimate', '1', '--sprint', sprint.trim()])
  }

  const content = scopeLoading ? 'Loading Scrum Planning…'
    : scopeError || state.error ? (scopeError || state.error)
      : !projectId ? 'Select a board in Decision HUD.'
        : state.loading ? 'Loading Scrum Planning…'
          : state.items.length === 0 ? 'No planning items yet.'
            : state.items.map((item) => jsxs('div', { className: 'flex flex-col gap-2 rounded border border-(--ui-stroke-secondary) p-2', children: [
              jsx('div', { className: 'font-medium', children: item.title }),
              jsx('div', { className: 'text-(--ui-text-tertiary)', children: item.spec_node_id }),
              jsxs('div', { className: 'flex gap-2', children: [
                jsx('select', { value: item.status, disabled: busy, 'aria-label': `Status for ${item.id}`, onChange: (event) => mutate(['scrum', 'plan', 'update', '--project-id', projectId, '--item-id', item.id, '--status', event.target.value]) , children: SCRUM_PLANNING_STATUSES.map((status) => jsx('option', { value: status, children: status }, status)) }),
                jsx('select', { value: String(item.estimate), disabled: busy, 'aria-label': `Estimate for ${item.id}`, onChange: (event) => mutate(['scrum', 'plan', 'update', '--project-id', projectId, '--item-id', item.id, '--estimate', event.target.value]), children: SCRUM_PLANNING_ESTIMATES.map((estimate) => jsx('option', { value: String(estimate), children: `${estimate} points` }, estimate)) }),
                jsx('button', { type: 'button', disabled: busy, onClick: () => mutate(['scrum', 'plan', 'delete', '--project-id', projectId, '--item-id', item.id]), children: 'Delete' }),
              ] }),
            ] }, item.id))
  return jsxs('div', { className: 'flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm', children: [
    jsxs('div', { className: 'flex items-center justify-between', children: [
      jsx('div', { className: 'font-medium', children: 'Scrum Planning' }),
      jsx('button', { type: 'button', disabled: busy || !projectId, onClick: add, children: 'Add planning item' }),
    ] }),
    jsx('div', { className: 'flex flex-col gap-2', children: content }),
  ] })
}

const DAY_REFRESH_MS = 60 * 1000
const PRESENCE_TOUCH_MS = 60 * 1000
const OBSERVER_POLL_MS = 60 * 1000

const DAY_HATS = [
  { id: 'spec', label: 'Spec' },
  { id: 'review', label: 'Review' },
  { id: 'decide', label: 'Decide' },
  { id: 'retro', label: 'Retro' },
]

const DAY_CEREMONY_LABELS = {
  sprint_planning: 'Sprint planning',
  refinement: 'Refinement',
  review: 'Review',
  decision_sweep: 'Decision sweep',
  mini_retro: 'Mini retro',
  retro_review: 'Retro: review the log',
  process_changes: 'Retro: process changes',
  block_planning: 'Retro: plan the block',
  ready_first_feature: 'Retro: ready the first feature',
}

function formatCountdown(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
  const rest = String(seconds % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${minutes}:${rest}` : `${minutes}:${rest}`
}

// Runs while the page is open: tells the backend you are interacting (so the one-hour
// idle expiry measures real idleness) and asks for the standup that is due. The backend
// decides everything (online? retro hour? already reported?) and answers `reported: false`
// when nothing is due, so asking often is cheap and safe.
function startCadenceWatchers() {
  let active = true
  let lastTouch = 0
  const touch = () => {
    const now = Date.now()
    if (now - lastTouch < PRESENCE_TOUCH_MS) return
    lastTouch = now
    cliExec(['decision', 'presence', 'touch']).catch(() => {})
  }
  const events = ['pointerdown', 'keydown']
  for (const name of events) window.addEventListener(name, touch, { passive: true })

  const standup = async () => {
    if (!active) return
    try {
      const result = await cliExec(['decision', 'observer', 'standup'])
      if (active && result?.reported && result.standup) {
        const attention = result.standup.data?.attention || []
        host.notify({ kind: 'info', message: `Standup: ${attention.length ? attention.join(' · ') : 'nothing needs attention'}` })
      }
    } catch {
      // a transient CLI hiccup: the next poll asks again
    }
  }
  standup()
  const interval = setInterval(standup, OBSERVER_POLL_MS)
  if (typeof interval?.unref === 'function') interval.unref()
  return () => {
    active = false
    clearInterval(interval)
    for (const name of events) window.removeEventListener(name, touch)
  }
}

function CadenceWatchers() {
  React.useEffect(() => startCadenceWatchers(), [])
  return null
}

function formatClockTime(iso) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function DayPane() {
  const [snapshot, setSnapshot] = React.useState({ loading: true, error: null, data: null, presence: null, standup: null, fetchedAt: 0 })
  const [nowMs, setNowMs] = React.useState(0)
  const [revision, setRevision] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [hours, setHours] = React.useState('5')
  const [preview, setPreview] = React.useState({ plan: null, error: null })
  const data = snapshot.data
  const active = data?.active === true

  React.useEffect(() => {
    let live = true
    // Presence and the latest standup are secondary: if either fails the day still shows.
    Promise.all([
      cliExec(['decision', 'day', 'status']),
      cliExec(['decision', 'presence', 'status']).catch(() => null),
      cliExec(['decision', 'observer', 'latest']).catch(() => null),
    ]).then(([result, presenceResult, latest]) => {
      if (!live) return
      const at = Date.now()
      setNowMs(at)
      setSnapshot({ loading: false, error: null, data: result, presence: presenceResult?.presence ?? null, standup: latest?.standup ?? null, fetchedAt: at })
    }).catch((error) => {
      if (live) setSnapshot((current) => ({ ...current, loading: false, error: String(error.message || error) }))
    })
    return () => { live = false }
  }, [revision])

  // Presence can change without a click (the idle expiry), and a new standup arrives
  // every 20 minutes, so refresh quietly once a minute.
  React.useEffect(() => {
    const timer = setInterval(() => setRevision((value) => value + 1), DAY_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  // Seconds until the running phase (or the day's start) ends, counted down locally
  // from the moment the status arrived. When it reaches zero the status is refetched.
  const deadline = !active ? null
    : data.state === 'in_progress' ? data.current?.phase?.seconds_remaining ?? null
      : data.state === 'not_started' ? data.starts_in_seconds ?? null
        : null
  const remaining = deadline == null ? null : deadline - Math.floor((nowMs - snapshot.fetchedAt) / 1000)

  React.useEffect(() => {
    if (deadline == null) return undefined
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [deadline, snapshot.fetchedAt])

  React.useEffect(() => {
    if (remaining != null && remaining <= 0 && nowMs - snapshot.fetchedAt >= 900) setRevision((value) => value + 1)
  }, [remaining])

  const hoursValue = Number.parseInt(hours, 10)
  React.useEffect(() => {
    let live = true
    if (!data || active || snapshot.loading || Number.isNaN(hoursValue)) {
      setPreview({ plan: null, error: null })
      return () => { live = false }
    }
    cliExec(['decision', 'day', 'plan', '--hours', String(hoursValue)]).then((result) => {
      if (live) setPreview({ plan: result?.plan ?? null, error: null })
    }).catch((error) => {
      if (live) setPreview({ plan: null, error: String(error.message || error) })
    })
    return () => { live = false }
  }, [hoursValue, active, snapshot.loading, data == null])

  const act = async (argv) => {
    if (busy) return
    setBusy(true)
    try {
      await cliExec(argv)
      setRevision((value) => value + 1)
    } catch (error) {
      setSnapshot((current) => ({ ...current, error: String(error.message || error) }))
    } finally {
      setBusy(false)
    }
  }

  const button = 'rounded border border-(--ui-stroke-secondary) px-2 py-1 disabled:opacity-50'
  let body
  if (snapshot.loading) {
    body = jsx('p', { children: 'Loading Day…' })
  } else if (!data) {
    // The day's state is unknown, so offering to start one could duplicate it.
    body = jsx('button', {
      type: 'button', className: `${button} self-start`,
      onClick: () => { setSnapshot((current) => ({ ...current, loading: true, error: null })); setRevision((value) => value + 1) },
      children: 'Retry',
    })
  } else if (!active) {
    body = jsxs('div', { className: 'flex flex-col gap-3', children: [
      jsxs('label', { className: 'flex items-center gap-2', children: [
        'Hours available today',
        jsx('input', {
          type: 'number', min: 3, max: 24, value: hours, 'aria-label': 'Hours available today',
          onChange: (event) => setHours(event.target.value),
          className: 'w-20 rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1',
        }),
      ] }),
      preview.error ? jsx('p', { role: 'alert', children: preview.error }) : null,
      preview.plan ? jsx('p', { 'data-testid': 'day-layout', children: `Layout: ${preview.plan.layout} (retro + work hours per block)` }) : null,
      jsx('button', {
        type: 'button', className: `${button} self-start`, disabled: busy || !preview.plan,
        onClick: () => act(['decision', 'day', 'start', '--hours', String(hoursValue)]),
        children: 'Start day',
      }),
    ] })
  } else {
    const current = data.current
    const phase = current?.phase
    const blockCount = data.day.blocks
    const blocks = []
    for (const hour of data.day.hours) {
      if (!blocks[hour.block - 1]) blocks[hour.block - 1] = []
      blocks[hour.block - 1].push(hour)
    }
    body = jsxs('div', { className: 'flex flex-col gap-3', children: [
      current && phase ? jsxs('section', { className: 'flex flex-col gap-1 rounded border border-(--ui-stroke-secondary) p-3', 'aria-label': 'Current phase', children: [
        jsx('div', { className: 'text-base font-medium', children: DAY_CEREMONY_LABELS[phase.ceremony] || phase.ceremony }),
        jsx('div', { className: 'text-(--ui-text-tertiary)', children: `Block ${current.block} of ${blockCount} · ${current.kind === 'retro' ? 'Retro hour' : `Work hour ${current.hour - 1}`}` }),
        jsx('div', { 'data-testid': 'day-countdown', children: `${formatCountdown(remaining ?? phase.seconds_remaining)} left in this phase` }),
        jsx('div', { children: phase.next_best_action }),
      ] }) : null,
      data.state === 'not_started' ? jsx('p', { 'data-testid': 'day-countdown', children: `The day starts in ${formatCountdown(remaining ?? data.starts_in_seconds)}` }) : null,
      data.state === 'finished' ? jsx('p', { children: "Today's schedule is complete." }) : null,
      jsxs('div', { className: 'flex flex-wrap items-center gap-2', role: 'group', 'aria-label': 'Hat', children: [
        jsx('span', { children: 'You are wearing:' }),
        ...DAY_HATS.map((hat) => jsx('button', {
          key: hat.id, type: 'button', disabled: busy, 'aria-pressed': data.current_hat === hat.id,
          className: `${button} ${data.current_hat === hat.id ? 'bg-(--chrome-action-hover)' : ''}`,
          onClick: () => act(['decision', 'day', 'hat', '--hat', hat.id]),
          children: phase?.suggested_hat === hat.id ? `${hat.label} (suggested)` : hat.label,
        })),
      ] }),
      jsx('div', { className: 'flex flex-col gap-2', 'aria-label': 'Timeline', children: blocks.map((blockHours, index) => jsxs('div', { className: 'flex flex-wrap items-center gap-2', children: [
        jsx('span', { className: 'text-(--ui-text-tertiary)', children: `Block ${index + 1} (${blockHours.length - 1} work)` }),
        ...blockHours.map((hour) => jsx('span', {
          key: `${hour.block}-${hour.hour}`,
          className: `rounded border border-(--ui-stroke-secondary) px-2 py-0.5 ${current && hour.block === current.block && hour.hour === current.hour ? 'bg-(--chrome-action-hover) font-medium' : ''}`,
          children: `${hour.kind === 'retro' ? 'R' : `W${hour.hour - 1}`} ${formatClockTime(hour.start)}`,
        })),
      ] }, index)) }),
      jsx('button', { type: 'button', className: `${button} self-start`, disabled: busy, onClick: () => act(['decision', 'day', 'end']), children: 'End day' }),
    ] })
  }
  const online = snapshot.presence?.online === true
  const standup = snapshot.standup?.data
  return jsxs('div', { className: 'flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm', children: [
    jsx('div', { className: 'font-medium', children: active ? `Day · ${data.day.date} · ${data.day.layout}` : 'Day' }),
    snapshot.error ? jsx('p', { role: 'alert', children: snapshot.error }) : null,
    snapshot.presence ? jsxs('div', { className: 'flex flex-wrap items-center gap-2', children: [
      jsx('button', {
        type: 'button', className: `${button} ${online ? 'bg-(--chrome-action-hover)' : ''}`, disabled: busy, 'aria-pressed': online,
        onClick: () => act(['decision', 'presence', online ? 'off' : 'on']),
        children: online ? 'Online' : 'Offline',
      }),
      jsx('span', { className: 'text-(--ui-text-tertiary)', children: online
        ? `Standups every 20 minutes. Turns itself off after an hour without interaction. Online since ${formatClockTime(snapshot.presence.since)}.`
        : 'Go online to get standups every 20 minutes.' }),
    ] }) : null,
    body,
    active && standup ? jsxs('section', { className: 'flex flex-col gap-1 rounded border border-(--ui-stroke-secondary) p-3', 'aria-label': 'Latest standup', children: [
      jsx('div', { className: 'font-medium', children: `Latest standup · ${formatClockTime(snapshot.standup.ts)}` }),
      standup.kanban?.available
        ? jsx('div', { className: 'text-(--ui-text-tertiary)', children: `Kanban: ${Object.entries(standup.kanban.totals || {}).map(([status, count]) => `${count} ${status}`).join(', ') || 'no tasks'}` })
        : jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'Kanban could not be read.' }),
      standup.attention?.length
        ? jsx('ul', { className: 'list-disc pl-5', children: standup.attention.map((item) => jsx('li', { children: item }, item)) })
        : jsx('div', { children: 'Nothing needs attention.' }),
    ] }) : null,
  ] })
}

const ENGINEERING_TABS = [
  { id: 'queue', label: 'Queue', codicon: 'checklist' },
  { id: 'day', label: 'Day', codicon: 'clock' },
  { id: 'mindmap', label: 'MindMap', codicon: 'type-hierarchy-sub' },
  { id: 'roadmap', label: 'Roadmap', codicon: 'milestone' },
  { id: 'riskTradeoff', label: 'Risk & Tradeoffs', codicon: 'warning' },
  { id: 'flowcharts', label: 'Flowcharts', codicon: 'graph' },
  { id: 'architecture', label: 'Architecture', codicon: 'symbol-class' },
  { id: 'spec', label: 'Spec Digest', codicon: 'file-tree' },
  { id: 'planning', label: 'Scrum Planning', codicon: 'calendar' },
]

function DecisionQueuePane({ projectId }) {
  // Dedicated tab for the actual pending-decision queue: card-stack
  // rendering was previously built (useDecisionQueue + DecisionCard) but
  // never exposed in ENGINEERING_TABS after the workflow-tabs rewrite, so
  // this is the first UI surface that calls it.
  const { decisions, loading, error, refresh } = useDecisionQueue(projectId, 50)
  const [resolving, setResolving] = React.useState(false)

  const onResolve = React.useCallback(async (id, choice, payload) => {
    haptic('tap')
    setResolving(true)
    try {
      const actorToken = await getActorToken()
      const argv = ['decision', 'resolve', id, choice, '--actor-token', actorToken]
      if (payload) argv.push('--payload', JSON.stringify(payload))
      await cliExec(argv)
      host.notify({ kind: 'success', message: `Resolved: ${choice}` })
      await refresh()
    } catch (e) {
      host.notify({ kind: 'error', message: String(e.message || e) })
    } finally {
      setResolving(false)
    }
  }, [refresh])

  const onDefer = React.useCallback(async (id) => {
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
  }, [refresh])

  const onDismiss = React.useCallback(async (id) => {
    if (!window.confirm('Dismiss this decision? It will be marked resolved and removed from the queue.')) return
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
  }, [refresh])

  if (!projectId) {
    return jsx('div', { className: 'flex h-full items-center justify-center p-6 text-(--ui-text-tertiary)', children: 'Select a project to see its decision queue.' })
  }
  if (loading && decisions.length === 0) {
    return jsx('div', { className: 'flex h-full items-center justify-center p-6 text-(--ui-text-tertiary)', children: 'Loading queue…' })
  }
  if (error) {
    return jsx('div', { className: 'p-3 text-[0.8rem] text-(--ui-danger,#e5484d)', children: error })
  }
  if (decisions.length === 0) {
    return jsx('div', { className: 'flex h-full items-center justify-center p-6 text-(--ui-text-tertiary)', children: 'No pending decisions.' })
  }
  return jsx('div', {
    className: 'flex flex-col gap-2 p-1',
    children: decisions.map((decision) => jsx(CardErrorBoundary, {
      decisionId: decision.id,
      children: jsx(DecisionCard, {
        decision,
        onResolve,
        onDefer,
        onDiscuss: () => {},
        onDismiss,
        resolving,
      }),
    }, decision.id)),
  })
}

function DecisionHudPane({ rest }) {
  // The selected board is the sole project scope: boards and projects are
  // intentionally one-to-one.
  // Initialized from + persisted to SELECTED_BOARD_STORAGE_KEY so routed workflow panes
  const [selectedBoard, setSelectedBoardState] = React.useState(loadSelectedBoardSlug)
  const [activeTab, setActiveTab] = React.useState('day')
  const [selectedSpecNodeId, setSelectedSpecNodeId] = React.useState(null)
  const [starterRevision, setStarterRevision] = React.useState(0)
  const setSelectedBoard = React.useCallback((slug) => {
    setSelectedBoardState(slug)
    saveSelectedBoardSlug(slug)
  }, [])
  const [resolving, setResolving] = React.useState(false)
  const [gridLayout, setGridLayout] = React.useState(loadGridLayout)
  const [settingsFullscreenOpen, setSettingsFullscreenOpen] = React.useState(false)
  const { boards, error: boardsError, refresh: refreshBoards } = useKanbanBoards()

  React.useEffect(() => startNewDecisionToastWatcher(), [])
  React.useEffect(() => startCadenceWatchers(), [])

  React.useEffect(() => {
    if (!selectedBoard && boards.length > 0) {
      // Same "default"-slug preference as useProjectDashboardScope, so
      // Decision HUD and other workflow tabs converge on the same auto-picked board.
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

  const selectedBoardName = React.useMemo(() => {
    const board = boards.find((b) => b && b.slug === boardForControls)
    return board?.name || boardForControls || null
  }, [boards, boardForControls])

  const handleGridChange = React.useCallback((next) => {
    setGridLayout(next)
    saveGridLayout(next)
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
        await refreshBoards()
      } catch (e) {
        host.notify({ kind: 'error', message: String(e.message || e) })
      } finally {
        setResolving(false)
      }
    },
    [refreshBoards]
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
        await refreshBoards()
      } catch (e) {
        host.notify({ kind: 'error', message: String(e.message || e) })
      } finally {
        setResolving(false)
      }
    },
    [refreshBoards]
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
        await refreshBoards()
      } catch (e) {
        host.notify({ kind: 'error', message: String(e.message || e) })
      } finally {
        setResolving(false)
      }
    },
    [refreshBoards]
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

  const mainColumn = jsxs('div', {
    className: 'relative flex min-w-0 flex-1 flex-col gap-3',
    children: [
      jsxs('div', {
        className: 'relative flex flex-wrap items-center gap-x-2 gap-y-1',
        children: [
          jsxs('div', {
            className: 'flex min-w-0 flex-wrap items-center gap-2',
            children: [
              jsx('div', { className: 'shrink-0 font-medium', children: 'Software Engineering Workflow' }),
              jsx(BoardSettingsPanel, { boardSlug: boardForControls }),
              jsx(BoardSelector, { boards, active: boardForControls, onSelect: setSelectedBoard }),
              jsx(TriageBlockedWorkButton, { boardSlug: boardForControls, projectId: selectedBoardProjectId, onComplete: () => {} }),
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
      jsx('div', {
        role: 'tablist',
        'aria-label': 'Software Engineering sections',
        className: 'flex shrink-0 gap-1 overflow-x-auto border-b border-(--ui-stroke-secondary) pb-1',
        children: [
          ...ENGINEERING_TABS.map((tab) => jsx('button', {
            type: 'button',
            role: 'tab',
            'aria-selected': activeTab === tab.id,
            onClick: () => setActiveTab(tab.id),
            className: cn(
              'flex shrink-0 items-center gap-1 rounded px-2.5 py-1.5 text-[0.78rem] transition-colors',
              activeTab === tab.id
                ? 'bg-(--chrome-action-active) text-(--ui-text-primary)'
                : 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)',
            ),
            children: [jsx(Codicon, { name: tab.codicon, size: '0.8rem' }), tab.label],
          }, tab.id)),
          activeTab !== 'mindmap' && activeTab !== 'day' && activeTab !== 'queue'
            ? jsx(StarterWorkflowButton, { projectId: selectedBoardProjectId, boardName: selectedBoardName, onGenerated: () => setStarterRevision((value) => value + 1) }, 'starter-workflow')
            : null,
        ],
      }),
      jsx('div', {
        className: 'flex min-h-0 flex-1 flex-col overflow-y-auto',
        children: activeTab === 'day'
          ? jsx(DayPane, {}, 'day')
          : activeTab === 'queue'
          ? jsx(DecisionQueuePane, { projectId: selectedBoardProjectId }, 'queue')
          : activeTab === 'mindmap'
          ? jsx(MindMapPane, { key: `mindmap-${starterRevision}`, projectId: selectedBoardProjectId, boardSlug: boardForControls || undefined, selectedNodeId: selectedSpecNodeId, onSelectNode: setSelectedSpecNodeId })
          : activeTab === 'spec'
            ? jsx(SpecDigest, { key: `spec-${starterRevision}`, projectId: selectedBoardProjectId, boardSlug: boardForControls || undefined, selectedNodeId: selectedSpecNodeId, onSelectNode: setSelectedSpecNodeId })
            : activeTab === 'flowcharts'
                ? jsx(FlowchartsPane, { key: `flowcharts-${starterRevision}` })
                : activeTab === 'planning'
                  ? jsx(ScrumPlanningPane, { key: `planning-${starterRevision}` })
                  : activeTab === 'roadmap'
                    ? jsx(RoadmapPane, { key: `roadmap-${starterRevision}` })
                    : jsx('div', { className: 'flex h-full items-center justify-center p-6 text-(--ui-text-tertiary)', children: `${ENGINEERING_TABS.find((tab) => tab.id === activeTab)?.label || 'Section'} unavailable` }),
      }),
      jsx(SettingsFullscreen, {
        isOpen: settingsFullscreenOpen,
        onClose: () => setSettingsFullscreenOpen(false),
        layout: gridLayout, onGridChange: handleGridChange,
      }),
    ],
  })

  return jsx('div', {
    className: 'relative flex h-full min-w-0 p-3 text-sm',
    children: mainColumn,
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
  let active = true
  const seen = loadSeenDecisionIds()
  let primed = false // first tick marks existing pending decisions as seen without toasting

  const tick = async () => {
    if (!active) return
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
  const interval = setInterval(tick, POLL_MS)
  // Tests and short-lived host sessions must not stay alive solely for a
  // background toast poll; browsers do not expose unref, so guard it.
  if (typeof interval?.unref === 'function') interval.unref()
  return () => {
    active = false
    clearInterval(interval)
  }
}

// Criteria persist as strings, so duplicate entries have no durable identity.
// Occurrence suffix keeps keys unique; distinct entries keep identity across reorder/insert.
function stableSpecCriteriaKey(item, index, items, occurrences) {
  if (!occurrences) {
    occurrences = new Map()
    for (let i = 0; i < index; i += 1) occurrences.set(items[i], (occurrences.get(items[i]) || 0) + 1)
  }
  const occurrence = occurrences.get(item) || 0
  occurrences.set(item, occurrence + 1)
  return `spec-criterion:${JSON.stringify(item)}:${occurrence}`
}

const SPEC_ESTIMATE_POINTS = [1, 2, 3, 5, 8, 13]

// Selection is held by the parent when it passes selectedNodeId/onSelectNode, so the Map
// and Spec views share it; a view used on its own keeps its own.
function useNodeSelection(selectedNodeId, onSelectNode) {
  const [localId, setLocalId] = React.useState(null)
  const shared = onSelectNode !== undefined
  return [shared ? selectedNodeId ?? null : localId, shared ? onSelectNode : setLocalId]
}

// Loads the spec tree for a project. A refresh after an edit keeps the nodes on screen
// instead of clearing them, so the selection does not flicker.
function useSpecNodes(projectId, label, revision) {
  const [state, setState] = React.useState({ loading: false, nodes: [], error: null })
  const loadedProject = React.useRef(null)
  React.useEffect(() => {
    let active = true
    if (!projectId) {
      setState({ loading: false, nodes: [], error: 'No project selected' })
      return () => { active = false }
    }
    const refresh = loadedProject.current === projectId
    loadedProject.current = projectId
    setState((current) => (refresh ? { ...current, error: null } : { loading: true, nodes: [], error: null }))
    host.request('cli.exec', { argv: ['decision', 'spec', 'list', '--project-id', projectId] }).then((output) => {
      if (!active) return
      try {
        if (output?.code !== undefined && output.code !== 0) throw new Error(`${label} CLI exited ${output.code}`)
        const parsed = parseTrailingJson(output?.output || output?.stdout || '')
        if (parsed && parsed.ok === false) throw new Error(parsed.error?.message || parsed.error || `${label} unavailable`)
        const nodes = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.nodes) ? parsed.nodes : null
        if (!nodes) throw new Error(`${label} returned an invalid nodes payload`)
        setState({ loading: false, nodes, error: null })
      } catch (error) {
        setState({ loading: false, nodes: [], error: String(error.message || error) })
      }
    }).catch((error) => active && setState({ loading: false, nodes: [], error: String(error.message || error) }))
    return () => { active = false }
  }, [projectId, revision])
  return state
}

// What it takes to commit a feature or story to an hour: readiness, the estimate, and the
// Kanban card that builds it. Themes and epics are not units of work, so they get nothing.
function SpecNodeActions({ node, projectId, boardSlug, onChanged }) {
  const [readiness, setReadiness] = React.useState(null)
  const [task, setTask] = React.useState(null)
  const [linkDraft, setLinkDraft] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const applies = node.kind === 'feature' || node.kind === 'story'

  React.useEffect(() => {
    let live = true
    setReadiness(null)
    if (!applies) return () => { live = false }
    cliExec(['decision', 'spec', 'check-ready', '--project-id', projectId, '--id', node.id])
      .then((result) => { if (live) setReadiness(result.readiness) })
      .catch((failure) => { if (live) setError(String(failure.message || failure)) })
    return () => { live = false }
  }, [projectId, node.id, node.status, node.estimate, node.criteria_json, applies])

  React.useEffect(() => {
    let live = true
    setTask(null)
    if (!applies || !boardSlug || !node.kanban_task_id) return () => { live = false }
    cliExec(['kanban', '--board', boardSlug, 'show', node.kanban_task_id, '--json'])
      .then((result) => { if (live) setTask(result?.task || result) })
      .catch(() => {})
    return () => { live = false }
  }, [boardSlug, node.kanban_task_id, applies])

  if (!applies) return null

  const run = async (argv) => {
    if (busy) return
    setBusy(true)
    try {
      await cliExec(argv)
      setError(null)
      onChanged()
    } catch (failure) {
      setError(String(failure.message || failure))
    } finally {
      setBusy(false)
    }
  }
  const nodeArgs = ['--project-id', projectId, '--id', node.id]
  const link = async () => {
    const taskId = linkDraft.trim()
    if (!taskId || busy) return
    setBusy(true)
    try {
      if (boardSlug) {
        try {
          await cliExec(['kanban', '--board', boardSlug, 'show', taskId, '--json'])
        } catch {
          throw new Error(`Kanban card ${taskId} was not found on board ${boardSlug}`)
        }
      }
      await cliExec(['decision', 'spec', 'link-kanban', ...nodeArgs, '--task-id', taskId])
      setLinkDraft('')
      setError(null)
      onChanged()
    } catch (failure) {
      setError(String(failure.message || failure))
    } finally {
      setBusy(false)
    }
  }
  const failing = readiness ? readiness.checks.filter((check) => !check.passed) : []
  const control = 'rounded border border-(--ui-stroke-secondary) px-2 py-1 disabled:opacity-50'
  return jsxs('section', { 'aria-label': 'Readiness and delivery', className: 'flex flex-col gap-2 border-t border-(--ui-stroke-secondary) pt-3', children: [
    readiness
      ? readiness.ready
        ? jsx('div', { 'data-testid': 'readiness', children: 'Ready to commit' })
        : jsxs('div', { 'data-testid': 'readiness', children: [
          jsx('div', { children: 'Not ready:' }),
          jsx('ul', { className: 'list-disc pl-5', children: failing.map((check) => jsx('li', { children: check.detail }, check.name)) }),
        ] })
      : jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'Checking readiness…' }),
    jsxs('label', { className: 'flex items-center gap-2', children: [
      'Estimate',
      jsx('select', {
        value: node.estimate == null ? '' : String(node.estimate), disabled: busy, 'aria-label': 'Estimate',
        onChange: (event) => run(event.target.value === ''
          ? ['decision', 'spec', 'update-node', ...nodeArgs, '--clear-estimate']
          : ['decision', 'spec', 'update-node', ...nodeArgs, '--estimate', event.target.value]),
        children: [
          jsx('option', { value: '', children: 'Not estimated' }, 'none'),
          ...SPEC_ESTIMATE_POINTS.map((points) => jsx('option', { value: String(points), children: `${points} points` }, points)),
        ],
      }),
    ] }),
    node.status === 'ready'
      ? jsx('button', { type: 'button', className: `${control} self-start`, disabled: busy, onClick: () => run(['decision', 'spec', 'update-node', ...nodeArgs, '--status', 'draft']), children: 'Back to draft' })
      : jsx('button', { type: 'button', className: `${control} self-start`, disabled: busy || !readiness?.ready, onClick: () => run(['decision', 'spec', 'update-node', ...nodeArgs, '--status', 'ready']), children: 'Mark ready' }),
    node.kanban_task_id
      ? jsxs('div', { className: 'flex flex-wrap items-center gap-2', children: [
        jsx('span', { 'data-testid': 'linked-card', children: `Kanban card ${node.kanban_task_id}${task ? ` · ${task.status || 'unknown'} · ${task.title || ''}` : ''}` }),
        jsx('button', { type: 'button', className: control, disabled: busy, onClick: () => run(['decision', 'spec', 'link-kanban', ...nodeArgs, '--task-id', '']), children: 'Unlink' }),
      ] })
      : jsxs('div', { className: 'flex items-center gap-2', children: [
        jsx('input', {
          type: 'text', value: linkDraft, placeholder: 'Kanban card id', 'aria-label': 'Kanban card id',
          onChange: (event) => setLinkDraft(event.target.value),
          className: 'w-40 rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1',
        }),
        jsx('button', { type: 'button', className: control, disabled: busy || !linkDraft.trim(), onClick: link, children: 'Link' }),
      ] }),
    error ? jsx('p', { role: 'alert', children: error }) : null,
  ] })
}

function MindMapStructureActions({ node, projectId, boardSlug, onChanged }) {
  // Add/delete/rename/reorder for the selected node — wired straight to the
  // CLI verbs the backend-plugin exposes (decision spec add-node/
  // update-node/delete-node/move-node). Siblings are ordered by sort_index
  // (schema v17); move-node swaps the node with its nearest sibling under
  // the same parent, so these buttons never reparent anything.
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const run = async (argv) => {
    if (busy) return
    setBusy(true)
    try {
      await cliExec(argv)
      setError(null)
      onChanged()
    } catch (failure) {
      setError(String(failure.message || failure))
    } finally {
      setBusy(false)
    }
  }
  const control = 'rounded border border-(--ui-stroke-secondary) px-2 py-1 text-[0.7rem] disabled:opacity-50 hover:bg-(--chrome-action-hover)'
  const childKindOf = { theme: 'epic', epic: 'feature', feature: 'story' }
  const childKind = childKindOf[node.kind]

  const addChild = () => {
    if (!childKind || busy) return
    const title = window.prompt(`Title for the new ${childKind} under "${node.title}"`)
    if (!title || !title.trim()) return
    run(['decision', 'spec', 'add-node', '--project-id', projectId, '--kind', childKind, '--title', title.trim(), '--parent-id', node.id])
  }
  const rename = () => {
    if (busy) return
    const title = window.prompt('New title', node.title)
    if (!title || !title.trim() || title.trim() === node.title) return
    run(['decision', 'spec', 'update-node', '--project-id', projectId, '--id', node.id, '--title', title.trim()])
  }
  const remove = () => {
    if (busy) return
    if (!window.confirm(`Delete "${node.title}"? This only works if it has no children.`)) return
    run(['decision', 'spec', 'delete-node', '--project-id', projectId, '--id', node.id])
  }
  const move = (direction) => {
    if (busy) return
    run(['decision', 'spec', 'move-node', '--project-id', projectId, '--id', node.id, '--direction', direction])
  }
  const reparent = () => {
    if (busy) return
    const value = window.prompt('New parent node id (blank = make it a root theme)', node.parent_id || '')
    if (value === null) return
    run(['decision', 'spec', 'reparent-node', '--project-id', projectId, '--id', node.id, '--parent-id', value.trim()])
  }

  return jsxs('section', { 'aria-label': 'MindMap structure', className: 'flex flex-col gap-2 border-t border-(--ui-stroke-secondary) pt-3', children: [
    jsx('div', { className: 'font-mono text-[0.6rem] uppercase text-(--ui-text-tertiary)', children: 'Structure' }),
    jsxs('div', { className: 'flex flex-wrap gap-2', children: [
      childKind ? jsx('button', { type: 'button', className: control, disabled: busy, onClick: addChild, children: `+ ${childKind}` }) : null,
      jsx('button', { type: 'button', className: control, disabled: busy, onClick: rename, children: 'Rename' }),
      jsx('button', { type: 'button', className: control, disabled: busy, onClick: () => move('up'), 'aria-label': 'Move up', children: '↑ Move up' }),
      jsx('button', { type: 'button', className: control, disabled: busy, onClick: () => move('down'), 'aria-label': 'Move down', children: '↓ Move down' }),
      jsx('button', { type: 'button', className: control, disabled: busy, onClick: reparent, children: 'Move to...' }),
      jsx('button', { type: 'button', className: control, disabled: busy, onClick: remove, children: 'Delete' }),
    ] }),
    error ? jsx('p', { role: 'alert', className: 'text-(--ui-danger,#e5484d)', children: error }) : null,
  ] })
}

function MindMapPane({ projectId, boardSlug, selectedNodeId, onSelectNode }) {
  const [mindQuery, setMindQuery] = React.useState('')
  const [revision, setRevision] = React.useState(0)
  const [selectedId, selectNode] = useNodeSelection(selectedNodeId, onSelectNode)
  const state = useSpecNodes(projectId, 'MindMap', revision)
  const selectedMindNode = state.nodes.find((node) => node.id === selectedId) || null

  const results = React.useMemo(() => {
    const query = mindQuery.trim().toLowerCase()
    if (!query) return state.nodes
    return state.nodes.filter((node) => `${node.kind} ${node.title} ${node.note || ''}`.toLowerCase().includes(query))
  }, [mindQuery, state.nodes])
  const criteria = parseSpecCriteria(selectedMindNode?.criteria_json)
  const criteriaOccurrences = new Map()

  return jsxs('div', {
    className: 'grid min-h-0 flex-1 gap-5 overflow-auto p-4 text-sm',
    style: { gridTemplateColumns: '280px 1fr' },
    children: [
      jsxs('div', { className: 'flex min-w-0 flex-col gap-3', children: [
        jsx('input', {
          type: 'text', value: mindQuery, onChange: (event) => setMindQuery(event.target.value), placeholder: 'Search stories...',
          className: 'w-full rounded border border-(--ui-stroke-secondary) px-2.5 py-2 text-xs', style: { background: '#1e1e1e' },
        }),
        state.loading ? jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'Loading MindMap…' }) : null,
        state.error ? jsx('div', { role: 'alert', className: 'text-(--ui-danger,#e5484d)', children: `MindMap unavailable: ${state.error}` }) : null,
        !state.loading && !state.error && results.length === 0 ? jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'No matching stories.' }) : null,
        jsx('div', { className: 'flex flex-col gap-1.5 overflow-auto', children: results.map((node) => jsx('button', {
          type: 'button', onClick: () => selectNode(node.id), className: 'rounded border border-(--ui-stroke-secondary) p-2 text-left hover:bg-(--chrome-action-hover)',
          children: [
            jsx('div', { className: 'font-mono text-[0.6rem] uppercase text-(--ui-text-tertiary)', children: node.kind }),
            jsx('div', { className: 'text-xs text-(--ui-text-primary)', children: node.title }),
          ],
        }, node.id)) }),
      ] }),
      jsx('div', { className: 'min-w-0 rounded border border-(--ui-stroke-secondary) p-4', style: { background: '#1a1a1a' }, children: selectedMindNode
        ? jsxs('div', { className: 'flex flex-col gap-3', children: [
            jsx('div', { className: 'font-mono text-[0.6rem] uppercase text-(--ui-text-tertiary)', children: selectedMindNode.kind }),
            jsx('h2', { className: 'text-base font-semibold', children: selectedMindNode.title }),
            selectedMindNode.note ? jsx('p', { className: 'text-(--ui-text-secondary)', children: selectedMindNode.note }) : null,
            criteria.error
              ? jsx('div', { role: 'alert', className: 'text-(--ui-danger,#e5484d)', children: 'Malformed acceptance criteria' })
              : criteria.items.length > 0
                ? jsxs('div', { children: [jsx('div', { className: 'mb-2 font-mono text-[0.6rem] uppercase text-(--ui-text-tertiary)', children: 'Acceptance criteria' }), jsx('ul', { className: 'list-disc pl-5', children: criteria.items.map((item, index) => jsx('li', { children: item }, stableSpecCriteriaKey(item, index, criteria.items, criteriaOccurrences))) })] })
                : jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'No acceptance criteria recorded.' }),
            jsx(SpecNodeActions, { node: selectedMindNode, projectId, boardSlug, onChanged: () => setRevision((value) => value + 1) }, selectedMindNode.id),
            jsx(MindMapStructureActions, { node: selectedMindNode, projectId, boardSlug, onChanged: () => setRevision((value) => value + 1) }, `structure-${selectedMindNode.id}`),
          ] })
        : state.nodes.length === 0 && !state.loading && !state.error
          ? jsx('div', { className: 'flex h-full min-h-48 flex-col items-center justify-center gap-2 text-(--ui-text-tertiary)', children: [
              jsx('div', { children: 'This project has no MindMap yet.' }),
              jsx('button', {
                type: 'button',
                className: 'rounded border border-(--ui-stroke-secondary) px-2.5 py-1.5 text-xs hover:bg-(--chrome-action-hover)',
                onClick: async () => {
                  const title = window.prompt('Title for the root theme')
                  if (!title || !title.trim()) return
                  try {
                    await cliExec(['decision', 'spec', 'add-node', '--project-id', projectId, '--kind', 'theme', '--title', title.trim()])
                    setRevision((value) => value + 1)
                  } catch (failure) {
                    host.notify({ kind: 'error', message: String(failure.message || failure) })
                  }
                },
                children: '+ Add root theme',
              }),
            ] })
          : jsx('div', { className: 'flex h-full min-h-48 items-center justify-center text-(--ui-text-tertiary)', children: 'Select a story to inspect it.' }) }),
    ],
  })
}

function SpecDigest({ projectId, boardSlug, selectedNodeId, onSelectNode }) {
  const [revision, setRevision] = React.useState(0)
  const [selectedId, selectNode] = useNodeSelection(selectedNodeId, onSelectNode)
  const state = useSpecNodes(projectId, 'Spec Digest', revision)
  const selectedNode = state.nodes.find((node) => node.id === selectedId) || null
  const criteria = parseSpecCriteria(selectedNode?.criteria_json)
  const criteriaOccurrences = new Map()
  return jsxs('div', { className: 'flex flex-col gap-3 p-4', children: [
    jsx('h2', { children: 'Spec Digest' }, 'title'),
    state.loading ? jsx('p', { children: 'Loading Spec Digest…' }, 'loading') : null,
    state.error ? jsx('p', { role: 'alert', children: `Spec Digest unavailable: ${state.error}` }, 'error') : null,
    !state.loading && !state.error && state.nodes.length === 0 ? jsx('p', { children: 'No specification nodes yet.' }, 'empty') : null,
    jsx('div', { className: 'flex flex-col gap-1', children: state.nodes.map((node) => jsx('button', {
      type: 'button', onClick: () => selectNode(node.id), className: 'text-left',
      children: `${node.kind}: ${node.title}`,
    }, node.id)) }, 'nodes'),
    selectedNode && jsx('section', { children: [
      jsx('h3', { children: selectedNode.title }, 'selected-title'),
      criteria.error
        ? jsx('p', { role: 'alert', children: 'malformed criteria' }, 'criteria-error')
        : jsx('ul', { children: criteria.items.map((item, index) => jsx('li', { children: item }, stableSpecCriteriaKey(item, index, criteria.items, criteriaOccurrences))) }, 'criteria-items'),
      jsx(SpecNodeActions, { node: selectedNode, projectId, boardSlug, onChanged: () => setRevision((value) => value + 1) }, 'actions'),
    ] }, 'selected-node'),
  ] })
}

function SpecDigestRoute({ projectId: overrideProjectId } = {}) {
  const { boards } = useKanbanBoards()
  const selectedBoard = loadSelectedBoardSlug() || pickDefaultBoardSlug(boards)
  const projectId = boards.find((board) => board && board.slug === selectedBoard)?.project_id || null
  return jsx(SpecDigest, { projectId: overrideProjectId || projectId, boardSlug: selectedBoard || undefined })
}

export default {
  id: PLUGIN_ID,
  name: 'Software Engineering Workflow',
  register(ctx) {
    // Full-page surfaces, matching the Kanban board: route navigation owns
    // the main workspace, so switching chats cannot evict or resize them.
    ctx.registerMany([
      {
        id: 'decision-hud-page',
        area: ROUTES_AREA,
        data: { path: '/decision-hud' },
        render: () => jsx(DecisionHudPane, { rest: ctx.rest }),
      },
      {
        id: 'decision-hud-nav',
        area: SIDEBAR_NAV_AREA,
        order: 40,
        data: { codicon: 'checklist', label: 'Software Engineering', path: '/decision-hud' },
      },
      {
        id: 'decision-hud-day-route',
        area: ROUTES_AREA,
        data: { path: '/decision-hud/day' },
        render: () => jsxs(React.Fragment, { children: [jsx(CadenceWatchers, {}, 'watchers'), jsx(DayPane, {}, 'day')] }),
      },
      {
        id: 'spec-digest-route',
        area: ROUTES_AREA,
        data: { path: '/spec-digest' },
        render: (props = {}) => jsx(SpecDigestRoute, props),
      },
      {
        id: 'decision-hud-map-route',
        area: ROUTES_AREA,
        data: { path: '/decision-hud/map' },
        render: () => jsx(HierarchyMapPane, {}),
      },
      {
        id: 'decision-hud-flowcharts-route',
        area: ROUTES_AREA,
        data: { path: '/decision-hud/flowcharts' },
        render: () => jsx(FlowchartsPane, {}),
      },
      {
        id: 'roadmap-route',
        area: ROUTES_AREA,
        data: { path: '/decision-hud/roadmap' },
        render: () => jsx(RoadmapPane, {}),
      },
      {
        id: 'scrum-planning-route',
        area: ROUTES_AREA,
        data: { path: '/decision-hud/planning' },
        render: () => jsx(ScrumPlanningPane, {}),
      },
      {
        id: 'decision-hud-open',
        area: PALETTE_AREA,
        data: {
          id: 'decision-hud.open',
          label: 'Decision HUD: Open page',
          keywords: ['decision', 'hud', 'queue', 'page'],
          run: () => host.navigate('/decision-hud'),
        },
      },
    ])
  },
}
