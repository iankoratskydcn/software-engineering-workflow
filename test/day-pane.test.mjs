import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'

import { JSDOM } from 'jsdom'

import { host } from '@hermes/plugin-sdk'

// react-dom decides once, when it is first imported, whether the browser supports
// `input` events. The shared harness imports it before any window exists, so
// controlled inputs would never fire onChange. Create a window first, then load the
// harness (and with it react-dom).
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
const dayRoute = routes.find((item) => item.data?.path === '/decision-hud/day')

const hourOf = (block, hour, kind, minutesFromStart) => ({
  id: `h${block}${hour}`, block, hour, kind,
  start_ts: 1000 + minutesFromStart * 60, end_ts: 1000 + (minutesFromStart + 60) * 60,
  start: new Date(Date.UTC(2026, 9, 2, 16, minutesFromStart)).toISOString(),
  end: new Date(Date.UTC(2026, 9, 2, 16, minutesFromStart + 60)).toISOString(),
})
const HOURS = [hourOf(1, 1, 'retro', 0), hourOf(1, 2, 'work', 60), hourOf(1, 3, 'work', 120)]
const DAY = { id: 'day_1', date: '2026-10-02', status: 'active', hours_available: 3, layout: '1+2', blocks: 1, hours: HOURS }

const phase = (ceremony, secondsRemaining, hat = 'spec', action = 'Refine the next feature to Ready.') => ({
  ceremony, suggested_hat: hat, next_best_action: action, minute: 10, seconds_remaining: secondsRemaining,
})

const activeStatus = (overrides = {}) => ({
  ok: true, active: true, state: 'in_progress', day: DAY, current: { ...HOURS[1], phase: phase('refinement', 1500) },
  next: HOURS[2], hours_remaining: 2, current_hat: 'review', starts_in_seconds: null, ...overrides,
})

const reply = (value, code = 0) => ({ code, output: JSON.stringify(value) })

const OFFLINE = { ok: true, presence: { online: false, since: null, last_seen: null } }
const NOTHING_DUE = { ok: true, reported: false, skipped: 'offline' }

/** Run `body` with host.request stubbed. `handler(argv)` answers the `day` verbs; the
 *  `presence` and `observer` verbs are answered by `extras` (a reply, or a function of
 *  argv returning one) and default to "offline, no standup yet, nothing due". */
async function withHost(handler, body, extras = {}) {
  const original = { request: host.request, notify: host.notify }
  const calls = []
  const notifications = []
  const answer = (spec, argv, fallback) => (typeof spec === 'function' ? spec(argv) : spec ?? fallback)
  host.notify = (message) => notifications.push(message)
  host.request = async (method, params) => {
    assert.equal(method, 'cli.exec')
    const argv = params.argv
    calls.push(argv)
    if (argv[1] === 'presence') return answer(extras.presence, argv, reply(OFFLINE))
    if (argv[1] === 'observer' && argv[2] === 'standup') return answer(extras.standup, argv, reply(NOTHING_DUE))
    if (argv[1] === 'observer') return answer(extras.latest, argv, reply({ ok: true, standup: null }))
    return handler(argv, calls)
  }
  try {
    await body(calls, notifications)
  } finally {
    host.request = original.request
    host.notify = original.notify
  }
}

const text = (mounted) => mounted.container.textContent
const buttons = (mounted) => [...mounted.container.querySelectorAll('button')]
const buttonNamed = (mounted, label) => buttons(mounted).find((b) => b.textContent === label)
const hasCall = (calls, ...argv) => calls.some((call) => call.join(' ') === argv.join(' '))

function setInputValue(mounted, input, value) {
  const setter = Object.getOwnPropertyDescriptor(mounted.dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new mounted.dom.window.Event('input', { bubbles: true }))
}

