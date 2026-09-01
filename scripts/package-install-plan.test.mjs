import assert from "node:assert/strict"
import test from "node:test"

import { installPlan, packageManagers } from "./package-install-plan.mjs"

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
