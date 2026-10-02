import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Isolate the DecisionHudPane function body so assertions are scoped to it
// rather than matching unrelated code elsewhere in the file.
const paneMatch = source.match(/function DecisionHudPane\(\{ rest \}\) \{[\s\S]*?\n\}\n/)
assert.ok(paneMatch, 'DecisionHudPane function must exist')
const pane = paneMatch[0]

// 1. A fullscreen-open boolean state must exist (replaces the old anchored
//    popover toggle — the gear now opens a game-menu-style overlay).
assert.match(
  pane,
  /const \[settingsFullscreenOpen, setSettingsFullscreenOpen\] = React\.useState\(false\)/,
  'DecisionHudPane must track an open/closed boolean state for the fullscreen settings overlay',
)

// 2. A gear/settings button element must exist in the render tree.
assert.match(
  pane,
  /['"]?aria-label['"]?:\s*'(?:Settings|Grid settings|Open settings)'/,
  'a gear/settings button with an aria-label must exist in the render tree',
)
assert.match(
  pane,
  /onClick:\s*\(\)\s*=>\s*setSettingsFullscreenOpen\(true\)/,
  'the gear button must open the fullscreen settings overlay directly on click',
)

// 3. SettingsFullscreen must be mounted, driven by settingsFullscreenOpen.
assert.match(
  pane,
  /jsx\(SettingsFullscreen,\s*\{\s*\n\s*isOpen:\s*settingsFullscreenOpen,/,
  'SettingsFullscreen must be mounted and driven by settingsFullscreenOpen',
)

// 4. SettingsFullscreen must render as a pane-local overlay (absolute +
//    inset-0 + a high z-index), not cover the entire desktop viewport.
const settingsFullscreenDef = source.match(/function SettingsFullscreen\([\s\S]*?\n\}\n/)
assert.ok(settingsFullscreenDef, 'SettingsFullscreen component must be defined')
assert.match(
  settingsFullscreenDef[0],
  /absolute inset-0 z-50/,
  'SettingsFullscreen must stay within the Decision HUD pane (absolute inset-0) above pane content (z-50)',
)
assert.match(
  settingsFullscreenDef[0],
  /jsx\(SubagentRulesTab,/,
  'SettingsFullscreen must render the Subagent Rules tab',
)

// 5. SubagentRulesTab must exist and drive the decision-hud CLI settings
//    bridge (subagent skill injection settings live in the same plugin now)
//    via useSubagentRuleSettings' save() closure.
const subagentTabDef = source.match(/function SubagentRulesTab\(\)[\s\S]*?\n\}\n/)
assert.ok(subagentTabDef, 'SubagentRulesTab component must be defined')
assert.match(
  subagentTabDef[0],
  /save\('subagent_inject_enabled'/,
  'SubagentRulesTab must persist the enabled toggle via the settings save() hook',
)
assert.match(
  subagentTabDef[0],
  /save\('subagent_inject_rule'/,
  'SubagentRulesTab must persist the rule text via the settings save() hook',
)
const useSettingsHookDef = source.match(/function useSubagentRuleSettings\(\)[\s\S]*?\n\}\n/)
assert.ok(useSettingsHookDef, 'useSubagentRuleSettings hook must be defined')
assert.match(
  useSettingsHookDef[0],
  /cliExec\(\['decision', 'settings-get'\]\)/,
  'useSubagentRuleSettings must read settings via `hermes decision settings-get`',
)
assert.match(
  useSettingsHookDef[0],
  /cliExec\(\['decision', 'settings-set', key, value\]\)/,
  'useSubagentRuleSettings must write settings via `hermes decision settings-set`',
)

console.log('settings gear fullscreen overlay structural test passed')
