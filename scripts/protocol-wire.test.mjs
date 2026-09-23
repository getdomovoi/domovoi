import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { currentWire, wireChangeRefusal, wireSchemaPath } from "./protocol-wire.mjs"

const base = {
  protocolVersion: "0.8.0",
  schemas: { "rpcMethods.system.hello.params": "sha256:a", workspaceSnapshotSchema: "sha256:b" },
}

test("accepts an unchanged wire at any version", () => {
  assert.equal(wireChangeRefusal(base, base), undefined)
  assert.equal(wireChangeRefusal(base, { ...base, protocolVersion: "0.8.1" }), undefined)
})

test("refuses a changed schema without a minor bump", () => {
  const changed = { ...base, schemas: { ...base.schemas, workspaceSnapshotSchema: "sha256:c" } }
  assert.match(wireChangeRefusal(base, changed), /workspaceSnapshotSchema/)
  assert.match(wireChangeRefusal(base, { ...changed, protocolVersion: "0.8.1" }), /0\.8\.0 to 0\.8\.1/)
})

test("refuses an added or removed schema without a minor bump", () => {
  const added = { ...base, schemas: { ...base.schemas, "rpcMethods.new.method.params": "sha256:d" } }
  assert.match(wireChangeRefusal(base, added), /rpcMethods\.new\.method\.params/)
  const { workspaceSnapshotSchema: _removed, ...rest } = base.schemas
  assert.match(wireChangeRefusal(base, { ...base, schemas: rest }), /workspaceSnapshotSchema/)
})

test("accepts a changed schema with a minor or major bump", () => {
  const changed = { ...base, schemas: { ...base.schemas, workspaceSnapshotSchema: "sha256:c" } }
  assert.equal(wireChangeRefusal(base, { ...changed, protocolVersion: "0.9.0" }), undefined)
  assert.equal(wireChangeRefusal(base, { ...changed, protocolVersion: "1.0.0" }), undefined)
})

test("refuses a version that moved backwards even with an unchanged wire", () => {
  assert.match(wireChangeRefusal(base, { ...base, protocolVersion: "0.7.0" }), /older/)
})

test("keeps the committed wire schema in step with the built protocol", async () => {
  const committed = JSON.parse(await readFile(new URL(`../${wireSchemaPath}`, import.meta.url), "utf8"))
  assert.deepEqual(committed, await currentWire())
})
