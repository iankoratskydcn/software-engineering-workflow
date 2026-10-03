// Regression coverage for MindMap reparent (move a node under a different
// parent) built on the sibling-reorder move-node support from the prior
// commit. Same dom-harness pattern as queue-tab-and-mindmap-structure.test.mjs.
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
  if (argv[0] === 'decision' && argv[1] === 'projects') {
    return { code: 0, output: JSON.stringify({ projects: [{ project_id: 'project-1', slug: 'selected-board', name: 'Selected' }] }) }
  }
  if (argv[0] === 'decision' && argv[1] === 'spec' && argv[2] === 'list') {
    return {
      code: 0,
      output: JSON.stringify({
        ok: true,
        nodes: [
          { id: 'sn_root', kind: 'theme', parent_id: null, title: 'Root theme', criteria_json: null },
          { id: 'sn_epic', kind: 'epic', parent_id: 'sn_root', title: 'Some epic', criteria_json: null },
        ],
      }),
    }
  }
  if (argv[0] === 'decision' && argv[1] === 'spec' && argv[2] === 'reparent-node') {
    return { code: 0, output: JSON.stringify({ ok: true, node: { id: 'sn_epic' } }) }
  }
  return { code: 0, output: '[]' }
}

const regs = collectRegistrations()
const paneReg = findRegistration(regs, 'routes', 'decision-hud-page')

let mounted
const originalPrompt = globalThis.window?.prompt
try {
  mounted = mount(paneReg.render)
  await flush()
  await flush()
  assert.deepEqual(mounted.errors, [], `mounting the pane must not throw (got: ${mounted.errors.map((e) => e.message).join(', ')})`)

  const mindMapTab = [...mounted.container.querySelectorAll('[role="tab"]')].find((el) => el.textContent.includes('MindMap'))
  assert.ok(mindMapTab, 'a MindMap tab must exist')
  click(mindMapTab, mounted.dom)
  await flush()
  await flush()

  const nodeButton = [...mounted.container.querySelectorAll('button')].find((el) => el.textContent.includes('Some epic'))
  assert.ok(nodeButton, 'the seeded epic node must be listed')
  click(nodeButton, mounted.dom)
  await flush()
  await flush()

  const structureSection = mounted.container.querySelector('[aria-label="MindMap structure"]')
  assert.ok(structureSection, 'selecting a node must show the Structure actions section')
  const reparentButton = [...structureSection.querySelectorAll('button')].find((el) => el.textContent.includes('Move to'))
  assert.ok(reparentButton, 'a "Move to..." (reparent) control must be present')

  // Cancelling the prompt (returns null) must not call cliExec at all.
  mounted.dom.window.prompt = () => null
  click(reparentButton, mounted.dom)
  await flush()
  await flush()
  assert.ok(
    !requests.some((argv) => argv[0] === 'decision' && argv[1] === 'spec' && argv[2] === 'reparent-node'),
    'cancelling the prompt (null) must not call reparent-node'
  )

  // Confirming with an explicit empty string means "move to root".
  mounted.dom.window.prompt = () => ''
  click(reparentButton, mounted.dom)
  await flush()
  await flush()
  const reparentCall = requests.find((argv) => argv[0] === 'decision' && argv[1] === 'spec' && argv[2] === 'reparent-node')
  assert.ok(reparentCall, 'confirming the prompt must call `decision spec reparent-node`')
  assert.ok(reparentCall.includes('--project-id'), 'reparent-node call must include --project-id')
  assert.ok(reparentCall.includes('--id'), 'reparent-node call must include --id')
  assert.equal(reparentCall[reparentCall.indexOf('--id') + 1], 'sn_epic', 'reparent-node must target the selected node')
  const parentIdIndex = reparentCall.indexOf('--parent-id')
  assert.ok(parentIdIndex !== -1, 'reparent-node call must include --parent-id even when blank')
  assert.equal(reparentCall[parentIdIndex + 1], '', 'an explicit empty prompt value must pass --parent-id as an empty string, not omit the flag')

  assert.equal(mounted.errors.length, 0, `no render errors expected, got: ${mounted.errors.map((e) => e.message).join(', ')}`)
} finally {
  if (mounted?.dom?.window && originalPrompt !== undefined) mounted.dom.window.prompt = originalPrompt
  await mounted?.unmount()
  host.request = originalRequest
}

console.log('MindMap reparent-node regression test passed')
