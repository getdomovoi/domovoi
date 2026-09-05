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
  let exited: Promise<unknown> | undefined
  try {
    await withinServiceDeadline(deadline, () => writeFile(join(directory, "block"), "hold"))
    deadline.throwIfExpired()
    child = spawn(process.execPath, [
      "--import", new URL("../test-fixtures/blocked-keyring.mjs", import.meta.url).href,
      fileURLToPath(new URL("../dist/index.js", import.meta.url)), "fleet-keychain", "list",
    ], {
      env: { ...process.env, DOMOVOI_TEST_KEYRING_DIRECTORY: directory, DOMOVOI_TEST_KEYRING_UNSTOPPABLE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr!.on("data", (bytes: Buffer) => { stderr += bytes.toString() })
    child.stdout!.resume()
    exited = once(child, "exit")
    expect(await withinServiceDeadline(deadline, () => exited!)).toEqual([1, null])
    expect(stderr).toContain("Native keyring worker exit could not be confirmed")
    expect(stderr).toContain("Stopping this CLI process")
  } finally {
    deadline.clear()
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    const cleanup = OperationDeadline.start(10_000)
    try {
      if (exited) await withinServiceDeadline(cleanup, () => exited!)
      await withinServiceDeadline(cleanup, () => rm(directory, { recursive: true, force: true }))
    } finally { cleanup.clear() }
  }
}, budget + 11_000)
