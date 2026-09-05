import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worker } from "node:worker_threads"

import { expect, it } from "vitest"

import { MachineCredentialWorker } from "./machine-credential-worker.js"
import { machineCredentialDigest } from "./machine-credentials.js"
import { OperationDeadline } from "./operation-deadline.js"
import { withinServiceDeadline } from "./service/deadline.js"
import { waitForDaemon } from "./test-wait-for.js"

const budget = process.platform === "win32" ? 20_000 : 10_000
const machineId = `machine-${"a".repeat(32)}`
const credential = "k".repeat(43)

async function fixture(run: (input: { client: MachineCredentialWorker; directory: string; deadline: OperationDeadline }) => Promise<void>) {
  const deadline = OperationDeadline.start(budget)
  const directory = await mkdtemp(join(tmpdir(), "domovoi-keyring-worker-"))
  const client = new MachineCredentialWorker(() => new Worker(new URL("../dist/machine-keyring-worker.js", import.meta.url), {
    env: { ...process.env, DOMOVOI_TEST_KEYRING_DIRECTORY: directory },
    execArgv: ["--import", new URL("../test-fixtures/blocked-keyring.mjs", import.meta.url).href],
  }))
  try { await withinServiceDeadline(deadline, () => run({ client, directory, deadline })) }
  finally {
    deadline.clear()
    const cleanup = OperationDeadline.start(10_000)
    try {
      // Release only our synthetic native hold, then observe worker exit
      // before removing its isolated files.
      await withinServiceDeadline(cleanup, () => rm(join(directory, "block"), { force: true }))
      await client.close(cleanup)
      await withinServiceDeadline(cleanup, () => rm(directory, { recursive: true, force: true }))
    } finally { cleanup.clear() }
  }
}

it("runs the packaged credential and index operations off the main thread", async () => {
  await fixture(async ({ client, directory, deadline }) => {
    await client.save(machineId, credential, deadline)
    expect(await client.machines(deadline)).toEqual([machineId])
    expect(await client.forMachine(machineId, deadline)).toBe(credential)
    const digest = machineCredentialDigest(machineId, credential)
    expect(await client.repairIndex(machineId, digest, deadline)).toBe(true)
    expect(await client.forgetIfMatching(machineId, machineCredentialDigest(machineId, "z".repeat(43)), deadline)).toBe(false)
    expect(await client.forgetIfMatching(machineId, digest, deadline)).toBe(true)
    expect(await client.forMachine(machineId, deadline)).toBeUndefined()
    expect(await client.machines(deadline)).toEqual([])
    const events = (await readFile(join(directory, "events"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { isMainThread: boolean })
    expect(events.length).toBeGreaterThan(5)
    expect(events.every((event) => event.isMainThread === false)).toBe(true)
  })
}, budget + 11_000)

it("cancels before the next native step without overtaking a held constructor", async () => {
  await fixture(async ({ client, directory, deadline }) => {
    await client.machines(deadline) // Worker is ready before injecting the hold.
    await writeFile(join(directory, "block"), "hold")
    const controller = new AbortController()
    const operation = OperationDeadline.start(budget, { signal: controller.signal })
    try {
      const writing = expect(client.save(machineId, credential, operation)).rejects.toThrow("keychain is unavailable")
      await withinServiceDeadline(deadline, () => waitForDaemon(() => stat(join(directory, "entered"))))
      controller.abort()
      await writing
      // This read must remain behind the native constructor even though its
      // caller has already been refused. No second worker may overtake it.
      const following = client.machines(deadline)
      await rm(join(directory, "block"))
      expect(await following).toEqual([])
      expect(await client.forMachine(machineId, deadline)).toBeUndefined()
      const events = (await readFile(join(directory, "events"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { kind: string })
      expect(events.some((event) => event.kind === "set")).toBe(false)
    } finally { operation.clear() }
  })
}, budget + 11_000)
