import assert from 'node:assert/strict'
import { host } from '@hermes/plugin-sdk'
import { mount, flush, installLocalStorageStub } from './dom-harness.mjs'
import plugin from '../plugin.js'

installLocalStorageStub()
localStorage.setItem('decision-hud:selected-board', 'selected-board')

const originalRequest = host.request
const requests = []
host.request = async (method, params) => {
  if (method !== 'cli.exec') return originalRequest(method, params)
  const argv = params?.argv || []
  requests.push(argv)
  if (argv[0] === 'kanban' && argv[1] === 'boards' && argv[2] === 'list') {
    return { code: 0, output: JSON.stringify([{ slug: 'selected-board', project_id: 'canonical-project' }]) }
  }
  if (argv[0] === 'spec' && argv[1] === 'list') {
    return { code: 0, output: JSON.stringify([{ id: 'spec-1', kind: 'requirement', title: 'Seeded requirement', criteria_json: '[]' }]) }
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
  mounted = mount(route.render)
  await flush()
} finally {
  console.error = originalConsoleError
}
assert.match(mounted.container.textContent, /Seeded requirement/)
assert.ok(requests.some((argv) => argv[0] === 'spec' && argv[1] === 'list' && argv.includes('--project-id') && argv.includes('canonical-project')), 'route must fetch selected canonical project nodes')
assert.equal(mounted.errors.length, 0)
assert.deepEqual(warnings, [], `Spec Digest must not emit React warnings: ${warnings.join('; ')}`)
await mounted.unmount()
host.request = originalRequest
console.log('spec digest route regression passed')
