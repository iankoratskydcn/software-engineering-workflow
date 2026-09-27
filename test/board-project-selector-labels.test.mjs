// Uses the interactive DOM harness (test/dom-harness.mjs): asserts the two
// row-selectors visible in the pane both carry a visible label, so they no
// longer read as two unlabeled duplicate "all" controls stacked together
// (owner report from a live screenshot: "Board settings — default" toggles
// sandwiched between an unlabeled capitalized board-tab row above and an
// unlabeled lowercase "all" project-tab row below, with nothing telling the
// two apart).
import assert from 'node:assert/strict'

import { collectRegistrations, findRegistration, flush, installLocalStorageStub, mount } from './dom-harness.mjs'

installLocalStorageStub()

const regs = collectRegistrations()
const paneReg = findRegistration(regs, 'routes', 'decision-hud-page')
const { container, errors, unmount } = mount(paneReg.render)

await flush()
await flush()

assert.deepEqual(errors, [], `mounting the pane must not throw (got: ${errors.map((e) => e.message).join(', ')})`)

assert.equal(container.querySelectorAll('[aria-label="Board"]').length, 1, 'BoardSelector must expose the current Board aria-label')

await unmount()

console.log('board-project-selector-labels (route-backed Board selector is labeled) regression test passed')
