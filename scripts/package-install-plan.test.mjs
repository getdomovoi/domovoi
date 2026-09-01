import assert from "node:assert/strict"
import test from "node:test"

import { installPlan, isContinuousIntegration, packageManagers, shellArguments } from "./package-install-plan.mjs"

test("plans an install and a run for every package manager", () => {
  assert.deepEqual(installPlan("npm", "/tmp/pkg.tgz"), {
    install: { command: "npm", args: ["install", "--no-audit", "--no-fund", "/tmp/pkg.tgz"] },
    run: { command: "node", args: ["smoke.mjs"] },
  })
  assert.deepEqual(installPlan("pnpm", "/tmp/pkg.tgz"), {
    install: { command: "pnpm", args: ["add", "--ignore-workspace", "/tmp/pkg.tgz"] },
    run: { command: "node", args: ["smoke.mjs"] },
  })
  assert.deepEqual(installPlan("bun", "/tmp/pkg.tgz"), {
    install: { command: "bun", args: ["add", "/tmp/pkg.tgz"] },
    run: { command: "bun", args: ["run", "smoke.mjs"] },
  })
})

test("refuses a package manager it has no plan for", () => {
  assert.throws(() => installPlan("yarn", "/tmp/pkg.tgz"), /yarn/)
})

test("runs every manager that is installed", () => {
  assert.deepEqual(packageManagers({ present: ["npm", "pnpm", "bun"], ci: false }), {
    run: ["npm", "pnpm", "bun"],
    skipped: [],
    failures: [],
  })
})

test("skips a missing manager outside CI", () => {
  assert.deepEqual(packageManagers({ present: ["npm", "pnpm"], ci: false }), {
    run: ["npm", "pnpm"],
    skipped: ["bun"],
    failures: [],
  })
})

test("fails on a missing manager in CI, where the distribution claim is proven", () => {
  assert.deepEqual(packageManagers({ present: ["npm", "pnpm"], ci: true }), {
    run: ["npm", "pnpm"],
    skipped: ["bun"],
    failures: ["bun is not installed, so the published artifact was not verified against it"],
  })
})

test("quotes an argument containing a space when a shell will parse it", () => {
  assert.deepEqual(
    shellArguments(["add", "C:\\Temp\\domovoi pack-1E0\\protocol.tgz"], "win32"),
    ["add", '"C:\\Temp\\domovoi pack-1E0\\protocol.tgz"'],
  )
})

test("leaves arguments alone where no shell is involved", () => {
  assert.deepEqual(
    shellArguments(["add", "/tmp/domovoi pack-1E0/protocol.tgz"], "darwin"),
    ["add", "/tmp/domovoi pack-1E0/protocol.tgz"],
  )
})

test("reads CI as set only when its value means yes", () => {
  assert.equal(isContinuousIntegration({ CI: "true" }), true)
  assert.equal(isContinuousIntegration({ CI: "1" }), true)
  assert.equal(isContinuousIntegration({ CI: "false" }), false)
  assert.equal(isContinuousIntegration({ CI: "0" }), false)
  assert.equal(isContinuousIntegration({ CI: "" }), false)
  assert.equal(isContinuousIntegration({}), false)
})
