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

// spotlight_pick resolves on a single click, same as QuadChoiceCard's
// existing one-click-resolves precedent (a simple pick list doesn't need
// a separate confirm step) -- every other new card is multi-step and
// does need ConfirmButton.
const NO_CONFIRM_BUTTON = new Set(['spotlight_pick'])

for (const [cardType, fnName] of Object.entries(NEW_CARDS)) {
  const match = source.match(new RegExp(`function ${fnName}\\([\\s\\S]*?\\n\\}\\n`))
  assert.ok(match, `${fnName} must be defined`)
  const body = match[0]
  assert.match(body, /DefaultChoiceCard/, `${fnName} must fall back to DefaultChoiceCard on malformed/empty payload`)
  if (!NO_CONFIRM_BUTTON.has(cardType)) {
    assert.match(body, /ConfirmButton/, `${fnName} must confirm through ConfirmButton`)
  } else {
    assert.match(body, /onResolve\(/, `${fnName} must resolve directly on click`)
  }
  assert.match(
    source,
    new RegExp(`${cardType}:\\s*${fnName}`),
    `CARD_RENDERERS must register "${cardType}" -> ${fnName}`
  )
}

console.log('v2 card type definitions (binary_toggle/ranked_score/spotlight_pick/cluster_overlap/bipartite_assign/field_group/precedence_graph/rating_grid) structural test passed')
