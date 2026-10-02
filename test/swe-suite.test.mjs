import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { JSDOM } from 'jsdom'

import { embed } from '../swe-suite/build.mjs'

const read = (p) => readFileSync(new URL(`../swe-suite/${p}`, import.meta.url), 'utf8')
const html = read('swe.html')
const coreSrc = read('core.js')
const core = new Function(`${coreSrc}\nreturn SweCore`)()

test('core.js readiness matches every Python-generated vector', () => {
  const vectors = JSON.parse(read('vectors/readiness.json'))
  assert.ok(vectors.length > 300)
  for (const { input, output } of vectors) {
    assert.deepEqual(core.readiness(input), output, JSON.stringify(input))
  }
})

test('swe.html embeds the current core.js (run node swe-suite/build.mjs)', () => {
  assert.equal(embed(html, coreSrc), html)
})

test('swe.html cannot reach the network: strict CSP, no network APIs, no external URLs', () => {
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]
  assert.ok(csp, 'CSP meta tag present')
  assert.match(csp, /default-src 'none'/)
  assert.doesNotMatch(csp, /connect-src|https?:|\*/)
  for (const banned of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'import(', 'importScripts', 'navigator.serviceWorker']) {
    assert.ok(!html.includes(banned), `swe.html must not use ${banned}`)
  }
  assert.doesNotMatch(html, /<(script|link|img|iframe)\b[^>]*\b(src|href)=/i, 'no external resources')
  assert.doesNotMatch(html, /https?:\/\//, 'no URLs at all')
})

function load() {
  const dom = new JSDOM(html, { runScripts: 'dangerously' })
  return { dom, loadSuite: dom.window.eval('loadSuite'), nodeDetail: dom.window.eval('nodeDetail') }
}

function storage(files) {
  return {
    paths: () => Object.keys(files),
    size: (p) => files[p].length,
    read: async (p) => files[p] ?? null,
  }
}
const project = JSON.stringify({ schema_version: 1, name: 'p' })
const node = (o) => JSON.stringify({ id: 'a', kind: 'feature', title: 'A', parent_id: null, status: 'draft', criteria: [], ...o })

test('loadSuite accepts estimate and task_ref and rejects bad ones', async () => {
  const { loadSuite } = load()
  const ok = await loadSuite(storage({ 'docs/swe/project.json': project, 'docs/swe/spec/a.json': node({ estimate: 3, task_ref: 'JIRA-7' }) }))
  assert.equal(ok.errors.length, 0)
  assert.equal(ok.nodes[0].estimate, 3)
  for (const bad of [{ estimate: 4 }, { estimate: '3' }, { task_ref: 7 }, { task_ref: 'x'.repeat(201) }]) {
    const r = await loadSuite(storage({ 'docs/swe/project.json': project, 'docs/swe/spec/a.json': node(bad) }))
    assert.equal(r.nodes.length, 0, JSON.stringify(bad))
    assert.equal(r.errors.length, 1, JSON.stringify(bad))
  }
})

test('node detail shows readiness for features, and nothing for themes', async () => {
  const { dom, loadSuite, nodeDetail } = load()
  const text = async (o) => {
    const s = await loadSuite(storage({ 'docs/swe/project.json': project, 'docs/swe/spec/a.json': node(o) }))
    const holder = dom.window.document.createElement('div')
    holder.append(...nodeDetail(s.nodes[0], new Map(s.nodes.map((n) => [n.id, n]))))
    return holder.querySelector('[data-testid="readiness"]')?.textContent ?? null
  }
  assert.match(await text({}), /Not ready: needs at least one acceptance criterion; needs an estimate/)
  assert.match(await text({ criteria: ['x'], estimate: 8 }), /8 points is too big/)
  assert.equal(await text({ criteria: ['x'], estimate: 3, task_ref: 'T-1' }), 'Ready to commit')
  assert.equal(await text({ kind: 'theme' }), null)
})
