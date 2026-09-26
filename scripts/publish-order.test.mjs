import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { checkPublishOrder, evaluatePublishOrder } from "./publish-order.mjs"
import { publishDependencies, publishablePackages } from "./release-artifacts.mjs"
import { collectWorkspacePackages } from "./version-lockstep.mjs"

const protocol = { kind: "publish", name: "@getdomovoi/protocol", version: "0.1.0", tag: "latest", access: "public" }
const daemon = { kind: "publish", name: "@getdomovoi/daemon", version: "0.1.0", tag: "latest", access: "public" }
const credentialStore = { kind: "publish", name: "@getdomovoi/credential-store", version: "0.1.0", tag: "latest", access: "public" }
const cli = { kind: "publish", name: "@getdomovoi/cli", version: "0.1.0", tag: "latest", access: "public" }

test("the daemon depends on the protocol, so the protocol publishes first", () => {
  assert.deepEqual(publishDependencies["@getdomovoi/daemon"], ["@getdomovoi/protocol"])
  assert.ok(publishablePackages.indexOf("@getdomovoi/protocol") < publishablePackages.indexOf("@getdomovoi/daemon"))
})

// Changesets publishes every workspace package that is not private, so the
// release set is read from the manifests rather than trusted from a list.
test("publishes every public workspace package, after the workspace packages it needs at runtime", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const { packages, failures } = await collectWorkspacePackages(root)
  assert.deepEqual(failures, [])
  const manifests = await Promise.all(packages.map(async ({ path }) => JSON.parse(await readFile(join(root, path), "utf8"))))
  const workspace = new Set(manifests.map((manifest) => manifest.name))
  const expected = Object.fromEntries(manifests.filter((manifest) => !manifest.private).map((manifest) => [
    manifest.name,
    ["dependencies", "optionalDependencies", "peerDependencies"]
      .flatMap((field) => Object.keys(manifest[field] ?? {}))
      .filter((name) => workspace.has(name))
      .sort(),
  ]))
  assert.deepEqual([...publishablePackages].sort(), Object.keys(expected).sort())
  for (const manifest of manifests.filter((entry) => !entry.private)) {
    assert.deepEqual(manifest.publishConfig, { access: "public", provenance: true }, `${manifest.name} publishes publicly with provenance`)
  }
  for (const name of publishablePackages) {
    assert.deepEqual([...(publishDependencies[name] ?? [])].sort(), expected[name], `${name} runtime workspace dependencies`)
    for (const dependency of expected[name]) {
      assert.ok(publishablePackages.indexOf(dependency) < publishablePackages.indexOf(name), `${dependency} is listed before ${name}`)
    }
  }
})

test("accepts the chunks Changesets plans for independent packages", () => {
  assert.deepEqual(evaluatePublishOrder([[protocol, credentialStore], [daemon, cli]]), [])
})

test("reports the CLI in the same chunk as the credential store it depends on", () => {
  assert.deepEqual(evaluatePublishOrder([[protocol], [credentialStore, daemon, cli]]), [
    "@getdomovoi/credential-store must publish in a chunk before @getdomovoi/cli",
  ])
})

test("accepts a retry that publishes only the CLI", () => {
  assert.deepEqual(evaluatePublishOrder([[cli]]), [])
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
