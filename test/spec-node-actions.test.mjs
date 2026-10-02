import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { JSDOM } from 'jsdom'

import { host } from '@hermes/plugin-sdk'

// See day-pane.test.mjs: react-dom must load after a window exists, or controlled inputs
// never fire onChange under jsdom.
const bootstrap = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = bootstrap.window
globalThis.document = bootstrap.window.document
const { click, flush, installLocalStorageStub, mount: mountPane } = await import('./dom-harness.mjs')

// A failing assertion skips the test's own unmount, and a mounted pane's timers would then
// keep the process alive, hanging the run instead of failing it. Unmount whatever is left.
const mounted = new Set()
function mount(renderFn) {
  const pane = mountPane(renderFn)
  mounted.add(pane)
  const unmount = pane.unmount
  pane.unmount = async () => { if (mounted.delete(pane)) await unmount() }
  return pane
}
afterEach(async () => { for (const pane of [...mounted]) await pane.unmount() })
const { default: plugin } = await import('../plugin.js')

installLocalStorageStub()

const routes = []
plugin.register({ registerMany(items) { routes.push(...items) }, register() {}, rest() {} })
const specRoute = routes.find((item) => item.data?.path === '/spec-digest')
const pageRoute = routes.find((item) => item.data?.path === '/decision-hud')

const CRITERIA = JSON.stringify(['Login succeeds', 'Wrong password is rejected'])
const reply = (value, code = 0) => ({ code, output: JSON.stringify(value) })
const fail = (code, message) => reply({ ok: false, error: { code: 'x', message } }, code)

/** A stand-in for the CLI that keeps state, so edits show up on the next refetch. */
function fakeCli(initialNodes) {
  const nodes = initialNodes.map((node) => ({ ...node }))
  const calls = []
  const flag = (argv, name) => argv[argv.indexOf(name) + 1]
  const readiness = (node) => {
    if (node.kind !== 'feature' && node.kind !== 'story') return { applies: false, ready: true, checks: [] }
    const checks = [
      { name: 'criteria', passed: node.criteria_json !== '[]', detail: node.criteria_json !== '[]' ? '2 acceptance criteria' : 'needs at least one acceptance criterion' },
      { name: 'estimate', passed: node.estimate != null, detail: node.estimate != null ? `${node.estimate} points` : 'needs an estimate' },
    ]
    if (node.estimate != null) {
      const fits = node.estimate <= 5
      checks.push({ name: 'size', passed: fits, detail: fits ? 'fits one hour (at most 5 points)' : `${node.estimate} points is too big for one hour; split it to 5 or fewer` })
    }
    return { applies: true, ready: checks.every((c) => c.passed), checks }
  }
  const handler = (argv) => {
    calls.push(argv)
    const joined = argv.join(' ')
    if (joined === 'kanban boards list --json') return reply([{ slug: 'main-board', project_id: 'project-1' }])
    if (argv[0] === 'kanban' && argv[3] === 'show') {
      return argv[4] === 'missing' ? fail(1, 'no such task') : reply({ task: { id: argv[4], title: 'Build login', status: 'running' } })
    }
    if (argv[1] === 'spec' && argv[2] === 'list') return reply({ ok: true, nodes: nodes.map((n) => ({ ...n })) })
    const node = nodes.find((n) => n.id === flag(argv, '--id'))
    if (argv[2] === 'check-ready') return reply({ ok: true, readiness: readiness(node) })
    if (argv[2] === 'update-node') {
      if (argv.includes('--estimate')) node.estimate = Number(flag(argv, '--estimate'))
      if (argv.includes('--clear-estimate')) node.estimate = null
      if (argv.includes('--status')) {
        const status = flag(argv, '--status')
        if (status === 'ready' && !readiness(node).ready) return fail(6, 'not ready: criteria: ...')
        node.status = status
      }
      return reply({ ok: true, node })
    }
    if (argv[2] === 'link-kanban') {
      node.kanban_task_id = flag(argv, '--task-id') || null
      return reply({ ok: true, node })
    }
    throw new Error(`unexpected argv ${joined}`)
  }
  return { nodes, calls, handler }
}