const LAYOUTS = { 3: '1+2', 5: '1+4', 12: '1+5, 1+5' }
const planReply = (argv) => {
  const hours = Number(argv[argv.indexOf('--hours') + 1])
  if (!LAYOUTS[hours]) {
    return reply({ ok: false, error: { code: 'invalid_input', message: 'hours must be between 3 and 24' } }, 2)
  }
  return reply({ ok: true, plan: { hours_available: hours, layout: LAYOUTS[hours], blocks: 1, hours: [] } })
}

test('the Day pane is a route and the first workflow tab, not another sidebar entry', () => {
  assert.ok(dayRoute, '/decision-hud/day route must be registered')
  assert.ok(!routes.some((item) => /day/.test(item.id) && item.area === 'sidebar.nav'))
})

// flush() is a fixed number of event-loop turns, which is too few when the machine is busy.
async function until(mounted, pattern) {
  for (let i = 0; i < 100 && !pattern.test(text(mounted)); i++) await flush()
}

test('with no active day it previews the layout for the hours entered and starts the day', async () => {
  let started = false
  await withHost((argv) => {
    if (argv[2] === 'status') return reply(started ? activeStatus() : { ok: true, active: false })
    if (argv[2] === 'plan') return planReply(argv)
    if (argv[2] === 'start') { started = true; return reply({ ok: true, day: DAY }) }
    throw new Error(`unexpected argv ${argv.join(' ')}`)
  }, async (calls) => {
    const mounted = mount(() => dayRoute.render())
    await until(mounted, /Layout: 1\+4/)
    assert.deepEqual(mounted.errors, [])
    assert.match(text(mounted), /Layout: 1\+4/)  // the default of 5 hours
    assert.ok(hasCall(calls, 'decision', 'day', 'plan', '--hours', '5'))

    setInputValue(mounted, mounted.container.querySelector('input'), '12')
    await until(mounted, /Layout: 1\+5, 1\+5/)
    assert.match(text(mounted), /Layout: 1\+5, 1\+5/)

    setInputValue(mounted, mounted.container.querySelector('input'), '3')
    await flush()
    click(buttonNamed(mounted, 'Start day'), mounted.dom)
    await flush()
    assert.ok(hasCall(calls, 'decision', 'day', 'start', '--hours', '3'))
    assert.match(text(mounted), /Refinement/)  // the status was refetched after starting
    await mounted.unmount()
  })
})

test('unusable hours show the error and keep Start disabled', async () => {
  await withHost((argv) => argv[2] === 'status' ? reply({ ok: true, active: false }) : planReply(argv), async () => {
    const mounted = mount(() => dayRoute.render())
    await flush()
    setInputValue(mounted, mounted.container.querySelector('input'), '2')
    await flush()

    assert.match(mounted.container.querySelector('[role="alert"]').textContent, /hours must be between 3 and 24/)
    assert.equal(buttonNamed(mounted, 'Start day').disabled, true)
    await mounted.unmount()
  })
})

test('an active day shows the ceremony, countdown, next action, hats and timeline', async () => {
  await withHost(() => reply(activeStatus()), async () => {
    const mounted = mount(() => dayRoute.render())
    await flush()

    assert.deepEqual(mounted.errors, [])
    const shown = text(mounted)
    assert.match(shown, /Day · 2026-10-02 · 1\+2/)
    assert.match(shown, /Refinement/)
    assert.match(shown, /Block 1 of 1 · Work hour 1/)
    assert.match(shown, /25:00 left in this phase/)
    assert.match(shown, /Refine the next feature to Ready\./)
    assert.match(shown, /Block 1 \(2 work\)/)
    assert.match(shown, /R \d.*W1 \d.*W2 \d/s)

    assert.equal(buttonNamed(mounted, 'Review').getAttribute('aria-pressed'), 'true')
    assert.equal(buttonNamed(mounted, 'Spec (suggested)').getAttribute('aria-pressed'), 'false')
    assert.ok(buttonNamed(mounted, 'Decide') && buttonNamed(mounted, 'Retro') && buttonNamed(mounted, 'End day'))
    await mounted.unmount()
  })
})

