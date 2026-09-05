import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { bootstrapDeadline } from "./bootstrap-deadline.mjs"
import { inspectArchive, packPackage } from "./pack-package.mjs"
import { daemonRuntimeLock } from "./runtime-lock.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const require = createRequire(new URL("../apps/daemon/package.json", import.meta.url))
const { parse } = require("yaml")

export async function prepareDaemonRuntime() {
  const deadline = bootstrapDeadline(300_000, "Daemon runtime packaging exceeded 300000 ms")
  let staging
  try {
    const json = async (path) => JSON.parse(await deadline.run(() => readFile(join(root, path), "utf8")))
    const manifest = await json("apps/daemon/package.json")
    const protocolManifest = await json("packages/protocol/package.json")
    const lock = parse(await deadline.run(() => readFile(join(root, "pnpm-lock.yaml"), "utf8")))
    await deadline.run(async () => { staging = await mkdtemp(join(tmpdir(), "domovoi-runtime-pack-")) })
    const archive = await packPackage("@getdomovoi/protocol", staging, { deadline })
    const packed = await inspectArchive(archive, { deadline })
    if (packed.manifest.name !== protocolManifest.name || packed.manifest.version !== manifest.version) {
      throw new Error("The packed protocol does not match this daemon release")
    }
    const bytes = await deadline.run(() => readFile(archive))
    const protocolIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
    const runtimeLock = daemonRuntimeLock({ manifest, protocolManifest, protocolIntegrity, lock })
    const directory = join(root, "apps/daemon/runtime")
    await deadline.run(() => mkdir(directory, { recursive: true }))
    await deadline.run(() => copyFile(archive, join(directory, "protocol.tgz")))
    await deadline.run(() => writeFile(join(directory, "package.json"), `${JSON.stringify(runtimeLock.packages[""], null, 2)}\n`))
    await deadline.run(() => writeFile(join(directory, "lock.json"), `${JSON.stringify(runtimeLock, null, 2)}\n`))
  } finally {
    try {
      if (staging) await deadline.run(() => rm(staging, { recursive: true, force: true }))
    } finally { deadline.clear() }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareDaemonRuntime()
}
