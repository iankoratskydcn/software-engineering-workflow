import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../plugin.js', import.meta.url), 'utf8')

assert.match(source, /function TriageBlockedWorkButton\(/)
assert.match(source, /Triage blocked work/)
assert.match(source, /cliExec\(\['kanban', 'diagnostics', '--board', boardSlug, '--json'\]\)/)
assert.match(source, /cliExec\(\['kanban', 'list', '--board', boardSlug, '--status', 'blocked', '--json'\]\)/)
assert.match(source, /cliExec\(\[\s*'decision', 'triage-blocked'/)
assert.match(source, /await onComplete\(\)/)
assert.match(source, /host\.notify\(\{ kind: 'success', message: .*triage/i)
assert.match(source, /jsx\(TriageBlockedWorkButton, \{ boardSlug: boardForControls/)

const backend = await readFile(new URL('../backend-plugin/cli.py', import.meta.url), 'utf8')
assert.match(backend, /add_parser\("triage-blocked"/)
assert.match(backend, /_kanban_task_ids/)
assert.match(backend, /_triage_kind/) 
assert.match(backend, /Investigate\/resolve manually/)
assert.match(backend, /dependency_only/)

console.log('triage blocked work structural test passed')