test('the retro hour is labelled as such', async () => {
  const retro = { ...HOURS[0], phase: phase('retro_review', 600, 'retro', 'Read the log for the block just finished.') }
  await withHost(() => reply(activeStatus({ current: retro })), async () => {
    const mounted = mount(() => dayRoute.render())
    await flush()
    assert.match(text(mounted), /Retro: review the log/)
    assert.match(text(mounted), /Block 1 of 1 · Retro hour/)
    await mounted.unmount()
  })
})

test('choosing a hat and ending the day go through the CLI and refetch', async () => {
  await withHost(() => reply(activeStatus()), async (calls) => {
    const mounted = mount(() => dayRoute.render())
    await flush()
    const before = calls.length

    click(buttonNamed(mounted, 'Spec (suggested)'), mounted.dom)
    await flush()
    assert.ok(hasCall(calls, 'decision', 'day', 'hat', '--hat', 'spec'))
    assert.ok(calls.length > before + 1, 'status is refetched after the hat is recorded')

    click(buttonNamed(mounted, 'End day'), mounted.dom)
    await flush()
    assert.ok(hasCall(calls, 'decision', 'day', 'end'))
    await mounted.unmount()
  })
})

test('a failing action shows its error', async () => {
  await withHost((argv) => argv[2] === 'hat'
    ? reply({ ok: false, error: { code: 'not_found', message: 'no active day' } }, 3)
    : reply(activeStatus()), async () => {
    const mounted = mount(() => dayRoute.render())
    await flush()
    click(buttonNamed(mounted, 'Decide'), mounted.dom)
    await flush()
    assert.match(mounted.container.querySelector('[role="alert"]').textContent, /no active day/)
    await mounted.unmount()
  })
})

test('before the start it counts down to the day, and after the end it says the schedule is complete', async () => {
  await withHost(() => reply(activeStatus({ state: 'not_started', current: null, starts_in_seconds: 1800 })), async () => {
    const mounted = mount(() => dayRoute.render())
    await flush()
    assert.match(text(mounted), /The day starts in 30:00/)
    await mounted.unmount()
  })
  await withHost(() => reply(activeStatus({ state: 'finished', current: null, next: null })), async () => {
    const mounted = mount(() => dayRoute.render())
    await flush()
    assert.match(text(mounted), /Today's schedule is complete\./)
    assert.ok(buttonNamed(mounted, 'End day'))
    await mounted.unmount()
  })
})

test('a malformed status is shown as an error, not as an empty day', async () => {
  await withHost(() => ({ code: 0, output: '{not-json' }), async () => {
    const mounted = mount(() => dayRoute.render())
    await flush()
    assert.match(mounted.container.querySelector('[role="alert"]').textContent, /no JSON value/)
    assert.doesNotMatch(text(mounted), /Start day/)  // unknown state: never offer to start a day
    assert.ok(buttonNamed(mounted, 'Retry'))
    await mounted.unmount()
  })
})

test('when the phase countdown runs out the status is refetched and the next phase appears', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 5_000_000 })
  try {
    let statusCalls = 0
    await withHost((argv) => {
      statusCalls += 1
      return reply(statusCalls === 1
        ? activeStatus({ current: { ...HOURS[1], phase: phase('refinement', 2) } })
        : activeStatus({ current: { ...HOURS[1], phase: phase('review', 900, 'review', 'Review the previous hour.') } }))
    }, async () => {
      const mounted = mount(() => dayRoute.render())
      await flush()
      assert.match(text(mounted), /00:02 left in this phase/)

      mock.timers.tick(1000)
      await flush()
      assert.match(text(mounted), /00:01 left in this phase/)
      assert.equal(statusCalls, 1)

      mock.timers.tick(1000)
      await flush()
      assert.equal(statusCalls, 2)
      assert.match(text(mounted), /15:00 left in this phase/)
      assert.match(text(mounted), /Review the previous hour\./)
      await mounted.unmount()
    })
  } finally {
    mock.timers.reset()
  }
})

