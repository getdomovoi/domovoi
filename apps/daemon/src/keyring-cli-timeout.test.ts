import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { expect, it } from "vitest"

import { OperationDeadline } from "./operation-deadline.js"
import { withinServiceDeadline } from "./service/deadline.js"

const budget = process.platform === "win32" ? 30_000 : 16_000

it("exits the real recovery CLI when native work will not acknowledge shutdown", async () => {
  const deadline = OperationDeadline.start(budget)
  const directory = await mkdtemp(join(tmpdir(), "domovoi-keyring-cli-"))
  let child: ReturnType<typeof spawn> | undefined
  let closed: Promise<unknown> | undefined
  try {
    await withinServiceDeadline(deadline, () => writeFile(join(directory, "block"), "hold"))
    deadline.throwIfExpired()
    // A piped stderr with undrained output models the readers this CLI meets
    // in practice. The diagnostic must survive the forced exit behind it.
    child = spawn(process.execPath, [
      "--import", new URL("../test-fixtures/blocked-keyring.mjs", import.meta.url).href,
      fileURLToPath(new URL("../dist/index.js", import.meta.url)), "fleet-keychain", "list",
    ], {
      env: {
        ...process.env, DOMOVOI_TEST_KEYRING_DIRECTORY: directory, DOMOVOI_TEST_KEYRING_UNSTOPPABLE: "1",
        DOMOVOI_TEST_KEYRING_STDERR_BACKLOG: String(1 << 20),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr!.on("data", (bytes: Buffer) => { stderr += bytes.toString() })
    child.stdout!.resume()
    // The exit event can precede the last stderr chunk; close follows both.
    closed = once(child, "close")
    expect(await withinServiceDeadline(deadline, () => closed!)).toEqual([1, null])
    expect(stderr).toContain("Native keyring worker exit could not be confirmed")
    expect(stderr).toContain("Stopping this CLI process")
  } finally {
    deadline.clear()
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    const cleanup = OperationDeadline.start(10_000)
    try {
      if (closed) await withinServiceDeadline(cleanup, () => closed!)
      await withinServiceDeadline(cleanup, () => rm(directory, { recursive: true, force: true }))
    } finally { cleanup.clear() }
  }
}, budget + 11_000)