const THEME = { id: 'sn_theme', project_id: 'project-1', kind: 'theme', title: 'Product', status: 'draft', criteria_json: null, kanban_task_id: null, estimate: null }
const feature = (overrides = {}) => ({
  id: 'sn_login', project_id: 'project-1', kind: 'feature', title: 'Login', status: 'draft',
  criteria_json: CRITERIA, kanban_task_id: null, estimate: null, ...overrides,
})

async function withCli(initialNodes, body) {
  const original = host.request
  const cli = fakeCli(initialNodes)
  host.request = async (method, params) => cli.handler(params.argv)
  try {
    await body(cli)
  } finally {
    host.request = original
  }
}

const text = (mounted) => mounted.container.textContent
const buttonNamed = (mounted, label) => [...mounted.container.querySelectorAll('button')].find((b) => b.textContent === label)
const hasCall = (calls, ...argv) => calls.some((call) => call.join(' ') === argv.join(' '))
const section = (mounted) => mounted.container.querySelector('[aria-label="Readiness and delivery"]')

function chooseOption(mounted, select, value) {
  select.value = value
  select.dispatchEvent(new mounted.dom.window.Event('change', { bubbles: true }))
}

function typeInto(mounted, input, value) {
  const setter = Object.getOwnPropertyDescriptor(mounted.dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new mounted.dom.window.Event('input', { bubbles: true }))
}

async function openFeature(mounted, title = 'feature: Login') {
  await flush()
  click(buttonNamed(mounted, title), mounted.dom)
  await flush()
}

test('a draft feature that is missing things says exactly what, and cannot be marked ready', async () => {
  await withCli([THEME, feature({ criteria_json: '[]' })], async () => {
    const mounted = mount(() => specRoute.render())
    await openFeature(mounted)

    const readiness = mounted.container.querySelector('[data-testid="readiness"]')
    assert.match(readiness.textContent, /Not ready:/)
    assert.match(readiness.textContent, /needs at least one acceptance criterion/)
    assert.match(readiness.textContent, /needs an estimate/)
    assert.equal(buttonNamed(mounted, 'Mark ready').disabled, true)
    await mounted.unmount()
  })
})

test('estimating a feature makes it ready, and marking it ready goes through the CLI', async () => {
  await withCli([THEME, feature()], async (cli) => {
    const mounted = mount(() => specRoute.render())
    await openFeature(mounted)
    assert.match(mounted.container.querySelector('[data-testid="readiness"]').textContent, /needs an estimate/)

    chooseOption(mounted, section(mounted).querySelector('select'), '3')
    await flush()
    assert.ok(hasCall(cli.calls, 'decision', 'spec', 'update-node', '--project-id', 'project-1', '--id', 'sn_login', '--estimate', '3'))
    assert.equal(mounted.container.querySelector('[data-testid="readiness"]').textContent, 'Ready to commit')
    assert.equal(section(mounted).querySelector('select').value, '3')

    click(buttonNamed(mounted, 'Mark ready'), mounted.dom)
    await flush()
    assert.ok(hasCall(cli.calls, 'decision', 'spec', 'update-node', '--project-id', 'project-1', '--id', 'sn_login', '--status', 'ready'))
    assert.ok(buttonNamed(mounted, 'Back to draft'))
    assert.equal(buttonNamed(mounted, 'Mark ready'), undefined)

    click(buttonNamed(mounted, 'Back to draft'), mounted.dom)
    await flush()
    assert.ok(buttonNamed(mounted, 'Mark ready'))
    await mounted.unmount()
  })
})

test('a feature that is too big says to split it, and an estimate can be cleared', async () => {
  await withCli([THEME, feature({ estimate: 8 })], async (cli) => {
    const mounted = mount(() => specRoute.render())
    await openFeature(mounted)
    assert.match(mounted.container.querySelector('[data-testid="readiness"]').textContent, /8 points is too big for one hour; split it/)
    assert.equal(buttonNamed(mounted, 'Mark ready').disabled, true)

    chooseOption(mounted, section(mounted).querySelector('select'), '')
    await flush()
    assert.ok(hasCall(cli.calls, 'decision', 'spec', 'update-node', '--project-id', 'project-1', '--id', 'sn_login', '--clear-estimate'))
    assert.match(mounted.container.querySelector('[data-testid="readiness"]').textContent, /needs an estimate/)
    await mounted.unmount()
  })
})

