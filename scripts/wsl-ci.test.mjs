import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, matchesGlob } from "node:path"
import test from "node:test"

import { bootstrapDeadline } from "./bootstrap-deadline.mjs"
import { assertWslReport, downloadWslImage, runWslCi } from "./wsl-ci.mjs"

const require = createRequire(new URL("../apps/daemon/package.json", import.meta.url))
const { parse } = require("yaml")
const passed = { numTotalTests: 15, numPassedTests: 15, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true,
  testResults: [{ assertionResults: [
    "opens the native repository through the Windows CLI without changing the Windows workspace",
    "keeps the native repository owned by the guest while executing real Git",
    "refuses the custom-mounted Windows drive through the Windows open shim",
    "refuses WSL shares at the Windows daemon before repository inspection",
    "rediscovers the restarted guest with its repository and pairing intact",
  ].map((title) => ({ title, status: "passed" })) }] }

function fixture(overrides = {}) {
  const calls = []
  const effects = {
    downloadImage: async () => {},
    downloadNode: async () => {},
    run: async (command, args, options) => {
      assert.ok(options.signal instanceof AbortSignal)
      assert.equal(options.signal.aborted, false)
      calls.push({ command, args, options })
      return args.includes("uname") ? "6.6.87.2-microsoft-standard-WSL2\n"
        : args.includes("wslpath") ? "/fixture/path" : ""
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
  assert.equal(job["timeout-minutes"], 25)
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

test("six discovery proofs alone no longer satisfy the transport job", () => {
  assert.throws(() => assertWslReport({ ...passed, numTotalTests: 6, numPassedTests: 6 }), /WSL native proofs/)
})

test("a green transport report without repository boundary proofs is insufficient", () => {
  assert.throws(() => assertWslReport({ ...passed, numTotalTests: 10, numPassedTests: 10, testResults: [] }), /WSL native proofs.*repository/)
  for (const assertion of passed.testResults[0].assertionResults) {
    const withoutOne = { ...passed, testResults: [{ assertionResults: passed.testResults[0].assertionResults
      .filter((entry) => entry !== assertion) }] }
    assert.throws(() => assertWslReport(withoutOne), (error) => error.message.includes(assertion.title))
    assert.throws(() => assertWslReport({ ...withoutOne, testResults: [{ assertionResults: [
      ...withoutOne.testResults[0].assertionResults, { ...assertion, status: "pending" },
    ] }] }), (error) => error.message.includes(assertion.title))
  }
})

test("image download streams the pinned bytes and refuses a digest mismatch", { timeout: 5_000 }, async () => {
  const deadline = bootstrapDeadline(3_000, "test image deadline")
  let directory
  try {
    directory = await deadline.run(() => mkdtemp(join(tmpdir(), "domovoi-wsl-download-")))
    const payload = Buffer.from("small archive fixture")
    const image = { url: "https://example.test/ubuntu.wsl", sha256: createHash("sha256").update(payload).digest("hex") }
    const download = async function* (url, options) {
      assert.equal(url, image.url)
      assert.equal(options.maximumBytes, 1024 * 1024 * 1024)
      assert.equal(options.inactivityTimeoutMs, 30_000)
      assert.equal(options.deadline, deadline)
      yield payload.subarray(0, 5)
      yield payload.subarray(5)
    }
    const valid = join(directory, "valid.wsl")
    await downloadWslImage(valid, deadline, { image, download })
    assert.deepEqual(await readFile(valid), payload)
    await assert.rejects(downloadWslImage(join(directory, "bad.wsl"), deadline, {
      image: { ...image, sha256: "0".repeat(64) }, download,
    }), /WSL image sha256 differs/)
  } finally {
    deadline.clear()
    const cleanup = bootstrapDeadline(1_000, "test image cleanup deadline")
    try { if (directory) await cleanup.run(() => rm(directory, { recursive: true, force: true })) }
    finally { cleanup.clear() }
  }
})

test("a failed image check never reaches installation", async () => {
  const { calls, effects } = fixture({ downloadImage: async () => { throw new Error("WSL image sha256 differs") } })
  await assert.rejects(runWslCi({ platform: "win32", effects }), /sha256 differs/)
  assert.equal(calls.some(({ args }) => args.includes("--install")), false)
  assert.equal(calls.some(({ args }) => args.includes("--unregister")), false)
})

test("provisions exactly one distro, requires it in the test process, then removes only it", async () => {
  const { calls, effects } = fixture()
  const result = await runWslCi({ platform: "win32", effects })
  const install = calls.filter(({ args }) => args.includes("--install"))
  assert.equal(install.length, 1)
  const distribution = install[0].args.at(-1)
  assert.match(distribution, /^domovoi-ci-[a-f0-9-]{36}$/)
  const proof = calls.find(({ args }) => args.includes("src/wsl-windows.test.ts"))
  assert.ok(proof.args.includes("--reporter=default"), "keep readable error causes alongside the JSON report")
  assert.ok(proof.args.includes("--reporter=json"))
  assert.equal(proof.options.env.DOMOVOI_WSL_REQUIRED_DISTRIBUTION, distribution)
  assert.equal(proof.options.env.DOMOVOI_WSL_EXPECTED_MOUNT_ROOT, "/domovoi-ci-drives/")
  assert.ok(calls.some(({ args }) => args.includes("uname")))
  for (const { args } of calls.filter(({ args }) => args[0] === "-d")) {
    assert.equal(args[4], "--exec", "provisioning must not add an implicit Linux shell")
  }
  assert.deepEqual(calls.at(-1).args, ["--unregister", distribution])
  assert.deepEqual(result.phases.map(({ name }) => name), ["provision", "guest runtime", "native proofs", "cleanup"])
  assert.equal(result.tests, 15)
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

test("a failed proof prints its report before cleanup and keeps the process error", async () => {
  const events = []
  const proofError = new Error("Vitest exited 1: JSON report written to native.json")
  const failed = { ...passed, success: false, numFailedTests: 1, numPassedTests: 5,
    testResults: [{ assertionResults: [{ fullName: "required guest discovery", status: "failed",
      failureMessages: ["Expected the provisioned guest to be Running, received Stopped"] }] }] }
  const original = fixture()
  const { effects } = fixture({
    run: (command, args, options) => {
      if (args.includes("src/wsl-windows.test.ts")) throw proofError
      if (args[0] === "--unregister") events.push("unregister")
      return original.effects.run(command, args, options)
    },
    readReport: async () => failed,
    log: (line) => events.push(line),
  })
  await assert.rejects(runWslCi({ platform: "win32", effects }), (error) => error === proofError)
  const report = events.findIndex((line) => line.includes('"testResults"'))
  assert.ok(report >= 0, "the nonzero Vitest exit must not hide its JSON report")
  assert.ok(report < events.indexOf("unregister"), "read the report before removing its directory")
  assert.match(events[report], /Expected the provisioned guest to be Running, received Stopped/)
})

test("a missing proof report is named without replacing the original failure", async () => {
  const lines = []
  const proofError = new Error("test runner could not start")
  const original = fixture()
  const { effects } = fixture({
    run: (command, args, options) => {
      if (args.includes("src/wsl-windows.test.ts")) throw proofError
      return original.effects.run(command, args, options)
    },
    readReport: async () => { throw new Error("ENOENT: native.json") },
    log: (line) => lines.push(line),
  })
  await assert.rejects(runWslCi({ platform: "win32", effects }), (error) => error === proofError)
  assert.match(lines.join("\n"), /WSL native proof report unavailable.*native\.json.*ENOENT/)
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

test("expiry during staging creation keeps its promise for cleanup", { timeout: 3_000 }, async () => {
  let created
  let late
  const { effects } = fixture({ createStaging: () => {
    late = new Promise((resolve) => setTimeout(() => resolve(mkdtemp(join(tmpdir(), "domovoi-wsl-late-"))), 150))
    return late.then((path) => { created = path; return path })
  } })
  try {
    await assert.rejects(runWslCi({ platform: "win32", effects, budgets: { provision: 50, proofs: 50, cleanup: 1_000 } }), /provision.*deadline/)
    const observation = bootstrapDeadline(1_000, "late staging observation deadline")
    try {
      await observation.run(() => late)
      await observation.run(() => assert.rejects(access(created), { code: "ENOENT" }))
    } finally { observation.clear() }
  } finally {
    const cleanup = bootstrapDeadline(1_000, "late staging test cleanup deadline")
    try {
      if (late) await cleanup.run(() => late)
      if (created) await cleanup.run(() => rm(created, { recursive: true, force: true }))
    } finally { cleanup.clear() }
  }
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
