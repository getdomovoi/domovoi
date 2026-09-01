import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { packPackage } from "./pack-package.mjs"
import { installPlan, packageManagers, supportedManagers } from "./package-install-plan.mjs"

const run = promisify(execFile)
const selector = "@getdomovoi/protocol"

const smokeTest = `import assert from "node:assert/strict"
import { permissionModeSchema, protocolVersion } from "@getdomovoi/protocol"

assert.match(protocolVersion, /^\\d+\\.\\d+\\.\\d+$/)
assert.equal(permissionModeSchema.parse("build"), "build")
assert.throws(() => permissionModeSchema.parse("root"))
console.log("imported @getdomovoi/protocol " + protocolVersion)
`

async function installed(manager) {
  try {
    await run(manager, ["--version"], { encoding: "utf8", shell: process.platform === "win32" })
    return true
  } catch {
    return false
  }
}

async function verify(manager, archive) {
  const project = mkdtempSync(join(tmpdir(), "domovoi install-"))
  const plan = installPlan(manager, archive)
  const options = { cwd: project, encoding: "utf8", shell: process.platform === "win32" }

  try {
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "domovoi-install-check", private: true, type: "module" }),
    )
    writeFileSync(join(project, "smoke.mjs"), smokeTest)
    await run(plan.install.command, plan.install.args, options)
    const { stdout } = await run(plan.run.command, plan.run.args, options)
    return stdout.trim()
  } finally {
    rmSync(project, { force: true, recursive: true })
  }
}

const packDirectory = mkdtempSync(join(tmpdir(), "domovoi pack-"))
const failures = []

try {
  const archive = await packPackage(selector, packDirectory)
  const present = []
  for (const manager of supportedManagers) if (await installed(manager)) present.push(manager)

  const { run: managers, skipped, failures: missing } = packageManagers({
    present,
    ci: Boolean(process.env.CI),
  })
  failures.push(...missing)

  for (const manager of managers) {
    try {
      console.log(`${manager}: ${await verify(manager, archive)}`)
    } catch (error) {
      failures.push(`${manager}: ${error.stderr?.trim() || error.message}`)
    }
  }
  for (const manager of skipped) console.log(`${manager}: not installed, skipped`)
} finally {
  rmSync(packDirectory, { force: true, recursive: true })
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exitCode = 1
} else {
  console.log("Published artifact installs and runs")
}
