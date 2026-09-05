import { randomUUID } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"

import { localOwnerRecordSchema, readLocalOwnerRecord, writeLocalOwnerRecord, type ReadyLocalOwner } from "./local-owner-record.js"
import { localOwnerRemovalReceiptPath, readLocalOwnerRemovalReceipt, retireRemovedLocalOwner, writeLocalOwnerRemovalReceipt, type LocalOwnerRemovalReceipt } from "./local-owner-removal.js"
import { claimProfile, type ProfileLease } from "./profile-lease.js"
import { OperationDeadline } from "./operation-deadline.js"

const resources: Array<{ home: string; lease: ProfileLease; deadline: OperationDeadline }> = []
afterEach(() => {
  for (const { home, lease, deadline } of resources.splice(0)) {
    lease.release()
    deadline.clear()
    rmSync(home, { recursive: true, force: true })
  }
})
function setup() {
  const home = mkdtempSync(join(tmpdir(), "domovoi-owner-receipt-"))
  const lease = claimProfile(home)
  const deadline = OperationDeadline.start(5_000)
  resources.push({ home, lease, deadline })
  const owner: ReadyLocalOwner = {
    version: 1, state: "ready", instanceId: randomUUID(), machineId: `machine-${"a".repeat(32)}`,
    protocolVersion: "0.4.0", owner: "daemon", credential: { source: "environment" },
    url: "ws://127.0.0.1:47831/rpc", serviceRegistrationId: randomUUID(),
  }
  writeLocalOwnerRecord(home, owner)
  const receipt: LocalOwnerRemovalReceipt = {
    version: 1, instanceId: owner.instanceId, machineId: owner.machineId, completedAt: "2026-09-05T12:00:00.000Z",
    authorization: { kind: "service-removal", registrationId: owner.serviceRegistrationId!, manager: "systemd" },
  }
  return { home, lease, owner, receipt, deadline }
}

it("keeps an owner-only receipt as evidence after retiring its exact owner", () => {
  const { home, lease, owner, receipt, deadline } = setup()
  expect(readLocalOwnerRemovalReceipt(home)).toBeUndefined()
  writeLocalOwnerRemovalReceipt(home, lease, receipt, deadline)
  expect(readLocalOwnerRemovalReceipt(home)).toEqual(receipt)
  if (process.platform !== "win32") expect(statSync(localOwnerRemovalReceiptPath(home)).mode & 0o777).toBe(0o600)
  expect(retireRemovedLocalOwner(home, lease, owner, deadline)).toBe(true)
  expect(readLocalOwnerRecord(home)).toEqual({ version: 1, state: "none" })
  expect(readLocalOwnerRemovalReceipt(home)).toEqual(receipt)
  expect(readdirSync(join(home, ".domovoi")).some((name) => name.endsWith(".partial"))).toBe(false)
})

it.each(["instance", "machine", "registration"])("refuses a receipt for a different %s without changing the owner", (field) => {
  const { home, lease, owner, receipt, deadline } = setup()
  if (field === "instance") receipt.instanceId = randomUUID()
  if (field === "machine") receipt.machineId = `machine-${"b".repeat(32)}`
  if (field === "registration" && receipt.authorization.kind === "service-removal") receipt.authorization.registrationId = randomUUID()
  writeLocalOwnerRemovalReceipt(home, lease, receipt, deadline)
  expect(retireRemovedLocalOwner(home, lease, owner, deadline)).toBe(false)
  expect(readLocalOwnerRecord(home)).toEqual(owner)
})

it("checks the current record, not a caller's stale pre-lease observation", () => {
  const { home, lease, owner, receipt, deadline } = setup()
  writeLocalOwnerRemovalReceipt(home, lease, receipt, deadline)
  const successor = { ...owner, instanceId: randomUUID() }
  writeLocalOwnerRecord(home, successor)
  expect(retireRemovedLocalOwner(home, lease, owner, deadline)).toBe(false)
  expect(readLocalOwnerRecord(home)).toEqual(successor)
})

it("requires a real held lease, not a released handle or a structural fake", () => {
  const { home, lease, owner, receipt, deadline } = setup()
  writeLocalOwnerRemovalReceipt(home, lease, receipt, deadline)
  lease.release()
  for (const invalid of [lease, { release: () => {} }]) {
    expect(() => writeLocalOwnerRemovalReceipt(home, invalid, receipt, deadline)).toThrow("held profile lease")
    expect(() => retireRemovedLocalOwner(home, invalid, owner, deadline)).toThrow("held profile lease")
  }
  expect(readLocalOwnerRecord(home)).toEqual(owner)
})

it.each(["private-corrupt-value", " ".repeat(4_097), JSON.stringify({ version: 2 })])("refuses invalid receipt bytes without echoing them", (text) => {
  const { home, lease, owner, deadline } = setup()
  writeFileSync(localOwnerRemovalReceiptPath(home), text, { mode: 0o600 })
  expect(() => retireRemovedLocalOwner(home, lease, owner, deadline)).toThrow(`receipt is invalid or inaccessible at ${localOwnerRemovalReceiptPath(home)}`)
  expect(readLocalOwnerRecord(home)).toEqual(owner)
})

it.runIf(process.platform !== "win32")("refuses a non-private receipt", () => {
  const { home, lease, owner, receipt, deadline } = setup()
  writeLocalOwnerRemovalReceipt(home, lease, receipt, deadline)
  chmodSync(localOwnerRemovalReceiptPath(home), 0o644)
  expect(() => retireRemovedLocalOwner(home, lease, owner, deadline)).toThrow("invalid or inaccessible")
  expect(readLocalOwnerRecord(home)).toEqual(owner)
})

it("leaves the prior receipt intact when validation refuses publication", () => {
  const { home, lease, receipt, deadline } = setup()
  writeLocalOwnerRemovalReceipt(home, lease, receipt, deadline)
  // Invalid input refuses before opening the publication file.
  expect(() => writeLocalOwnerRemovalReceipt(home, lease, { ...receipt, instanceId: "invalid" }, deadline)).toThrow()
  expect(JSON.parse(readFileSync(localOwnerRemovalReceiptPath(home), "utf8"))).toEqual(receipt)
})

it("does not let a Desktop owner carry service provenance", () => {
  const { owner } = setup()
  expect(localOwnerRecordSchema.safeParse({ ...owner, owner: "desktop" }).success).toBe(false)
})
