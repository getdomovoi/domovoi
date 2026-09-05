import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { bootstrapDeadline } from "./bootstrap-deadline.mjs"
import { inspectArchive, packPackage } from "./pack-package.mjs"
import { sha256File } from "./release-artifacts.mjs"

// Official Node 22 Alpine image, pinned independently of the mutable tag.
const image = "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32"
const execute = promisify(execFile)
const deadline = bootstrapDeadline(480_000, "Alpine bootstrap smoke exceeded 480000 ms")
const container = `domovoi-musl-${randomUUID()}`
let directory
try {
  directory = await deadline.run(() => mkdtemp(join(tmpdir(), "domovoi-musl-input-")))
  const packing = join(directory, "packing")
  await deadline.run(() => mkdir(packing))
  const archive = await packPackage("@getdomovoi/daemon", packing, { deadline })
  const { manifest } = await inspectArchive(archive, { deadline })
  await deadline.run(() => copyFile(archive, join(directory, "daemon.tgz")))
  await deadline.run(() => writeFile(join(directory, "input.json"), JSON.stringify({ version: manifest.version, sha256: sha256File(archive) })))
  // Mount only these public inputs read-only, never the checkout, host profile,
  // Docker socket or credentials. All installed files die with the container.
  for (const name of ["bootstrap-musl-smoke", "bootstrap-install", "bootstrap-download", "bootstrap-publication", "bootstrap-plan",
    "bootstrap-deadline", "runtime-lock", "runtime-verification"]) {
    await deadline.run(() => copyFile(new URL(`./${name}.mjs`, import.meta.url), join(directory, `${name}.mjs`)))
  }
  const outcome = await deadline.run(() => execute("docker", ["run", "--rm", "--init", "--name", container, "--platform", "linux/amd64",
    "--mount", `type=bind,src=${directory},dst=/input,readonly`, "--pids-limit", "256", "--memory", "1g", image,
    "sh", "-c", "apk add --no-cache python3 make g++ linux-headers git && node /input/bootstrap-musl-smoke.mjs"], {
    signal: deadline.signal, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
  }))
  process.stdout.write(outcome.stdout)
  process.stderr.write(outcome.stderr)
} finally {
  deadline.clear()
  // Docker can outlive a killed CLI. Cleanup names only this test's UUID and
  // has a separate, explicit ten-second bound, never a global prune.
  const cleanup = bootstrapDeadline(10_000, `Alpine smoke cleanup timed out for ${container} at ${directory}`)
  try {
    await cleanup.run(() => execute("docker", ["rm", "--force", container], { signal: cleanup.signal, killSignal: "SIGKILL" })).catch((error) => {
      if (!/No such container/.test(error.stderr ?? "")) process.stderr.write(`Container cleanup failed for ${container}: ${error.message}\n`)
    })
    if (directory) await cleanup.run(() => rm(directory, { recursive: true, force: true }))
  } finally { cleanup.clear() }
}
