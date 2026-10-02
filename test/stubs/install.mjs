// Copies the committed @hermes/plugin-sdk test stub into node_modules.
// Run AFTER `npm i --no-save react react-dom jsdom`, because npm prunes
// packages it does not know about (see the test:setup script in package.json).
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(here, '..', '..', 'node_modules', '@hermes', 'plugin-sdk')
rmSync(target, { recursive: true, force: true })
mkdirSync(dirname(target), { recursive: true })
cpSync(resolve(here, 'plugin-sdk'), target, { recursive: true })
console.log(`installed @hermes/plugin-sdk test stub -> ${target}`)
