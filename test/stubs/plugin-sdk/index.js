// Minimal test stub for @hermes/plugin-sdk. It covers exactly what plugin.js
// imports (see the import line near the top of plugin.js) so the frontend
// tests run from a fresh clone without a hermes-agent checkout.
//
// Area constants match hermes-agent (apps/desktop/src/app/routes.ts and
// apps/desktop/src/app/command-palette/contrib.ts); tests filter on them.
// `host` is a plain mutable object because tests replace host.request.
import * as React from 'react'

const h = React.createElement

// Components pass only accessibility/identity props through to the DOM; styling
// props are dropped so the stub never emits unknown-attribute warnings.
const DOM_PROPS = (rest) =>
  Object.fromEntries(
    Object.entries(rest).filter(
      ([key]) => key.startsWith('aria-') || key.startsWith('data-') || ['role', 'title', 'id'].includes(key),
    ),
  )
const box = (tag) => ({ children, className, style, ...rest }) => h(tag, DOM_PROPS(rest), children)

export const PALETTE_AREA = 'palette'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'

export const host = {
  request: async () => ({ code: 0, output: '[]' }),
  notify() {},
  navigate() {},
}

export const haptic = () => {}
export const cn = (...parts) => parts.filter(Boolean).join(' ')
export const useValue = (value) => value

export const Badge = box('span')
export const Button = ({ children, onClick, disabled, ...rest }) =>
  h('button', { ...DOM_PROPS(rest), onClick, disabled }, children)
export const Codicon = () => null
export const Select = box('div')
export const SelectContent = box('div')
export const SelectItem = box('div')
export const SelectTrigger = box('div')
export const SelectValue = box('span')
export const Separator = () => h('hr')
export const Switch = ({ checked, onCheckedChange, ...rest }) =>
  h('input', {
    ...DOM_PROPS(rest),
    type: 'checkbox',
    checked: !!checked,
    onChange: () => onCheckedChange && onCheckedChange(!checked),
  })
