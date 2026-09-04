import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { checkPublishOrder, evaluatePublishOrder } from "./publish-order.mjs"
import { publishablePackages } from "./release-artifacts.mjs"

const protocol = { kind: "publish", name: "@getdomovoi/protocol", version: "0.1.0", tag: "latest", access: "public" }
const daemon = { kind: "publish", name: "@getdomovoi/daemon", version: "0.1.0", tag: "latest", access: "public" }

test("the daemon depends on the protocol, so the protocol publishes first", () => {
  assert.deepEqual(publishablePackages, ["@getdomovoi/protocol", "@getdomovoi/daemon"])
})

test("accepts the protocol in a chunk before the daemon", () => {
  assert.deepEqual(evaluatePublishOrder([[protocol], [daemon]]), [])
})

test("reports the daemon planned before the protocol", () => {
  assert.deepEqual(evaluatePublishOrder([[daemon], [protocol]]), [
    "@getdomovoi/protocol must publish in a chunk before @getdomovoi/daemon",
  ])
})

test("reports both packages in one chunk, which would publish them in parallel", () => {
  assert.deepEqual(evaluatePublishOrder([[protocol, daemon]]), [
    "@getdomovoi/protocol must publish in a chunk before @getdomovoi/daemon",
  ])
})

test("accepts a plan that publishes only the protocol", () => {
  assert.deepEqual(evaluatePublishOrder([[protocol]]), [])
})

test("ignores tag-only entries, which do not reach the registry", () => {
  const web = { kind: "tag-only", name: "@getdomovoi/web", version: "0.1.0" }
  assert.deepEqual(evaluatePublishOrder([[protocol], [daemon, web]]), [])
})

test("reports a package this repository does not publish", () => {
  const ui = { kind: "publish", name: "@getdomovoi/ui", version: "0.1.0", tag: "latest", access: "public" }
  assert.deepEqual(evaluatePublishOrder([[protocol], [ui]]), [
    "@getdomovoi/ui is not a package this repository publishes",
  ])
})

test("reports an empty plan instead of passing it", () => {
  assert.deepEqual(evaluatePublishOrder([]), ["publish plan is empty"])
  assert.deepEqual(evaluatePublishOrder(undefined), ["publish plan is empty"])
})

test("reads the plan file changeset publish-plan writes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-plan-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, "publish-plan.json")
  await writeFile(file, JSON.stringify({ version: 1, plan: [[protocol], [daemon]] }))

  assert.deepEqual(await checkPublishOrder(file), {
    published: ["@getdomovoi/protocol@0.1.0", "@getdomovoi/daemon@0.1.0"],
    failures: [],
  })
})

test("reports a plan file without a plan array", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-plan-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, "publish-plan.json")
  await writeFile(file, JSON.stringify({ version: 1 }))

  assert.deepEqual(await checkPublishOrder(file), { published: [], failures: ["publish plan is empty"] })
})
