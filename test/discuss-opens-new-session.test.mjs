import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(resolve(here, '..', 'plugin.js'), 'utf8')

// Owner request: clicking Discuss should open a NEW chat session with the
// decision context pre-sent as the first message, falling back to the
// original clipboard-copy behavior if that fails (older desktop, RPC
// rejected, etc.) so the action never dead-ends.
const handleDiscussBody = source.slice(
  source.indexOf('const handleDiscuss = React.useCallback('),
  source.indexOf('const handleDiscuss = React.useCallback(') + 4200,
)

assert.match(
  handleDiscussBody,
  /host\.request\('session\.create',\s*\{\s*source:\s*'desktop'\s*\}\)/,
  'handleDiscuss must create a new session via host.request session.create',
)

assert.match(
  handleDiscussBody,
  /host\.request\('prompt\.submit',\s*\{\s*session_id:\s*sessionId,\s*text:\s*seedText\s*\}\)/,
  'handleDiscuss must submit the seed text as the first prompt on the new session',
)

assert.match(
  handleDiscussBody,
  /host\.openSession\(sessionId,/,
  'handleDiscuss must bring the new session into view via host.openSession',
)

assert.match(
  handleDiscussBody,
  /navigator\.clipboard\.writeText\(seedText\)/,
  'handleDiscuss must still fall back to clipboard copy if opening a session fails',
)

// Still banned per palette-navigate-safety.test.mjs.
assert.doesNotMatch(
  handleDiscussBody,
  /host\.navigate\(/,
  'handleDiscuss must never use host.navigate',
)

console.log('discuss-opens-new-session regression test passed')
