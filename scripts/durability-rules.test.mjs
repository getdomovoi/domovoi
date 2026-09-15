// The two rules exist because each landed twice as a fix in one week (#409,
// #416, then again in a review of the auto-update staging slice) and nothing
// enforced them. A rule that only lives in a review comment is a rule the next
// file does not know about.
import assert from "node:assert/strict"
import { test } from "node:test"

import { ESLint } from "eslint"

const eslint = new ESLint({ cwd: new URL("..", import.meta.url).pathname })
const messages = async (code, filePath) => {
  const [result] = await eslint.lintText(code, { filePath })
  return result.messages.map((message) => message.ruleId + ": " + message.message)
}

test("a JSON.parse result cannot be asserted into a type; a schema decides", async () => {
  const cast = await messages('const value = JSON.parse("{}") as { format: 1 }\nexport default value\n', "apps/daemon/src/probe.ts")
  assert.equal(cast.length, 1)
  assert.match(cast[0], /^no-restricted-syntax: .*JSON\.parse.*schema/)
  const unknown = await messages('const value: unknown = JSON.parse("{}")\nexport default value\n', "apps/daemon/src/probe.ts")
  assert.deepEqual(unknown, [])
})

test("a bare rename from node:fs/promises is refused outside the durable publish helper", async () => {
  const bare = await messages('import { rename } from "node:fs/promises"\nexport const publish = rename\n', "apps/desktop/src/main/probe.ts")
  assert.equal(bare.length, 1)
  assert.match(bare[0], /^@typescript-eslint\/no-restricted-imports: .*publishFileDurably/)
  const helper = await messages('import { rename } from "node:fs/promises"\nexport const publish = rename\n', "packages/credential-store/src/index.ts")
  assert.deepEqual(helper, [])
  const typeOnly = await messages('import type { rename } from "node:fs/promises"\nexport type Publish = typeof rename\n', "apps/cli/src/probe.ts")
  assert.deepEqual(typeOnly, [])
  const other = await messages('import { mkdir } from "node:fs/promises"\nexport const make = mkdir\n', "apps/desktop/src/main/probe.ts")
  assert.deepEqual(other, [])
})