// --- the online switch, the latest standup, and the watchers -------------------------

const STANDUP_RECORD = {
  ts: '2026-10-02T17:20:00Z',
  data: {
    kanban: { available: true, totals: { running: 1, blocked: 1 } },
    attention: ['1 task blocked: Wire auth', '1 urgent decision waiting'],
  },
}

test('the online switch shows the state and flips it through the CLI', async () => {
  let online = false
  const presenceReply = (argv) => {
    if (argv[2] === 'on') online = true
    if (argv[2] === 'off') online = false
    return reply({ ok: true, presence: { online, since: online ? '2026-10-02T17:00:00Z' : null, last_seen: null } })
  }
  await withHost(() => reply(activeStatus()), async (calls) => {
    const mounted = mount(() => dayRoute.render())
    await flush()
    const off = buttonNamed(mounted, 'Offline')
    assert.equal(off.getAttribute('aria-pressed'), 'false')
    assert.match(text(mounted), /Go online to get standups every 20 minutes\./)

    click(off, mounted.dom)
    await flush()
    assert.ok(hasCall(calls, 'decision', 'presence', 'on'))
    assert.equal(buttonNamed(mounted, 'Online').getAttribute('aria-pressed'), 'true')
    assert.match(text(mounted), /Turns itself off after an hour without interaction\./)

    click(buttonNamed(mounted, 'Online'), mounted.dom)
    await flush()
    assert.ok(hasCall(calls, 'decision', 'presence', 'off'))
    assert.ok(buttonNamed(mounted, 'Offline'))
    await mounted.unmount()
  }, { presence: presenceReply })
})

test('the latest standup is summarised on an active day', async () => {
  await withHost(() => reply(activeStatus()), async () => {
    const mounted = mount(() => dayRoute.render())
    await flush()
    const section = mounted.container.querySelector('[aria-label="Latest standup"]')
    assert.match(section.textContent, /Latest standup/)
    assert.match(section.textContent, /Kanban: 1 running, 1 blocked/)
    assert.match(section.textContent, /1 task blocked: Wire auth/)
    assert.match(section.textContent, /1 urgent decision waiting/)
    await mounted.unmount()
  }, { latest: reply({ ok: true, standup: STANDUP_RECORD }) })
})

test('a quiet standup and an unreadable Kanban are both said plainly', async () => {
  const quiet = { ...STANDUP_RECORD, data: { kanban: { available: true, totals: {} }, attention: [] } }
  await withHost(() => reply(activeStatus()), async () => {
    const mounted = mount(() => dayRoute.render())
    await flush()
    assert.match(text(mounted), /Kanban: no tasks/)
    assert.match(text(mounted), /Nothing needs attention\./)
    await mounted.unmount()
  }, { latest: reply({ ok: true, standup: quiet }) })

  const broken = { ...STANDUP_RECORD, data: { kanban: { available: false }, attention: ['Kanban could not be read: boom'] } }
  await withHost(() => reply(activeStatus()), async () => {
    const mounted = mount(() => dayRoute.render())
    await flush()
    assert.match(text(mounted), /Kanban could not be read\./)
    await mounted.unmount()
  }, { latest: reply({ ok: true, standup: broken }) })
})

test('no standup panel without an active day or without a standup', async () => {
  await withHost(() => reply({ ok: true, active: false }), async () => {
    const mounted = mount(() => dayRoute.render())
    await flush()
    assert.equal(mounted.container.querySelector('[aria-label="Latest standup"]'), null)
    await mounted.unmount()
  }, { latest: reply({ ok: true, standup: STANDUP_RECORD }) })

  await withHost(() => reply(activeStatus()), async () => {
    const mounted = mount(() => dayRoute.render())
    await flush()
    assert.equal(mounted.container.querySelector('[aria-label="Latest standup"]'), null)
    await mounted.unmount()
  })
})

