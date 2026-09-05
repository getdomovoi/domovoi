import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"

import { afterEach, expect, it, vi } from "vitest"

import { MachineCredentialWorker, maximumPendingKeyringOperations } from "./machine-credential-worker.js"
import { OperationDeadline } from "./operation-deadline.js"

const machineId = `machine-${"a".repeat(32)}`
const credential = "k".repeat(43)
const deadlines: OperationDeadline[] = []
const clients: MachineCredentialWorker[] = []
const budget = (ms = 10_000) => { const value = OperationDeadline.start(ms); deadlines.push(value); return value }

class ControlledWorker extends EventEmitter {
  readonly sent: Array<{ id: number; request: unknown; cancelled: SharedArrayBuffer; expiresAt: bigint }> = []
  ref = vi.fn()
  unref = vi.fn()
  terminate = vi.fn(async () => 0)
  postMessage(message: typeof this.sent[number]) { this.sent.push(message) }
  reply(index: number, result?: unknown) { this.emit("message", { id: this.sent[index]!.id, ok: true, result }) }
}

function fixture() {
  const worker = new ControlledWorker()
  const create = vi.fn(() => worker as unknown as Worker)
  const client = new MachineCredentialWorker(create)
  clients.push(client)
  return { client, worker, create }
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close(budget())
  for (const value of deadlines.splice(0)) value.clear()
  vi.useRealTimers()
})

it("serializes whole writes including index maintenance", async () => {
  const { client, worker, create } = fixture()
  const first = client.save(machineId, credential, budget())
  const second = client.forget(machineId, budget())
  expect(worker.sent).toHaveLength(1)
  expect(worker.sent[0]!.request).toEqual({ kind: "save", machineId, credential })
  worker.reply(0)
  await first
  expect(worker.sent).toHaveLength(2)
  expect(worker.sent[1]!.request).toEqual({ kind: "forget", machineId })
  worker.reply(1)
  await second
  expect(create).toHaveBeenCalledOnce()
  expect(worker.unref).toHaveBeenCalledOnce()
})

it("keeps serialization after caller expiry until native completion is observed", async () => {
  vi.useFakeTimers()
  const { client, worker, create } = fixture()
  const first = expect(client.save(machineId, credential, budget(10))).rejects.toThrow("OS keychain is unavailable")
  const second = client.forget(machineId, budget(100))
  await vi.advanceTimersByTimeAsync(10)
  await first
  expect(worker.sent).toHaveLength(1)
  expect(Atomics.load(new Int32Array(worker.sent[0]!.cancelled), 0)).toBe(1)
  expect(create).toHaveBeenCalledOnce()
  worker.reply(0)
  expect(worker.sent).toHaveLength(2)
  worker.reply(1)
  await second
})

it("never sends queued work whose original deadline expired", async () => {
  vi.useFakeTimers()
  const { client, worker } = fixture()
  const active = client.machines(budget(100))
  const queued = expect(client.forget(machineId, budget(10))).rejects.toThrow("OS keychain is unavailable")
  await vi.advanceTimersByTimeAsync(10)
  await queued
  worker.reply(0, [])
  await active
  expect(worker.sent).toHaveLength(1)
})

it("bounds pending admission without spawning another native writer", async () => {
  const { client, worker, create } = fixture()
  const pending = Array.from({ length: maximumPendingKeyringOperations }, () => client.machines(budget()))
  const settled = Promise.allSettled(pending)
  await expect(client.machines(budget())).rejects.toThrow("OS keychain is unavailable")
  expect(worker.sent).toHaveLength(1)
  expect(create).toHaveBeenCalledOnce()
  await client.close(budget())
  expect((await settled).every((result) => result.status === "rejected")).toBe(true)
})

it("rejects every caller on worker failure without disclosing native error text or restarting", async () => {
  const { client, worker, create } = fixture()
  const active = expect(client.forMachine(machineId, budget())).rejects.toThrow("OS keychain is unavailable")
  const queued = expect(client.machines(budget())).rejects.toThrow("OS keychain is unavailable")
  worker.emit("error", new Error(credential))
  await active
  await queued
  await expect(client.machines(budget())).rejects.toThrow("OS keychain is unavailable")
  expect(create).toHaveBeenCalledOnce()
})

it("checks time at reply settlement even before the timer callback runs", async () => {
  let now = 0
  const parent = OperationDeadline.start(10, { now: () => now })
  deadlines.push(parent)
  const { client, worker } = fixture()
  const pending = expect(client.forMachine(machineId, parent)).rejects.toThrow("OS keychain is unavailable")
  now = 10
  worker.reply(0, credential)
  await pending
})

it("refuses malformed credential replies", async () => {
  const { client, worker } = fixture()
  const pending = expect(client.forMachine(machineId, budget())).rejects.toThrow("OS keychain is unavailable")
  worker.reply(0, "not a credential")
  await pending
})

it("bounds shutdown without claiming a stuck worker exited", async () => {
  vi.useFakeTimers()
  const { client, worker } = fixture()
  const pending = expect(client.machines(budget())).rejects.toThrow("OS keychain is unavailable")
  let exited = () => {}
  worker.terminate.mockImplementation(() => new Promise<number>((resolve) => { exited = () => resolve(0) }))
  const closing = expect(client.close(budget(10))).rejects.toThrow("OS keychain is unavailable")
  await vi.advanceTimersByTimeAsync(10)
  await closing
  await pending
  expect(worker.terminate).toHaveBeenCalledOnce()
  exited()
  await client.close(budget())
  expect(worker.terminate).toHaveBeenCalledOnce()
})
