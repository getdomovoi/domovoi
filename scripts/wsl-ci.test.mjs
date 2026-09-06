import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { matchesGlob } from "node:path"
import test from "node:test"

import { assertWslReport, runWslCi } from "./wsl-ci.mjs"

const require = createRequire(new URL("../apps/daemon/package.json", import.meta.url))
const { parse } = require("yaml")
const passed = { numTotalTests: 6, numPassedTests: 6, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true }

function fixture(overrides = {}) {
  const calls = []
  const effects = {
    downloadImage: async () => {},
    run: async (command, args, options) => {
      assert.ok(options.signal instanceof AbortSignal)
      assert.equal(options.signal.aborted, false)
      calls.push({ command, args, options })
      return args.includes("uname") ? "6.6.87.2-microsoft-standard-WSL2\n" : ""
    },
    readReport: async () => passed,
    log: () => {},
    ...overrides,
  }
  return { calls, effects }
}

test("WSL job is separate, path-filtered, nightly and bounded", async () => {
  const workflow = parse(await readFile(new URL("../.github/workflows/wsl.yml", import.meta.url), "utf8"))
  const paths = workflow.on.pull_request.paths
  for (const path of ["apps/daemon/src/wsl-list.ts", "apps/daemon/src/wsl-windows.test.ts",
    "apps/daemon/src/open-command.ts", "packages/protocol/src/fleet.ts", "packages/protocol/src/transport.ts",
    "scripts/wsl-ci.mjs", ".github/workflows/wsl.yml", "pnpm-lock.yaml"]) {
    assert.ok(paths.some((pattern) => matchesGlob(path, pattern)), `WSL job must cover ${path}`)
  }
  for (const path of ["apps/mobile/src/app.tsx", "packages/ui/src/styles.css", "README.md"]) {
    assert.equal(paths.some((pattern) => matchesGlob(path, pattern)), false, `${path} must not start WSL`)
  }
  assert.match(workflow.on.schedule[0].cron, /^\d+ \d+ \* \* \*$/)
  assert.equal(workflow.on.pull_request_target, undefined)
  assert.deepEqual(workflow.permissions, { contents: "read" })
  assert.deepEqual(Object.keys(workflow.jobs), ["native"])
  const job = workflow.jobs.native
  assert.equal(job["runs-on"], "windows-2025")
  assert.equal(job["timeout-minutes"], 15)
  assert.equal(job["continue-on-error"], undefined)
  assert.ok(job.steps.some((step) => step.run === "node scripts/wsl-ci.mjs"))
  for (const step of job.steps) assert.equal(step["continue-on-error"], undefined)
  const ordinary = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
  assert.doesNotMatch(ordinary, /wsl-ci|wsl\.exe --install/)
})

test("required native report rejects an empty, skipped or failed run", () => {
  assert.doesNotThrow(() => assertWslReport(passed))
  for (const bad of [undefined, {}, { ...passed, numTotalTests: 0, numPassedTests: 0 },
    { ...passed, numPassedTests: 0, numPendingTests: 6 }, { ...passed, numPendingTests: 1 },
    { ...passed, numTodoTests: 1 }, { ...passed, numFailedTests: 1 }, { ...passed, success: false }]) {
    assert.throws(() => assertWslReport(bad), /WSL native proofs must pass.*no skipped/)
  }
})

test("provisions exactly one distro, requires it in the test process, then removes only it", async () => {
  const { calls, effects } = fixture()
  const result = await runWslCi({ platform: "win32", effects })
  const install = calls.filter(({ args }) => args.includes("--install"))
  assert.equal(install.length, 1)
  const distribution = install[0].args.at(-1)
  assert.match(distribution, /^domovoi-ci-[a-f0-9-]{36}$/)
  const proof = calls.find(({ args }) => args.includes("src/wsl-windows.test.ts"))
  assert.equal(proof.options.env.DOMOVOI_WSL_REQUIRED_DISTRIBUTION, distribution)
  assert.equal(proof.options.env.DOMOVOI_WSL_EXPECTED_MOUNT_ROOT, "/domovoi-ci-drives/")
  assert.ok(calls.some(({ args }) => args.includes("uname")))
  assert.deepEqual(calls.at(-1).args, ["--unregister", distribution])
  assert.deepEqual(result.phases.map(({ name }) => name), ["provision", "native proofs", "cleanup"])
  assert.equal(result.tests, 6)
})

test("missing virtualization fails before the proofs, not as a green skip", async () => {
  const basic = fixture()
  const { calls, effects } = fixture({ run: async (command, args, options) => {
    calls.push({ command, args, options })
    if (args.includes("--install")) throw new Error("HCS_E_HYPERV_NOT_INSTALLED")
    return basic.effects.run(command, args, options)
  } })
  await assert.rejects(runWslCi({ platform: "win32", effects }), /HCS_E_HYPERV_NOT_INSTALLED/)
  assert.equal(calls.some(({ args }) => args.includes("src/wsl-windows.test.ts")), false)
  assert.equal(calls.at(-1).args[0], "--unregister")
})

test("a working WSL executable with a WSL 1 guest is not enough", async () => {
  const { calls, effects } = fixture({ run: async (command, args, options) => {
    calls.push({ command, args, options })
    return "4.4.0-19041-Microsoft"
  } })
  await assert.rejects(runWslCi({ platform: "win32", effects }), /WSL 2 kernel/)
  assert.equal(calls.some(({ args }) => args.includes("src/wsl-windows.test.ts")), false)
})

test("a skipped native suite fails even when the test runner exits zero", async () => {
  const { calls, effects } = fixture({ readReport: async () => ({ ...passed, numPassedTests: 0, numPendingTests: 6 }) })
  await assert.rejects(runWslCi({ platform: "win32", effects }), /no skipped/)
  assert.equal(calls.at(-1).args[0], "--unregister")
})

test("a silent provisioning call expires and cleanup gets its own finite budget", { timeout: 3_000 }, async () => {
  let aborted
  const { calls, effects } = fixture({ run: async (command, args, options) => {
    calls.push({ command, args, options })
    if (args.includes("--install")) {
      aborted = options.signal
      return new Promise(() => {})
    }
    return ""
  } })
  await assert.rejects(runWslCi({ platform: "win32", effects, budgets: { provision: 100, proofs: 100, cleanup: 100 } }), /provision.*deadline/)
  assert.equal(aborted.aborted, true)
  assert.equal(calls.at(-1).args[0], "--unregister")
  assert.equal(calls.at(-1).options.signal.aborted, false)
})

test("cleanup failure cannot turn a successful proof into success", async () => {
  const original = fixture()
  const { effects } = fixture({ run: (command, args, options) => {
    if (args[0] === "--unregister") throw new Error("test distribution still registered")
    return original.effects.run(command, args, options)
  } })
  await assert.rejects(runWslCi({ platform: "win32", effects }), /test distribution still registered/)
})

test("the dedicated proof command refuses a non-Windows host", async () => {
  const { calls, effects } = fixture()
  await assert.rejects(runWslCi({ platform: "linux", effects }), /requires a Windows host/)
  assert.deepEqual(calls, [])
})
