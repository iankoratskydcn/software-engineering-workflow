import assert from 'node:assert/strict'
import { host } from '@hermes/plugin-sdk'
import { mount, flush, installLocalStorageStub, click } from './dom-harness.mjs'
import plugin from '../plugin.js'

installLocalStorageStub()
localStorage.setItem('decision-hud:selected-board', 'selected-board')

const originalRequest = host.request
const requests = []
let projectId = 'canonical-project'
const criteriaByProject = {
  'canonical-project': ['Alpha criterion', 'Beta criterion'],
  'reordered-project': ['Beta criterion', 'Alpha criterion'],
  'inserted-project': ['Inserted criterion', 'Alpha criterion', 'Beta criterion', 'Alpha criterion'],
}
host.request = async (method, params) => {
  if (method !== 'cli.exec') return originalRequest(method, params)
  const argv = params?.argv || []
  requests.push(argv)
  if (argv[0] === 'kanban' && argv[1] === 'boards' && argv[2] === 'list') {
    return { code: 0, output: JSON.stringify([{ slug: 'selected-board', project_id: 'canonical-project' }]) }
  }
  if (argv[0] === 'decision' && argv[1] === 'spec' && argv[2] === 'list') {
    const requestedProject = argv[argv.indexOf('--project-id') + 1]
    return { code: 0, output: JSON.stringify({ ok: true, nodes: [{ id: 'spec-1', kind: 'requirement', title: 'Seeded requirement', criteria_json: JSON.stringify(criteriaByProject[requestedProject]) }] }) }
  }
  return { code: 0, output: '[]' }
}

const registrations = []
plugin.register({
  registerMany(items) { registrations.push(...items) },
  register() {},
  rest() {},
})
const route = registrations.find((item) => item.area === 'routes' && item.data?.path === '/spec-digest')
assert.ok(route, 'Spec Digest route must be registered')
const warnings = []
const originalConsoleError = console.error
console.error = (...args) => warnings.push(args.join(' '))
let mounted
try {
  const render = () => route.render({ projectId })
  mounted = mount(render)
  await flush()
  assert.match(mounted.container.textContent, /Seeded requirement/)
  assert.ok(requests.some((argv) => argv[0] === 'decision' && argv[1] === 'spec' && argv[2] === 'list' && argv.includes('--project-id') && argv.includes('canonical-project')), 'route must fetch selected canonical project nodes')
  const nodeButton = mounted.container.querySelector('button')
  assert.ok(nodeButton)
  click(nodeButton, mounted.dom)
  await flush()
  assert.match(mounted.container.textContent, /Alpha criterion/)
  assert.match(mounted.container.textContent, /Beta criterion/)
  const initialItems = [...mounted.container.querySelectorAll('li')]
  assert.equal(initialItems.length, 2)
  assert.equal(mounted.errors.length, 0)

  projectId = 'reordered-project'
  mounted.rerender(render)
  await flush()
  const reorderedNodeButton = mounted.container.querySelector('button')
  click(reorderedNodeButton, mounted.dom)
  await flush()
  const reorderedItems = [...mounted.container.querySelectorAll('li')]
  assert.deepEqual(reorderedItems.map((item) => item.textContent), ['Beta criterion', 'Alpha criterion'])
  assert.equal(reorderedItems[0], initialItems[1], 'reordered existing criterion must retain DOM identity')
  assert.equal(reorderedItems[1], initialItems[0], 'reordered existing criterion must retain DOM identity')
  assert.equal(mounted.errors.length, 0)

  projectId = 'inserted-project'
  mounted.rerender(render)
  await flush()
  const insertedNodeButton = mounted.container.querySelector('button')
  click(insertedNodeButton, mounted.dom)
  await flush()
  assert.match(mounted.container.textContent, /Inserted criterion/)
  assert.match(mounted.container.textContent, /Alpha criterion/)
  assert.match(mounted.container.textContent, /Beta criterion/)
  assert.equal(mounted.container.querySelectorAll('li').length, 4)
  assert.equal(mounted.errors.length, 0)
} finally {
  console.error = originalConsoleError
  await mounted?.unmount()
  host.request = originalRequest
}
assert.deepEqual(warnings, [], `Spec Digest must not emit React warnings: ${warnings.join('; ')}`)
console.log('spec digest route regression passed')