test('the day still shows when presence and the latest standup cannot be read', async () => {
  const failing = reply({ ok: false, error: { code: 'internal_error', message: 'boom' } }, 1)
  await withHost(() => reply(activeStatus()), async () => {
    const mounted = mount(() => dayRoute.render())
    await flush()
    assert.match(text(mounted), /Refinement/)
    assert.equal(mounted.container.querySelector('[role="alert"]'), null)
    assert.ok(!buttonNamed(mounted, 'Online') && !buttonNamed(mounted, 'Offline'))
    await mounted.unmount()
  }, { presence: failing, latest: failing })
})

test('the watchers ask for the standup that is due, announce it, and keep asking each minute', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 5_000_000 })
  try {
    let due = false
    await withHost(() => reply(activeStatus()), async (calls, notifications) => {
      const standupCalls = () => calls.filter((c) => c[1] === 'observer' && c[2] === 'standup').length
      const mounted = mount(() => dayRoute.render())
      await flush()
      assert.equal(standupCalls(), 1)  // once straight away
      assert.deepEqual(notifications, [])

      due = true
      mock.timers.tick(60_000)
      await flush()
      assert.equal(standupCalls(), 2)
      assert.deepEqual(notifications, [{ kind: 'info', message: 'Standup: 1 task blocked: Wire auth · 1 urgent decision waiting' }])

      await mounted.unmount()
      mock.timers.tick(5 * 60_000)
      await flush()
      assert.equal(standupCalls(), 2)  // unmounting stops the poll
    }, {
      standup: () => reply(due ? { ok: true, reported: true, standup: STANDUP_RECORD } : NOTHING_DUE),
    })
  } finally {
    mock.timers.reset()
  }
})

test('a quiet standup is announced as such', async () => {
  const quiet = { ...STANDUP_RECORD, data: { ...STANDUP_RECORD.data, attention: [] } }
  await withHost(() => reply(activeStatus()), async (calls, notifications) => {
    const mounted = mount(() => dayRoute.render())
    await flush()
    assert.deepEqual(notifications, [{ kind: 'info', message: 'Standup: nothing needs attention' }])
    await mounted.unmount()
  }, { standup: reply({ ok: true, reported: true, standup: quiet }) })
})

test('interaction sends a heartbeat at most once a minute, and stops after unmount', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 5_000_000 })
  try {
    await withHost(() => reply(activeStatus()), async (calls) => {
      const touches = () => calls.filter((c) => c[1] === 'presence' && c[2] === 'touch').length
      const mounted = mount(() => dayRoute.render())
      await flush()
      const interact = (type) => mounted.dom.window.dispatchEvent(new mounted.dom.window.Event(type, { bubbles: true }))

      assert.equal(touches(), 0)  // nothing yet: no interaction
      interact('pointerdown')
      interact('keydown')
      assert.equal(touches(), 1)  // throttled together

      mock.timers.tick(30_000)
      interact('pointerdown')
      assert.equal(touches(), 1)
      mock.timers.tick(31_000)
      interact('keydown')
      assert.equal(touches(), 2)

      await mounted.unmount()
      interact('pointerdown')
      assert.equal(touches(), 2)
    })
  } finally {
    mock.timers.reset()
  }
})

test('the pane refreshes itself every minute so an idle expiry shows up', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 5_000_000 })
  try {
    let statusCalls = 0
    await withHost(() => { statusCalls += 1; return reply(activeStatus()) }, async () => {
      const mounted = mount(() => dayRoute.render())
      await flush()
      assert.equal(statusCalls, 1)
      mock.timers.tick(60_000)
      await flush()
      assert.equal(statusCalls, 2)
      await mounted.unmount()
    })
  } finally {
    mock.timers.reset()
  }
})
