import assert from "node:assert/strict"
import test from "node:test"

import { pnpmInvocation } from "./package-artifact-command.mjs"

test("resolves the pnpm executable without a shell on Windows", () => {
  const executable = String.raw`C:\Program Files\pnpm\pnpm.exe`

  assert.deepEqual(pnpmInvocation("win32", () => executable), {
    command: executable,
    shell: false,
  })
})

test("executes pnpm directly on Unix platforms", () => {
  assert.deepEqual(pnpmInvocation("linux"), { command: "pnpm", shell: false })
})
