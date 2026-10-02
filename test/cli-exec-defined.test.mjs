// Regression test for commit 59c83e6 ("remove retired startup work"), which
// deleted `async function cliExec` while ~40 call sites remained. Every pane
// that resolves its project through useKanbanBoards failed with a
// ReferenceError that the hook's catch block turned into a silent empty
// board list, so panes showed "No project selected". Source-regex tests could
// not see it, and the Spec Digest malformed-data test accepted that text as a
// pass. This test drives the real route with no projectId override, so board
// resolution through cliExec has to actually work.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { host } from '@hermes/plugin-sdk'
import { mount, flush, installLocalStorageStub } from './dom-harness.mjs'
import plugin from '../plugin.js'

installLocalStorageStub()

const source = await readFile(resolve('plugin.js'), 'utf8')

test('cliExec is defined in plugin.js', () => {
  assert.match(source, /async function cliExec\(/)
})

test('board-gated pane resolves its project through cliExec', async () => {
  const originalRequest = host.request
  const calls = []
  host.request = async (method, params) => {
    calls.push(params?.argv)
    if (method === 'cli.exec' && params?.argv?.[0] === 'kanban') {
      return { code: 0, output: JSON.stringify([{ slug: 'main-board', project_id: 'project-1' }]) }
    }
    if (method === 'cli.exec' && params?.argv?.[0] === 'decision' && params?.argv?.[1] === 'spec') {
      return { code: 0, output: JSON.stringify([{ id: 'n1', kind: 'story', title: 'Resolved via board', criteria_json: '[]' }]) }
    }
    return { code: 0, output: '[]' }
  }
  try {
    const registrations = []
    plugin.register({ registerMany(items) { registrations.push(...items) }, register() {}, rest() {} })
    const route = registrations.find((item) => item.data?.path === '/spec-digest')
    const mounted = mount(() => route.render())
    await flush()
    assert.deepEqual(mounted.errors, [])
    assert.ok(
      calls.some((argv) => argv?.join(' ') === 'kanban boards list --json'),
      'boards must be listed through cliExec',
    )
    assert.ok(
      calls.some((argv) => argv?.join(' ') === 'decision spec list --project-id project-1'),
      'spec list must be requested for the board project',
    )
    assert.match(mounted.container.textContent, /story: Resolved via board/)
    assert.doesNotMatch(mounted.container.textContent, /No project selected/)
    await mounted.unmount()
  } finally {
    host.request = originalRequest
  }
})
