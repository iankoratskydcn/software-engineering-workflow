// Interactive DOM mount harness for the decision-hud desktop plugin — a
// step up from render-harness.mjs's static SSR: this mounts into a real
// jsdom document with react-dom/client so tests can simulate actual clicks
// (e.g. opening the gear icon's settings popover) and catch runtime errors
// that only surface after a state update, not on first render. Static SSR
// (renderToStaticMarkup) only ever exercises the FIRST render; several bugs
// in this plugin's history only appeared after a click flipped some piece
// of state (settingsOpen, a toggled dial-grid column count, …), which this
// harness is built specifically to reach.
//
// Uses jsdom + react/react-dom symlinked in from the hermes-agent checkout,
// same provenance as render-harness.mjs's react-dom/server import.
import { JSDOM } from 'jsdom'
import * as React from 'react'
import { createRoot } from 'react-dom/client'

import pluginModule from '../plugin.js'

/** A localStorage-shaped in-memory stub so components calling
 *  loadXSettings()/saveXSettings() at module scope or in useState
 *  initializers don't throw when localStorage isn't defined globally
 *  (plain Node has no localStorage; jsdom's own window.localStorage is
 *  origin-restricted and awkward to wire through globalThis reliably across
 *  jsdom versions, so a tiny explicit stub is more predictable here). */
export function installLocalStorageStub() {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
  return globalThis.localStorage
}

/** Mount one registration's render() into a fresh jsdom document. Returns
 *  { container, root, dom, unmount(), errors } — `errors` collects any
 *  render/commit-phase error React reports via onUncaughtError /
 *  onCaughtError (React 19's replacement for the old console.error-scraping
 *  approach), so a crash inside an error boundary (this plugin wraps each
 *  card in one, see CardErrorBoundary) still surfaces to the test instead
 *  of being silently swallowed by the boundary's own fallback UI. */
export function mount(renderFn) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')

  // react-dom/client reads scheduling/priority state off the GLOBAL window
  // (resolveUpdatePriority etc. call window.event internally), not off a
  // window instance passed to it explicitly — createRoot has no such
  // parameter. Point the ambient globals at this jsdom window for the
  // duration of the mount so react-dom's client renderer (built for a real
  // browser tab) has one to find.
  const previousGlobals = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  // globalThis.navigator is a getter-only accessor in modern Node (it backs
  // the built-in Navigator API) — a plain assignment throws
  // "Cannot set property navigator of #<Object> which has only a getter".
  // Object.defineProperty overrides the accessor for the duration of the
  // mount instead.
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })

  const container = dom.window.document.getElementById('root')
  const errors = []

  const root = createRoot(container, {
    onUncaughtError: (error) => errors.push(error),
    onCaughtError: (error) => errors.push(error),
  })

  root.render(React.createElement(renderFn))

  return {
    container,
    dom,
    errors,
    rerender: (nextRenderFn) => root.render(React.createElement(nextRenderFn)),
    unmount: async () => {
      root.unmount()
      // react-dom's scheduler keeps a `setImmediate` callback queued even
      // past `root.unmount()` — restoring `window` synchronously right
      // after unmount() races that pending callback: it fires later in the
      // same event-loop turn, still expects a global `window`, and throws
      // "Cannot read properties of undefined (reading 'event')" once this
      // function has already un-set it. Give the scheduler one more flush
      // to drain before touching the globals it depends on. This makes
      // unmount() async — every caller must await it.
      await flush()
      globalThis.window = previousGlobals.window
      globalThis.document = previousGlobals.document
      Object.defineProperty(globalThis, 'navigator', { value: previousGlobals.navigator, configurable: true, writable: true })
    },
  }
}

/** Flush queued microtasks/effects — React 19's createRoot commits
 *  synchronously for a sync `render()` call, but effects (useEffect) run in
 *  a microtask, AND the scheduler package (react-dom's dependency) queues
 *  its own work via setImmediate, which fires AFTER a setTimeout(0) in
 *  Node's event-loop ordering. Chain both so a caller awaiting this once
 *  after mount/click has genuinely let effects AND scheduler-queued work
 *  finish, not just the first of the two.
 *
 *  Runs THREE such rounds, not one. A component whose effect kicks off an
 *  async operation (e.g. a `rest()` fetch) and calls `setState` from that
 *  promise's `.then()` needs a second scheduler pass to commit that
 *  follow-up render: round 1 settles the initial commit (e.g. a loading
 *  state), and the state update from the resolved promise only commits on
 *  round 2 (a third is slack for anything chaining one more hop). A
 *  component that only needed one round is unaffected — the extra rounds
 *  are idle ticks once its effects are already settled. */
export async function flush() {
  const round = () => new Promise((resolve) => setTimeout(() => setImmediate(resolve), 0))
  await round()
  await round()
  await round()
}

/** Find one registration by area + id, same contract as render-harness's
 *  findRegistration (throws loudly on a miss instead of returning undefined
 *  to a caller that then NPEs one line later). */
export function collectRegistrations() {
  const registrations = []
  pluginModule.register({
    register: (reg) => {
      registrations.push(reg)
      return () => {}
    },
    registerMany: (regs) => {
      for (const reg of regs) registrations.push(reg)
    },
  })
  return registrations
}

export function findRegistration(registrations, area, id) {
  const found = registrations.find((r) => r.area === area && r.id === id)
  if (!found) {
    throw new Error(`no registration found for area=${area} id=${id} (found: ${registrations.map((r) => `${r.area}/${r.id}`).join(', ')})`)
  }
  return found
}

/** Click a DOM element (jsdom's dispatchEvent + a real MouseEvent, not a
 *  React-only synthetic-event shortcut — exercises the actual event path
 *  React attaches its delegated listener to). */
export function click(el, dom) {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
}
