// Embeds core.js into swe.html between the core.js markers, so swe.html stays one offline file.
//   node swe-suite/build.mjs          rewrite swe.html
//   node swe-suite/build.mjs --check  exit 1 if swe.html is out of date
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const htmlPath = join(here, 'swe.html')
const START = '// <core.js>\n'
const END = '// </core.js>\n'

export function embed(html, core) {
  const a = html.indexOf(START)
  const b = html.indexOf(END)
  if (a < 0 || b < a) throw new Error('core.js markers not found in swe.html')
  return html.slice(0, a + START.length) + core + html.slice(b)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const html = readFileSync(htmlPath, 'utf8')
  const next = embed(html, readFileSync(join(here, 'core.js'), 'utf8'))
  if (process.argv.includes('--check')) {
    if (next !== html) { console.error('swe.html is out of date; run node swe-suite/build.mjs'); process.exit(1) }
  } else writeFileSync(htmlPath, next)
}
