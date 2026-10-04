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
    return { code: 0, output: JSON.stringify({ decisions: [], projects: [] }) }
  }
  if (argv[0] === 'decision' && argv[1] === 'projects') {
    return { code: 0, output: JSON.stringify({ projects: [] }) }
  }
  if (argv[0] === 'decision' && argv[1] === 'mindmap' && argv[2] === 'list') {
    return { code: 0, output: JSON.stringify([{ id: 'map-1', name: 'Canonical map', description: '' }]) }
  }
  if (argv[0] === 'decision' && argv[1] === 'spec' && argv[2] === 'list') {
    return { code: 0, output: JSON.stringify({ ok: true, nodes: [{ id: 'node-1', kind: 'theme', title: 'Root', parent_id: null }] }) }
  }
  if (argv[0] === 'decision' && argv[1] === 'mindmap' && argv[2] === 'export-markdown') {
    return { code: 0, output: JSON.stringify({ ok: true, markdown: '# Canonical map\n\n- Root' }) }
  }
  return { code: 0, output: '[]' }
}

const paneReg = findRegistration(collectRegistrations(), 'routes', 'decision-hud-page')
let mounted
try {
  mounted = mount(paneReg.render)
  await flush()
  await flush()
  const mindMapTab = [...mounted.container.querySelectorAll('[role="tab"]')].find((el) => el.textContent.includes('MindMap'))
  assert.ok(mindMapTab)
  click(mindMapTab, mounted.dom)
  await flush()
  await flush()

  const jsonButton = mounted.container.querySelector('[aria-label="Export MindMap JSON source of truth"]')
  const markdownButton = mounted.container.querySelector('[aria-label="Export MindMap Markdown projection"]')
  const importButton = mounted.container.querySelector('[aria-label="Import MindMap Markdown projection"]')
  assert.ok(jsonButton && !jsonButton.disabled)
  assert.ok(markdownButton && !markdownButton.disabled)
  assert.ok(importButton && !importButton.disabled)

  click(jsonButton, mounted.dom)
  await flush()
  assert.match(mounted.container.querySelector('textarea').value, /"format": "mindmap-json"/)
  assert.match(mounted.container.querySelector('textarea').value, /"title": "Root"/)

  click(markdownButton, mounted.dom)
  await flush()
  await flush()
  assert.ok(requests.some((argv) => argv[0] === 'decision' && argv[1] === 'mindmap' && argv[2] === 'export-markdown' && argv.includes('--map-id') && argv.includes('map-1')))
  assert.equal(mounted.container.querySelector('textarea').value, '# Canonical map\n\n- Root')
  assert.match(mounted.container.textContent, /Markdown projection/)
  assert.equal(mounted.errors.length, 0)
} finally {
  await mounted?.unmount()
  host.request = originalRequest
}

console.log('MindMap JSON/Markdown interchange test passed')
