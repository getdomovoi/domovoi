import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { executableOnPath } from "./desktop-smoke.mjs"
import { launchSmokeCommand, launchSmokeElectronArgs, launchSmokeEnvironment } from "./launch-smoke-args.mjs"

const require = createRequire(import.meta.url)
const directory = await mkdtemp(join(tmpdir(), "domovoi-fleet-origin-proof-"))
let removalSafe = true
try {
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }))
  for (const name of ["fleet-origin", "renderer-security", "renderer-resources"]) {
    const source = await readFile(new URL(`../src/main/${name}.ts`, import.meta.url), "utf8")
    await writeFile(join(directory, `${name}.js`), ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText)
  }
  await copyFile(new URL("../src/renderer/public/fleet-socket.js", import.meta.url), join(directory, "fleet-socket.js"))
  await writeFile(join(directory, "index.html"), "<!DOCTYPE html><html><body>Origin proof</body></html>")
  const electron = require("electron")
  const electronArgs = [...launchSmokeElectronArgs({ platform: process.platform, ci: process.env.CI === "true",
    desktopRoot: fileURLToPath(new URL("./fleet-origin-smoke.fixture.cjs", import.meta.url)),
  }), directory]
  const xvfb = process.platform === "linux" ? await executableOnPath("xvfb-run") : undefined
  const { command, args } = launchSmokeCommand({ platform: process.platform, env: process.env, electronPath: electron, electronArgs, xvfb })
  // This child alone owns these resources. No process-name or group cleanup.
  const output = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: launchSmokeEnvironment({ env: process.env, profileRoot: directory, timeoutMs: 30_000 }), stdio: ["ignore", "pipe", "pipe"],
    })
    let text = "", expired = false, force, teardown
    const clear = () => { clearTimeout(timer); clearTimeout(force); clearTimeout(teardown) }
    const timer = setTimeout(() => {
      expired = true
      child.kill()
      force = setTimeout(() => child.kill("SIGKILL"), 5_000)
      teardown = setTimeout(() => {
        removalSafe = false
        reject(new Error(`Fleet origin child did not exit; fixture retained at ${directory}`))
      }, 10_000)
    }, 30_000)
    child.stdout.on("data", (data) => { text = (text + data).slice(-16_384) })
    child.stderr.on("data", (data) => { text = (text + data).slice(-16_384) })
    child.once("error", (error) => { clear(); removalSafe = child.pid === undefined; reject(error) })
    child.once("close", (code) => {
      clear()
      if (expired) reject(new Error(`Fleet origin proof expired\n${text}`))
      else if (code === 0) resolve(text)
      else reject(new Error(`Fleet origin proof exited ${code}\n${text}`))
    })
  })
  assert.match(output, /DOMOVOI_FLEET_ORIGIN_PROOF_OK/u)
  process.stdout.write(output)
} finally { if (removalSafe) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
