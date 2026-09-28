import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// 1. Sidebar position (left/right) and size must be persisted settings,
// not the hardcoded 'w-1/4 max-w-[200px] ... border-r' from before.
const SIDEBAR_STORAGE_KEY_RE = /SIDEBAR_SETTINGS_STORAGE_KEY\s*=\s*['"]decision-hud:sidebar-settings['"]/
assert.match(source, SIDEBAR_STORAGE_KEY_RE, 'a sidebar-settings localStorage key constant must exist')

assert.match(
  source,
  /function loadSidebarSettings\(\)/,
  'loadSidebarSettings() must exist (mirrors loadGridLayout)',
)
assert.match(
  source,
  /function saveSidebarSettings\(/,
  'saveSidebarSettings() must exist (mirrors saveGridLayout)',
)

// 2. MetricsSidebar must accept a size/side-configurable width class and a
// position, not hardcode 'w-1/4 max-w-[200px]' and 'border-r' unconditionally.
const sidebarFnMatch = source.match(/function MetricsSidebar\(\{([^}]*)\}\)/)
assert.ok(sidebarFnMatch, 'MetricsSidebar function declaration must exist')
assert.match(
  sidebarFnMatch[1],
  /side/,
  'MetricsSidebar must accept a side prop (left/right)',
)
assert.match(
  sidebarFnMatch[1],
  /widthPx|width/,
  'MetricsSidebar must accept a width-related prop instead of a hardcoded class',
)

// 3. DecisionHudPane may retain persisted settings for compatibility, but the
// workflow page must no longer render the Agent Health metrics sidebar. The
// main workflow column owns the full available width.
const paneMatch = source.match(/function DecisionHudPane\(\{ rest \}\) \{[\s\S]*?\n\}\n/)
assert.ok(paneMatch, 'DecisionHudPane function must exist')
const pane = paneMatch[0]
assert.match(
  pane,
  /const \[sidebarSettings, setSidebarSettings\] = React\.useState\(loadSidebarSettings\)/,
  'DecisionHudPane must track sidebarSettings state initialized from loadSidebarSettings',
)
assert.match(
  pane,
  /const safeSidebarSettings = sidebarSettings[\s\S]{0,120}DEFAULT_SIDEBAR_SETTINGS/,
  'DecisionHudPane must derive a null/undefined-safe view of sidebarSettings before reading its fields (regression: a malformed persisted value must never crash the render — see sidebar-settings-crash.test.mjs)',
)
assert.doesNotMatch(pane, /jsx\(DeferredMetricsSidebar/)
assert.doesNotMatch(pane, /children:\s*safeSidebarSettings\.side === 'right'/)
assert.match(pane, /className: 'relative flex h-full min-w-0 p-3 text-sm'/)
assert.match(pane, /children: mainColumn/)

console.log('sidebar-settings (position + size persisted) structural test passed')
