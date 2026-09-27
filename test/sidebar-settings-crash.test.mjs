// Uses the interactive DOM harness (test/dom-harness.mjs), not source
// regexes: this bug ("Cannot read properties of undefined/null (reading
// 'side')") only manifests when the pane ACTUALLY RENDERS against a
// specific bad localStorage value — a regex on the source text cannot
// exercise that runtime path at all.
import assert from 'node:assert/strict'

import { collectRegistrations, findRegistration, flush, installLocalStorageStub, mount } from './dom-harness.mjs'

const localStorage = installLocalStorageStub()

// The live crash: "decision-hud:decision-hud:pane failed to render /
// Cannot read properties of undefined (reading 'side')". JSON.parse("null")
// succeeds and returns `null` (it does not throw), so a prior session
// having written the literal string "null" into
// decision-hud:sidebar-settings (or any other bad-but-parseable value: a
// number, an array, a bare string) reaches `parsed.side` with `parsed` not
// being a plain object — property access on null/undefined throws exactly
// this message.
for (const badValue of ['null', '42', '"left"', '[]', 'false']) {
  localStorage.setItem('decision-hud:sidebar-settings', badValue)

  const regs = collectRegistrations()
  const paneReg = findRegistration(regs, 'routes', 'decision-hud-page')
  const { errors, unmount } = mount(paneReg.render)

  await flush()
  await flush()

  assert.deepEqual(
    errors,
    [],
    `mounting the pane with sidebar-settings=${JSON.stringify(badValue)} must not throw (got: ${errors.map((e) => e.message).join(', ')})`,
  )

  await unmount()
}

console.log('sidebar-settings-crash (malformed localStorage never crashes the pane) regression test passed')
