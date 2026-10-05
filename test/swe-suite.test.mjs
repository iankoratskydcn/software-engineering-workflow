import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
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

// ---- canonical JSON ---------------------------------------------------------

test('canonicalJson matches every Python-generated vector', () => {
  const vectors = JSON.parse(read('vectors/canonical_json.json'))
  assert.ok(vectors.length >= 9)
  for (const { value, text } of vectors) assert.equal(core.canonicalJson(value), text, JSON.stringify(value))
})

test('canonicalJson reproduces every committed spec file byte for byte', () => {
  const dir = new URL('../docs/swe/spec/', import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  assert.ok(files.length > 5)
  for (const f of files) {
    const text = readFileSync(new URL(f, dir), 'utf8')
    assert.equal(core.canonicalJson(JSON.parse(text)), text, f)
  }
})

// ---- pure edit rules --------------------------------------------------------

const FEATURE = { id: 'a', kind: 'feature', title: 'A', parent_id: 'root', status: 'draft', criteria: ['x'] }

test('applyEdit changes only what was asked, keeps unknown keys, and clears optional keys', () => {
  const src = { ...FEATURE, estimate: 3, task_ref: 'T-1', decision: { type: 'choice' } }
  const next = core.applyEdit(src, { title: '  New  ', criteria: ['a', ' ', ' b '], estimate: null, task_ref: '' })
  assert.deepEqual(next, { ...FEATURE, title: 'New', criteria: ['a', 'b'], decision: { type: 'choice' } })
  assert.equal(src.estimate, 3, 'the source object is not mutated')
})

test('applyEdit refuses invalid values and an unready node going to ready', () => {
  assert.throws(() => core.applyEdit(FEATURE, { title: ' ' }), /invalid title/)
  assert.throws(() => core.applyEdit(FEATURE, { estimate: 4 }), /estimate must be one of/)
  assert.throws(() => core.applyEdit(FEATURE, { status: 'bogus' }), /status must be one of/)
  assert.throws(() => core.applyEdit(FEATURE, { status: 'ready' }), /not ready: needs an estimate/)
  assert.throws(() => core.applyEdit({ ...FEATURE, estimate: 8 }, { status: 'ready' }), /too big/)
  assert.equal(core.applyEdit({ ...FEATURE, estimate: 3 }, { status: 'ready' }).status, 'ready')
  assert.equal(core.applyEdit({ ...FEATURE, kind: 'epic' }, { status: 'ready' }).status, 'ready', 'epics are never gated')
  assert.equal(core.applyEdit({ ...FEATURE, status: 'approved' }, { title: 'B' }).status, 'approved', 'an existing unusual status is kept')
})

test('ids are filename-safe and unique', () => {
  assert.equal(core.newNodeId('Hello, World!!', new Set()), 'hello-world')
  assert.equal(core.newNodeId('Hello, World!!', new Set(['hello-world', 'hello-world-2'])), 'hello-world-3')
  assert.equal(core.newNodeId('日本語', new Set()), 'node')
  assert.equal(core.validateNode({ ...FEATURE, id: '../evil' }), 'invalid id')
  assert.equal(core.validateNode({ ...FEATURE, id: 'a/b' }), 'invalid id')
})

// ---- editing in the page ------------------------------------------------------

/** In-memory writable storage with a log of what reached "disk". */
function diskStorage(files) {
  const disk = { ...files }
  const log = []
  const storage = {
    writable: true,
    paths: () => Object.keys(disk),
    size: (p) => disk[p].length,
    read: async (p) => disk[p] ?? null,
    fresh: async (p) => disk[p] ?? null,
    freshPaths: async (prefix) => Object.keys(disk).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')),
    write: async (p, t) => { log.push(['write', p]); disk[p] = t },
    remove: async (p) => { log.push(['remove', p]); delete disk[p] },
  }
  return { disk, log, storage }
}
const TREE = (extra = {}) => ({
  'docs/swe/project.json': project,
  'docs/swe/spec/root.json': node({ id: 'root', kind: 'theme', title: 'Root', criteria: [] }),
  'docs/swe/spec/feat.json': node({ id: 'feat', kind: 'feature', title: 'Feat', parent_id: 'root', criteria: ['x'] }),
  ...extra,
})

async function open(files) {
  const { dom, loadSuite } = load()
  const disk = diskStorage(files)
  const w = dom.window
  const state = w.eval('state')
  state.suite = await loadSuite(disk.storage)
  state.storage = disk.storage
  return { w, state, ...disk, render: () => w.eval('render')(), doc: w.document }
}
const field = (doc, name) => doc.querySelector(`[data-field="${name}"]`)
const act = (doc, name) => doc.querySelector(`[data-action="${name}"]`)
const tick = () => new Promise((r) => setTimeout(r, 0))
async function press(doc, name) { act(doc, name).click(); await tick(); await tick() }

test('editing a node writes canonical JSON and keeps the other keys and the .md file', async () => {
  const t = await open(TREE({ 'docs/swe/spec/feat.md': 'notes' }))
  t.state.selected = 'feat'
  t.render()
  field(t.doc, 'estimate').value = '3'
  field(t.doc, 'task_ref').value = 'JIRA-9'
  field(t.doc, 'criteria').value = 'x\ny'
  await press(t.doc, 'save')
  assert.equal(t.doc.querySelector('[role="alert"]').textContent, '')
  assert.deepEqual(t.log, [['write', 'docs/swe/spec/feat.json']])
  assert.equal(t.disk['docs/swe/spec/feat.json'], core.canonicalJson({ ...JSON.parse(node({ id: 'feat', kind: 'feature', title: 'Feat', parent_id: 'root' })), criteria: ['x', 'y'], estimate: 3, task_ref: 'JIRA-9' }))
  assert.equal(t.disk['docs/swe/spec/feat.md'], 'notes')
  assert.match(t.doc.querySelector('[data-testid="readiness"]').textContent, /Ready to commit/)
})

test('a refused edit shows the reason and writes nothing', async () => {
  const t = await open(TREE())
  t.state.selected = 'feat'
  t.render()
  field(t.doc, 'status').value = 'ready'
  await press(t.doc, 'save')
  assert.match(t.doc.querySelector('[role="alert"]').textContent, /not ready: needs an estimate/)
  assert.deepEqual(t.log, [])
})

test('a file changed on disk since it was opened is not overwritten', async () => {
  const t = await open(TREE())
  t.state.selected = 'feat'
  t.render()
  t.disk['docs/swe/spec/feat.json'] = node({ id: 'feat', kind: 'feature', title: 'Edited elsewhere', parent_id: 'root' })
  field(t.doc, 'title').value = 'Mine'
  await press(t.doc, 'save')
  assert.match(t.doc.querySelector('[role="alert"]').textContent, /changed on disk/)
  assert.deepEqual(t.log, [])
})

test('add child creates the next kind down with a safe unique id; a story gets no add control', async () => {
  const t = await open(TREE())
  t.state.selected = 'root'
  t.render()
  field(t.doc, 'child-title').value = 'Brand New Epic!'
  await press(t.doc, 'add')
  const path = 'docs/swe/spec/brand-new-epic.json'
  assert.deepEqual(JSON.parse(t.disk[path]), { criteria: [], id: 'brand-new-epic', kind: 'epic', parent_id: 'root', status: 'draft', title: 'Brand New Epic!' })
  assert.equal(t.state.selected, 'brand-new-epic')

  const story = { ...JSON.parse(node({ id: 's', kind: 'story', title: 'S', parent_id: 'feat' })) }
  const s = await open(TREE({ 'docs/swe/spec/s.json': JSON.stringify(story) }))
  s.state.selected = 's'
  s.render()
  assert.equal(act(s.doc, 'add'), null)
})

test('delete needs a second click, refuses nodes with children and the root, and removes the .md too', async () => {
  const t = await open(TREE({ 'docs/swe/spec/feat.md': 'notes' }))
  t.state.selected = 'root'
  t.render()
  await press(t.doc, 'delete'); await press(t.doc, 'delete')
  assert.match(t.doc.querySelector('[role="alert"]').textContent, /root cannot be deleted/)

  t.state.selected = 'feat'
  t.render()
  await press(t.doc, 'delete')
  assert.deepEqual(t.log, [], 'first click only arms it')
  await press(t.doc, 'delete')
  assert.deepEqual(t.log, [['remove', 'docs/swe/spec/feat.json'], ['remove', 'docs/swe/spec/feat.md']])
  assert.equal(t.state.suite.nodes.length, 1)
  assert.equal(t.state.selected, 'root')

  const kids = await open(TREE())
  kids.state.selected = 'root'
  kids.render()
  await press(kids.doc, 'delete'); await press(kids.doc, 'delete')
  assert.match(kids.doc.querySelector('[role="alert"]').textContent, /root cannot be deleted/)
})

test('without write access there are no edit controls', async () => {
  const { dom, loadSuite } = load()
  const state = dom.window.eval('state')
  state.suite = await loadSuite(storage(TREE()))
  state.storage = storage(TREE())  // no `writable`
  state.selected = 'feat'
  dom.window.eval('render')()
  assert.equal(dom.window.document.querySelector('[data-action="save"]'), null)
})

// ---- File System Access adapter ----------------------------------------------

function fakeDirHandle() {
  const tree = { files: new Map(), dirs: new Map() }
  const mk = (node) => ({
    getDirectoryHandle: async (name, { create } = {}) => {
      if (!node.dirs.has(name)) { if (!create) throw Object.assign(new Error('nf'), { name: 'NotFoundError' }); node.dirs.set(name, { files: new Map(), dirs: new Map() }) }
      return mk(node.dirs.get(name))
    },
    getFileHandle: async (name, { create } = {}) => {
      if (!node.files.has(name)) { if (!create) throw Object.assign(new Error('nf'), { name: 'NotFoundError' }); node.files.set(name, '') }
      return {
        getFile: async () => ({ text: async () => node.files.get(name) }),
        createWritable: async () => { let buf = ''; return { write: async (t) => { buf += t }, close: async () => { node.files.set(name, buf) } } },
      }
    },
    removeEntry: async (name) => { if (!node.files.delete(name)) throw Object.assign(new Error('nf'), { name: 'NotFoundError' }) },
  })
  return { tree, handle: mk(tree) }
}

test('the directory-handle adapter reads, writes (creating folders), and removes by path', async () => {
  const { dom } = load()
  const fsIo = dom.window.eval('fsIo')
  const { tree, handle } = fakeDirHandle()
  const io = fsIo(handle)
  assert.equal(await io.read('docs/swe/spec/a.json'), null)
  await io.write('docs/swe/spec/a.json', 'hi')
  assert.equal(tree.dirs.get('docs').dirs.get('swe').dirs.get('spec').files.get('a.json'), 'hi')
  assert.equal(await io.read('docs/swe/spec/a.json'), 'hi')
  await io.remove('docs/swe/spec/a.json')
  assert.equal(await io.read('docs/swe/spec/a.json'), null)
})

test('delete refuses when the .md changed on disk, or a child appeared on disk, since opening', async () => {
  const md = await open(TREE({ 'docs/swe/spec/feat.md': 'notes' }))
  md.state.selected = 'feat'
  md.render()
  md.disk['docs/swe/spec/feat.md'] = 'notes written elsewhere'
  await press(md.doc, 'delete'); await press(md.doc, 'delete')
  assert.match(md.doc.querySelector('[role="alert"]').textContent, /changed on disk/)
  assert.deepEqual(md.log, [])

  const kid = await open(TREE())
  kid.state.selected = 'feat'
  kid.render()
  kid.disk['docs/swe/spec/late.json'] = node({ id: 'late', kind: 'story', title: 'Late', parent_id: 'feat' })
  await press(kid.doc, 'delete'); await press(kid.doc, 'delete')
  assert.match(kid.doc.querySelector('[role="alert"]').textContent, /children first/)
  assert.deepEqual(kid.log, [])
})

test('add child refuses when the parent changed or was deleted on disk', async () => {
  const t = await open(TREE())
  t.state.selected = 'root'
  t.render()
  delete t.disk['docs/swe/spec/root.json']
  field(t.doc, 'child-title').value = 'Orphan'
  await press(t.doc, 'add')
  assert.match(t.doc.querySelector('[role="alert"]').textContent, /changed on disk/)
  assert.deepEqual(t.log, [])
})

function fakeFolder(files, permission) {
  const handle = (path) => ({
    kind: 'directory',
    entries: async function* () {
      const seen = new Set()
      for (const f of Object.keys(files)) {
        if (!f.startsWith(path)) continue
        const rest = f.slice(path.length), name = rest.split('/')[0]
        if (seen.has(name)) continue
        seen.add(name)
        yield rest.includes('/') ? [name, handle(path + name + '/')] : [name, { kind: 'file', getFile: async () => ({ size: files[f].length, text: async () => files[f] }) }]
      }
    },
    getDirectoryHandle: async () => { throw new Error('not needed for opening') },
    requestPermission: async () => permission,
    name: 'repo',
  })
  return handle('')
}

for (const [permission, label, editable] of [['granted', 'editable', true], ['denied', 'read-only', false]]) {
  test(`opening a folder asks for write access separately: ${permission} is ${label}`, async () => {
    const { dom } = load()
    const w = dom.window
    w.showDirectoryPicker = async (opts) => { assert.equal(opts.mode, 'read'); return fakeFolder(TREE(), permission) }
    w.document.getElementById('open').click()
    for (let i = 0; i < 20 && !/editable|read-only/.test(w.document.getElementById('status').textContent); i++) await tick()
    assert.match(w.document.getElementById('status').textContent, new RegExp(`2 spec nodes · ${label}`))
    w.eval('state').selected = 'feat'
    w.eval('render')()
    assert.equal(!!w.document.querySelector('[data-action="save"]'), editable)
  })
}
