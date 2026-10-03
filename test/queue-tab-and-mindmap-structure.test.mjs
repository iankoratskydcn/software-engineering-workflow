// Regression coverage for two gaps found in manual trial (2026-10-03):
// 1. ENGINEERING_TABS had no entry for the actual decision queue — the
//    card-stack (useDecisionQueue + DecisionCard) existed but was never
//    reachable from the UI.
// 2. MindMap had no way to add, rename, delete, or reorder a node.
import assert from 'node:assert/strict'

import { host } from '@hermes/plugin-sdk'
import { click, collectRegistrations, findRegistration, flush, installLocalStorageStub, mount } from './dom-harness.mjs'

installLocalStorageStub()
localStorage.setItem('decision-hud:selected-board', 'selected-board')

const originalRequest = host.request
const requests = []
host.request = async (method, params) => {
  if (method !== 'cli.exec') return originalRequest(method, params)
  const argv = params?.argv || []
  requests.push(argv)
  if (argv[0] === 'kanban' && argv[1] === 'boards' && argv[2] === 'list') {
    return { code: 0, output: JSON.stringify([{ slug: 'selected-board', project_id: 'project-1' }]) }
  }
  if (argv[0] === 'decision' && argv[1] === 'list') {
    return {
      code: 0,
      output: JSON.stringify({
        decisions: [{ id: 'd_1', question: 'Ship it?', card_type: 'default_choice', choices: ['yes', 'no'] }],
      }),
    }
  }
  if (argv[0] === 'decision' && argv[1] === 'projects') {
    return { code: 0, output: JSON.stringify({ projects: [{ project_id: 'project-1', slug: 'selected-board', name: 'Selected' }] }) }
  }
  if (argv[0] === 'decision' && argv[1] === 'spec' && argv[2] === 'list') {
    return {
      code: 0,
      output: JSON.stringify({
        ok: true,
        nodes: [{ id: 'sn_root', kind: 'theme', parent_id: null, title: 'Root theme', criteria_json: null }],
      }),
    }
  }
  if (argv[0] === 'decision' && argv[1] === 'spec' && argv[2] === 'move-node') {
    return { code: 0, output: JSON.stringify({ ok: true, node: { id: 'sn_root' } }) }
  }
  return { code: 0, output: '[]' }
}

const regs = collectRegistrations()
const paneReg = findRegistration(regs, 'routes', 'decision-hud-page')

let mounted
try {
  mounted = mount(paneReg.render)
  await flush()
  await flush()
  assert.deepEqual(mounted.errors, [], `mounting the pane must not throw (got: ${mounted.errors.map((e) => e.message).join(', ')})`)

  // --- Queue tab exists and renders the pending decision -------------------
  const queueTab = [...mounted.container.querySelectorAll('[role="tab"]')].find((el) => el.textContent.includes('Queue'))
  assert.ok(queueTab, 'a Queue tab must be registered in the tab strip')
  click(queueTab, mounted.dom)
  await flush()
  await flush()
  assert.match(mounted.container.textContent, /Ship it\?/, 'Queue tab must render the pending decision question')
  assert.ok(
    requests.some((argv) => argv[0] === 'decision' && argv[1] === 'list'),
    'Queue tab must fetch the decision list'
  )

  // --- MindMap tab exposes structure actions on the selected node ---------
  const mindMapTab = [...mounted.container.querySelectorAll('[role="tab"]')].find((el) => el.textContent.includes('MindMap'))
  assert.ok(mindMapTab, 'a MindMap tab must exist')
  click(mindMapTab, mounted.dom)
  await flush()
  await flush()

  const nodeButton = [...mounted.container.querySelectorAll('button')].find((el) => el.textContent.includes('Root theme'))
  assert.ok(nodeButton, 'the seeded root node must be listed')
  click(nodeButton, mounted.dom)
  await flush()
  await flush()

  const structureSection = mounted.container.querySelector('[aria-label="MindMap structure"]')
  assert.ok(structureSection, 'selecting a node must show the Structure actions section')
  assert.match(structureSection.textContent, /\+ epic/, 'a theme node must offer "+ epic" to add a child')
  assert.ok(structureSection.querySelector('[aria-label="Move up"]'), 'Move up control must be present')
  assert.ok(structureSection.querySelector('[aria-label="Move down"]'), 'Move down control must be present')
  assert.match(structureSection.textContent, /Rename/)
  assert.match(structureSection.textContent, /Delete/)

  const moveDownButton = structureSection.querySelector('[aria-label="Move down"]')
  click(moveDownButton, mounted.dom)
  await flush()
  await flush()
  assert.ok(
    requests.some((argv) => argv[0] === 'decision' && argv[1] === 'spec' && argv[2] === 'move-node' && argv.includes('down')),
    'Move down must call `decision spec move-node ... --direction down`'
  )

  assert.equal(mounted.errors.length, 0, `no render errors expected, got: ${mounted.errors.map((e) => e.message).join(', ')}`)
} finally {
  await mounted?.unmount()
  host.request = originalRequest
}

console.log('decision queue tab and MindMap structure actions regression test passed')
