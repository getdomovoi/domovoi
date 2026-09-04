import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { packPackage } from "./pack-package.mjs"
import {
  installPlan,
  isContinuousIntegration,
  packageManagers,
  shellArguments,
  supportedManagers,
} from "./package-install-plan.mjs"

const run = promisify(execFile)
const selector = "@getdomovoi/protocol"

const smokeTest = `import assert from "node:assert/strict"
import { permissionModeSchema, protocolVersion } from "@getdomovoi/protocol"

assert.match(protocolVersion, /^\\d+\\.\\d+\\.\\d+$/)
assert.equal(permissionModeSchema.parse("build"), "build")
assert.throws(() => permissionModeSchema.parse("root"))
console.log("imported @getdomovoi/protocol " + protocolVersion)
`

const typedConsumer = `import { permissionModeSchema, protocolVersion } from "@getdomovoi/protocol"
import type { PermissionMode } from "@getdomovoi/protocol"

const mode: PermissionMode = permissionModeSchema.parse("build")

export const summary: string = protocolVersion + " " + mode
`

const resolutions = ["nodenext", "bundler", "node10"]

function typeCheckProject(resolution) {
  return {
    compilerOptions: {
      module: resolution === "nodenext" ? "nodenext" : "esnext",
      moduleResolution: resolution,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: "es2023",
      types: [],
    },
    files: ["consumer.ts"],
  }
}

function typescriptCompiler() {
  const packageRequire = createRequire(
    fileURLToPath(new URL("../packages/protocol/package.json", import.meta.url)),
  )
  return packageRequire.resolve("typescript/bin/tsc")
}

async function verifyTypes(archive) {
  const project = mkdtempSync(join(tmpdir(), "domovoi types-"))
  const plan = installPlan("npm", archive)
  const options = { cwd: project, encoding: "utf8", shell: process.platform === "win32" }
  const compiler = typescriptCompiler()

  try {
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "domovoi-types-check", private: true, type: "module" }),
    )
    writeFileSync(join(project, "consumer.ts"), typedConsumer)
    await run(plan.install.command, shellArguments(plan.install.args), options)

    for (const resolution of resolutions) {
      const config = `tsconfig.${resolution}.json`
      writeFileSync(join(project, config), JSON.stringify(typeCheckProject(resolution)))
      await run(process.execPath, [compiler, "--project", config], options)
    }
    return `types resolve under ${resolutions.join(", ")}`
  } finally {
    rmSync(project, { force: true, recursive: true })
  }
}

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
    await run(plan.install.command, shellArguments(plan.install.args), options)
    const { stdout } = await run(plan.run.command, shellArguments(plan.run.args), options)
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
    ci: isContinuousIntegration(),
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

  if (managers.includes("npm")) {
    try {
      console.log(`typescript: ${await verifyTypes(archive)}`)
    } catch (error) {
      failures.push(`typescript: ${error.stdout?.trim() || error.stderr?.trim() || error.message}`)
    }
  } else {
    failures.push("npm is not installed, so consumer type resolution was not verified")
  }
} finally {
  rmSync(packDirectory, { force: true, recursive: true })
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exitCode = 1
} else {
  console.log("Published artifact installs and runs")
}
