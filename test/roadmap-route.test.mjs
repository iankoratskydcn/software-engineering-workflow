import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { collectRegistrations, findRegistration } from './render-harness.mjs'

const source = await readFile(resolve('plugin.js'), 'utf8')

function roadmapSource() {
  const match = source.match(/function Roadmap[\s\S]*?(?=\nfunction |\nconst |\nexport default)/)
  assert.ok(match, 'Roadmap UI component must exist')
  return match[0]
}

test('Roadmap registers a route and is surfaced inside Software Engineering tabs', () => {
  const registrations = collectRegistrations()
  const route = findRegistration(registrations, 'routes', 'roadmap-route')
  assert.equal(route.data?.path, '/decision-hud/roadmap')
  assert.equal(typeof route.render, 'function')
  assert.match(source, /ENGINEERING_TABS[\s\S]*?label: 'Roadmap'/)
  assert.doesNotMatch(source, /id:\s*'roadmap-nav'/)
})

test('Roadmap loads project-scoped data and ignores delayed stale responses', () => {
  const pane = roadmapSource()
  assert.match(pane, /\['roadmap',\s*['"]list['"],\s*['"]--project-id['"],\s*projectId/)
  assert.match(pane, /const roadmap = res\?\.roadmap \|\| res \|\| \{\}/)
  assert.match(pane, /return \(\) => \{?\s*active = false/)
  assert.match(pane, /if \(!active\) return/)
  assert.match(pane, /\[projectId\]/)
})

test('Roadmap update sends complete project-scoped payload including clear flags', () => {
  const pane = roadmapSource()
  assert.match(pane, /function runUpdate\(/)
  assert.match(pane, /['"]roadmap['"],\s*['"]item['"],\s*['"]update['"]\)/)
  assert.match(pane, /['"]--project-id['"].*projectId/)
  assert.match(pane, /['"]--item-id['"].*itemId/)
  assert.match(pane, /['"]--lane-id['"].*laneId/)
  assert.match(pane, /['"]--title['"].*title/)
  assert.match(pane, /['"]--description['"].*description/)
  assert.match(pane, /['"]--status['"].*status/)
  assert.match(pane, /['"]--sort-order['"].*sortOrder/)
  assert.match(pane, /['"]--depends-on['"]/)
  assert.match(pane, /['"]--link['"]/)
  assert.match(pane, /['"]--clear-depends-on['"]/)
  assert.match(pane, /['"]--clear-links['"]/)
  assert.match(pane, /['"]--expected-updated-at['"].*updatedAt/)
})

test('Roadmap failed update preserves draft, exposes error, clears loading, and does not refresh', () => {
  const pane = roadmapSource()
  const update = pane.match(/function runUpdate\([\s\S]*?\n\}/)?.[0]
  assert.ok(update, 'runUpdate must be defined')
  assert.match(update, /return\s+await\s+cliExec|return\s+cliExec/)
  assert.match(pane, /catch\s*\([^)]*\)[\s\S]*?setError\(/)
  assert.match(pane, /finally\s*\{[\s\S]*?setLoading\(false\)/)
  assert.doesNotMatch(pane, /catch\s*\([^)]*\)[\s\S]*?refresh\(/)
  assert.doesNotMatch(pane, /catch\s*\([^)]*\)[\s\S]*?setDraft\(['"]['"]\)/)
})

test('Roadmap clears draft only after confirmed successful update', () => {
  const pane = roadmapSource()
  assert.match(pane, /if\s*\(await\s+runUpdate\([\s\S]*?\)\)\s*\{[\s\S]*?setDraft\(['"]['"]\)/)
  assert.doesNotMatch(pane, /setDraft\(['"]['"]\)[\s\S]*?runUpdate\(/)
  assert.match(pane, /await\s+runUpdate\([\s\S]*?\)[\s\S]*?refresh\(/)
})

test('Roadmap item add keeps the add command instead of rewriting it as update', () => {
  const pane = roadmapSource()
  const submit = pane.match(/const submit = async \([\s\S]*?\n  \}\n  const setDraft/)?.[0]
  assert.ok(submit, 'submit handler must be defined')
  assert.doesNotMatch(submit, /operation === ['"]item['"][\s\S]*?['"]roadmap['"], ['"]item['"], ['"]update['"]/)
  assert.match(submit, /runUpdate\(argv\)|cliExec\(argv\)/)
})

test('Roadmap existing item updates do not clear untouched relationships', () => {
  const pane = roadmapSource()
  const itemUpdate = pane.match(/const argv = \['roadmap', 'item', 'update',[\s\S]*?children: 'Save item'/)?.[0]
  assert.ok(itemUpdate, 'existing item update controls must be defined')
  assert.doesNotMatch(itemUpdate, /--clear-depends-on|--clear-links/)
})

test('Roadmap add failures do not clear lane or item drafts', () => {
  const pane = roadmapSource()
  assert.doesNotMatch(pane, /submit\('lane',[\s\S]*?\)\.then\(\(\) => setLaneDraft\(['"]['"]\)\)/)
  assert.doesNotMatch(pane, /submit\('item',[\s\S]*?\)\.then\(\(\) => setItemDraft\(/)
})

test('Roadmap listValues splits actual newline characters', () => {
  const pane = roadmapSource()
  assert.match(pane, /value\.split\(['"]\\n['"]\)/)
})

test('Roadmap list command is not dead code', () => {
  const pane = roadmapSource()
  const matches = pane.match(/roadmapListCommand/g) || []
  assert.ok(matches.length === 0 || matches.length > 1, 'roadmapListCommand must be used or removed')
})

console.log('roadmap UI hostile RED tests loaded')
