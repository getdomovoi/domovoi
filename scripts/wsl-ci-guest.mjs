import { copyFile, cp, mkdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { bootstrapDeadline } from "./bootstrap-deadline.mjs"
import { runBootstrapCommand } from "./bootstrap-install.mjs"
import { validateRuntimeLock, verifyInstalledRuntime } from "./runtime-verification.mjs"

// Runs inside the disposable guest. Copy the exact built daemon and its
// same-release protocol, then use the supported integrity-bearing install
// graph. Never reuse Windows node_modules or resolve floating dependencies.
export async function prepareWslGuest(checkout, destination, timeoutMs = 300_000) {
  const deadline = bootstrapDeadline(timeoutMs, "WSL daemon fixture installation exceeded its deadline")
  try {
    const source = join(checkout, "apps/daemon")
    await deadline.run(() => mkdir(destination, { recursive: true, mode: 0o700 }))
    for (const directory of ["dist", "runtime"]) {
      await deadline.run(() => cp(join(source, directory), join(destination, directory), { recursive: true, errorOnExist: true, force: false }))
    }
    await deadline.run(() => copyFile(join(destination, "runtime/package.json"), join(destination, "package.json")))
    await deadline.run(() => copyFile(join(destination, "runtime/lock.json"), join(destination, "package-lock.json")))
    const manifest = JSON.parse(await deadline.run(() => readFile(join(destination, "package.json"), "utf8")))
    const lock = JSON.parse(await deadline.run(() => readFile(join(destination, "package-lock.json"), "utf8")))
    validateRuntimeLock(lock, manifest, manifest.version)
    const npm = join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")
    const options = { cwd: destination, deadline, env: { ...process.env,
      PATH: `${dirname(process.execPath)}:/usr/sbin:/usr/bin:/sbin:/bin` } }
    const location = ["--global=false", "--prefix", destination, "--no-audit", "--no-fund"]
    await runBootstrapCommand(process.execPath, [npm, "ci", ...location, "--ignore-scripts"], options)
    await verifyInstalledRuntime(destination, lock, deadline)
    await runBootstrapCommand(process.execPath, [npm, "rebuild", "node-pty", ...location,
      "--foreground-scripts", "--ignore-scripts=false"], options)
    const count = await verifyInstalledRuntime(destination, lock, deadline)
    if (!lock.packages["node_modules/node-pty"]) throw new Error("WSL fixture lost the production native runtime")
    process.stdout.write(`DOMOVOI_WSL_RUNTIME_OK: ${count} locked dependencies\n`)
  } finally { deadline.clear() }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [checkout, destination] = process.argv.slice(2)
  if (!checkout || !destination || process.platform !== "linux") throw new Error("WSL guest setup requires Linux, checkout and a private fixture directory")
  await prepareWslGuest(checkout, destination)
}
