#!/usr/bin/env node
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { prepareDaemonRuntime } from "./daemon-runtime.mjs"

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const [platform = process.platform, arch = process.arch] = process.argv.slice(2)
try {
  await prepareDaemonRuntime({ platform, arch, desktopRoot })
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
