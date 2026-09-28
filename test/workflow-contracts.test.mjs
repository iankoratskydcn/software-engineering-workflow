import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { host } from '@hermes/plugin-sdk'
import { mount, flush, installLocalStorageStub } from './dom-harness.mjs'
import plugin from '../plugin.js'

installLocalStorageStub()

const source = await readFile(resolve('plugin.js'), 'utf8')

test('workflow tabs match the supplied prototype order and default', () => {
  const match = source.match(/const ENGINEERING_TABS = \[[\s\S]*?\n\]/)
  assert.ok(match, 'ENGINEERING_TABS must exist')
  const tabs = [...match[0].matchAll(/id: '([^']+)'[\s\S]*?label: '([^']+)'/g)].map(([, id, label]) => ({ id, label }))
  assert.deepEqual(tabs, [
    { id: 'mindmap', label: 'MindMap' },
    { id: 'roadmap', label: 'Roadmap' },
    { id: 'riskTradeoff', label: 'Risk & Tradeoffs' },
    { id: 'flowcharts', label: 'Flowcharts' },
    { id: 'architecture', label: 'Architecture' },
    { id: 'spec', label: 'Spec Digest' },
    { id: 'planning', label: 'Scrum Planning' },
  ])
  assert.match(source, /useState\('mindmap'\)/)
})

test('unified workspace uses the prototype title instead of the legacy Decision HUD heading', () => {
  assert.match(source, /children: 'Software Engineering Workflow'/)
  assert.doesNotMatch(source, /className: 'shrink-0 font-medium', children: 'Decision HUD'/)
})

test('MindMap exposes the prototype search and selected-node detail model', () => {
  assert.match(source, /function MindMapPane\(/)
  assert.match(source, /mindQuery/)
  assert.match(source, /Search stories/)
  assert.match(source, /selectedMindNode/)
  assert.match(source, /gridTemplateColumns: '280px 1fr'/)
})

test('agent health sidebar and retired telemetry are absent from the workflow shell', () => {
  assert.doesNotMatch(source, /function DeferredMetricsSidebar\(/)
  assert.doesNotMatch(source, /function MetricsSidebar\(/)
  assert.doesNotMatch(source, /jsx\(DeferredMetricsSidebar/)
  assert.match(source, /className: 'relative flex h-full min-w-0 p-3 text-sm'/)
  assert.match(source, /children: mainColumn/)
})

test('Spec Digest shows malformed backend data as an error, not an empty success', async () => {
  const originalRequest = host.request
  const registrations = []
  host.request = async (method, params) => {
    if (method === 'cli.exec' && params?.argv?.[0] === 'decision' && params?.argv?.[1] === 'spec') {
      return { code: 0, output: '{not-json' }
    }
    if (method === 'cli.exec' && params?.argv?.[0] === 'kanban') {
      return { code: 0, output: JSON.stringify([{ slug: 'selected-board', project_id: 'project-1' }]) }
    }
    return { code: 0, output: '[]' }
  }
  try {
    plugin.register({ registerMany(items) { registrations.push(...items) }, register() {}, rest() {} })
    const route = registrations.find((item) => item.data?.path === '/spec-digest')
    const mounted = mount(() => route.render({ projectId: 'project-1' }))
    await flush()
    assert.match(mounted.container.textContent, /unavailable|malformed|error/i)
    assert.doesNotMatch(mounted.container.textContent, /No spec|No nodes|No requirements/i)
    await mounted.unmount()
  } finally {
    host.request = originalRequest
  }
})
