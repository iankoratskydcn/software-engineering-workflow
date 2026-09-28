import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../plugin.js', import.meta.url), 'utf8')
const specDigest = source.slice(source.indexOf('function SpecDigest('), source.indexOf('function SpecDigestRoute('))

assert.match(source, /function stableSpecCriteriaKey\(item, index, items(?:, occurrences)?\)/)
assert.match(specDigest, /criteria\.items\.map\(\(item, index\) => jsx\('li',[\s\S]*?stableSpecCriteriaKey\(item, index, criteria\.items(?:, criteriaOccurrences)?\)\)/)
assert.doesNotMatch(specDigest, /criteria\.items\.map\(\(item, index\)[\s\S]*?\}, index\)/)
assert.match(source, /JSON\.stringify\(item\)/)
assert.match(source, /const criteriaOccurrences = new Map\(\)/)

console.log('spec digest criteria key regression passed')
