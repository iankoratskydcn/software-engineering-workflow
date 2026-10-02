// Cost/Quality/Speed was intentionally retired from the user-facing UI.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../plugin.js', import.meta.url), 'utf8')

assert.doesNotMatch(source, /data-dashboard-section': 'comparison'/)
assert.doesNotMatch(source, /label: 'Cost\/Quality\/Speed Comparison: Open page'/)

console.log('retired comparison surface structural test passed')