test('a refusal from the CLI is shown, not swallowed', async () => {
  await withCli([THEME, feature({ estimate: 3 })], async (cli) => {
    const mounted = mount(() => specRoute.render())
    await openFeature(mounted)
    cli.nodes[1].criteria_json = '[]'  // changed behind the pane's back, so the button is still enabled
    click(buttonNamed(mounted, 'Mark ready'), mounted.dom)
    await flush()
    assert.match(section(mounted).querySelector('[role="alert"]').textContent, /not ready: criteria/)
    await mounted.unmount()
  })
})

test('a card is verified on the board, then linked, shown with its status, and unlinked', async () => {
  await withCli([THEME, feature()], async (cli) => {
    const mounted = mount(() => specRoute.render())
    await openFeature(mounted)

    typeInto(mounted, section(mounted).querySelector('input'), 't_42')
    await flush()
    click(buttonNamed(mounted, 'Link'), mounted.dom)
    await flush()

    assert.ok(hasCall(cli.calls, 'kanban', '--board', 'main-board', 'show', 't_42', '--json'))
    assert.ok(hasCall(cli.calls, 'decision', 'spec', 'link-kanban', '--project-id', 'project-1', '--id', 'sn_login', '--task-id', 't_42'))
    assert.equal(mounted.container.querySelector('[data-testid="linked-card"]').textContent, 'Kanban card t_42 · running · Build login')

    click(buttonNamed(mounted, 'Unlink'), mounted.dom)
    await flush()
    assert.ok(hasCall(cli.calls, 'decision', 'spec', 'link-kanban', '--project-id', 'project-1', '--id', 'sn_login', '--task-id', ''))
    assert.equal(mounted.container.querySelector('[data-testid="linked-card"]'), null)
    await mounted.unmount()
  })
})

test('a card that is not on the board is refused before anything is linked', async () => {
  await withCli([THEME, feature()], async (cli) => {
    const mounted = mount(() => specRoute.render())
    await openFeature(mounted)
    typeInto(mounted, section(mounted).querySelector('input'), 'missing')
    await flush()
    click(buttonNamed(mounted, 'Link'), mounted.dom)
    await flush()

    assert.match(section(mounted).querySelector('[role="alert"]').textContent, /Kanban card missing was not found on board main-board/)
    assert.ok(!cli.calls.some((call) => call[2] === 'link-kanban'))
    await mounted.unmount()
  })
})

test('themes and epics get no readiness or delivery controls', async () => {
  await withCli([THEME, feature()], async () => {
    const mounted = mount(() => specRoute.render())
    await openFeature(mounted, 'theme: Product')
    assert.match(text(mounted), /Product/)
    assert.equal(section(mounted), null)
    await mounted.unmount()
  })
})

test('selecting a node in one view selects it in the other', async () => {
  await withCli([THEME, feature({ estimate: 3 })], async () => {
    const mounted = mount(() => pageRoute.render())
    await flush()
    const tab = (label) => [...mounted.container.querySelectorAll('[role="tab"], button')].find((b) => b.textContent.trim() === label)

    click(tab('MindMap'), mounted.dom)
    await flush()
    const node = [...mounted.container.querySelectorAll('button')].find((b) => b.textContent.includes('Login'))
    click(node, mounted.dom)
    await flush()
    assert.match(text(mounted), /Acceptance criteria/)  // the Map view's detail panel is showing Login

    click(tab('Spec Digest'), mounted.dom)
    await flush()
    assert.equal(mounted.container.querySelector('h3')?.textContent, 'Login')  // the Spec view opened on the same node
    assert.ok(section(mounted), 'and shows its readiness and delivery controls')

    click(tab('MindMap'), mounted.dom)
    await flush()
    assert.match(text(mounted), /Login/)
    await mounted.unmount()
  })
})
