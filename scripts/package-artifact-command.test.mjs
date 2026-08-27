import assert from "node:assert/strict"
import test from "node:test"

import { pnpmInvocation } from "./package-artifact-command.mjs"

test("uses shell command resolution for pnpm on Windows", () => {
  assert.deepEqual(pnpmInvocation("win32"), { command: "pnpm", shell: true })
})

test("executes pnpm directly on Unix platforms", () => {
  assert.deepEqual(pnpmInvocation("linux"), { command: "pnpm", shell: false })
})
