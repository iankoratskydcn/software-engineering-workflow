import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Same source-text-assertion convention as zone-select-controls.test.mjs:
// one light structural check per new card_type (defined, falls back to
// DefaultChoiceCard on malformed/empty payload, confirms through
// ConfirmButton, registered in CARD_RENDERERS) rather than a full DOM
// mount for all 8 -- real DOM render coverage for one representative card
// (RankedScoreCard, the most interactive of the new ones) follows below.

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

const NEW_CARDS = {
  binary_toggle: 'BinaryToggleCard',
  ranked_score: 'RankedScoreCard',
  spotlight_pick: 'SpotlightPickCard',
  cluster_overlap: 'ClusterOverlapCard',
  bipartite_assign: 'BipartiteAssignCard',
  field_group: 'FieldGroupCard',
  precedence_graph: 'PrecedenceGraphCard',
  rating_grid: 'RatingGridCard',
}

for (const [cardType, fnName] of Object.entries(NEW_CARDS)) {
  const match = source.match(new RegExp(`function ${fnName}\\([\\s\\S]*?\\n\\}\\n`))
  assert.ok(match, `${fnName} must be defined`)
  const body = match[0]
  assert.match(body, /DefaultChoiceCard/, `${fnName} must fall back to DefaultChoiceCard on malformed/empty payload`)
  assert.match(body, /ConfirmButton/, `${fnName} must confirm through ConfirmButton`)
  assert.match(
    source,
    new RegExp(`${cardType}:\\s*${fnName}`),
    `CARD_RENDERERS must register "${cardType}" -> ${fnName}`
  )
}

// Codex regression (PR #23): the guard originally only checked
// choices[0]/[1] !== undefined, so a 3- or 4-choice push (push_decision
// accepts 2-4 in general) silently dropped every choice past index 1
// instead of falling back to the plain list.
{
  const match = source.match(/function BinaryToggleCard\([\s\S]*?\n\}\n/)
  assert.ok(match, 'BinaryToggleCard must be defined')
  assert.match(
    match[0],
    /choices\.length\s*!==\s*2/,
    'BinaryToggleCard must reject choice lists that are not exactly 2 long, not just check [0]/[1] are defined'
  )
}

// Codex regression (PR #28): selection was tracked by option label, so two
// options sharing a display label with different values would conflate --
// clicking the second always resolved the first's value via Array#find.
{
  const match = source.match(/function SpotlightPickCard\([\s\S]*?\n\}\n/)
  assert.ok(match, 'SpotlightPickCard must be defined')
  assert.match(
    match[0],
    /pickedIndex/,
    'SpotlightPickCard must track the selected option by index, not by label, so duplicate labels with distinct values resolve correctly'
  )
}

console.log('v2 card type definitions (binary_toggle/ranked_score/spotlight_pick/cluster_overlap/bipartite_assign/field_group/precedence_graph/rating_grid) structural test passed')
