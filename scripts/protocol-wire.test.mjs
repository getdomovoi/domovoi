import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  checksOf, errorDataSchemas, fingerprintOf, notificationSchemas, releaseBaseline, wireChangeRefusal, wireOf, wireReleasesPath,
} from "./protocol-wire.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const z = createRequire(join(root, "packages/protocol/package.json"))("zod")
const protocol = await import(pathToFileURL(join(root, "packages/protocol/dist/index.js")).href)

const release = {
  protocolVersion: "0.8.0",
  schemas: { "rpc.system.hello.params": "sha256:a", "notification.workspace.changed": "sha256:b" },
}
const changed = { ...release, schemas: { ...release.schemas, "notification.workspace.changed": "sha256:c" } }

test("measures a build against the highest release at or below its version", () => {
  assert.equal(releaseBaseline(["0.7.0", "0.8.0", "0.10.0"], "0.9.0"), "0.8.0")
  assert.equal(releaseBaseline(["0.7.0", "0.8.0"], "0.8.0"), "0.8.0")
  assert.equal(releaseBaseline(["0.7.0", "0.8.0"], "0.8.3"), "0.8.0")
  assert.equal(releaseBaseline(["0.8.0"], "0.7.4"), undefined)
  assert.equal(releaseBaseline([], "0.8.0"), undefined)
})

test("refuses a wire change at the released version, including a patch", () => {
  assert.equal(wireChangeRefusal(release, release), undefined)
  assert.match(wireChangeRefusal(release, changed), /notification\.workspace\.changed/)
  assert.match(wireChangeRefusal(release, { ...changed, protocolVersion: "0.8.1" }), /still 0\.8\.1/)
  const added = { ...release, schemas: { ...release.schemas, "rpc.new.method.params": "sha256:d" } }
  assert.match(wireChangeRefusal(release, added), /rpc\.new\.method\.params/)
})

test("lets every change after a release share one minor bump", () => {
  assert.equal(wireChangeRefusal(release, { ...changed, protocolVersion: "0.9.0" }), undefined)
  assert.equal(wireChangeRefusal(release, { ...changed, protocolVersion: "1.0.0" }), undefined)
})

test("records a tightened custom check that JSON Schema cannot see", () => {
  const document = (schema) => JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }))
  const wide = z.string().check(protocol.utf16MaxLength(128))
  const narrow = z.string().check(protocol.utf16MaxLength(8))
  assert.equal(document(wide), document(narrow))
  assert.notDeepEqual(checksOf(wide), checksOf(narrow))
  assert.notDeepEqual(
    checksOf(z.object({ id: z.string().check(protocol.utf16Length(8)) })),
    checksOf(z.object({ id: z.string().check(protocol.utf16Length(9)) })),
  )
  assert.notDeepEqual(
    checksOf(z.string().refine((value) => value.startsWith("a"))),
    checksOf(z.string().refine((value) => value.startsWith("b"))),
  )
})

// A custom check's function can capture a bound the digest cannot see, so an
// unannotated one is refused rather than recorded as if it were understood.
const closureBound = {
  check: (maximum) => z.string().check(z.check(({ value, issues }) => {
    if (value.length > maximum) issues.push({ code: "custom", input: value, message: "too long" })
  })),
  superRefine: (maximum) => z.string().superRefine((value, context) => {
    if (value.length > maximum) context.addIssue({ code: "custom", message: "too long" })
  }),
  refine: (maximum) => z.string().refine((value) => value.length <= maximum),
}

const strict = { requireSemantics: true }

for (const [kind, build] of Object.entries(closureBound)) {
  test(`cannot see a closure bound of an unannotated custom ${kind}`, () => {
    assert.equal(fingerprintOf(z, build(8)), fingerprintOf(z, build(4)))
  })

  test(`refuses an unannotated custom ${kind} when semantics are required`, () => {
    assert.throws(() => fingerprintOf(z, build(8), strict), /declares no wire semantics/)
  })

  test(`records the declared bound of an annotated custom ${kind}`, () => {
    const annotated = (maximum) => protocol.wireRule(build(maximum), { rule: `closure-${kind}`, maximum })
    assert.equal(fingerprintOf(z, annotated(8), strict), fingerprintOf(z, annotated(8), strict))
    assert.notEqual(fingerprintOf(z, annotated(8), strict), fingerprintOf(z, annotated(4), strict))
  })
}

test("leaves documentation out of the digest", () => {
  const plain = z.object({ id: z.string() })
  const described = z.object({ id: z.string().describe("The session id") }).describe("A session reference")
  assert.equal(fingerprintOf(z, plain), fingerprintOf(z, described))
})

test("records the wire only: RPC params and results, notifications and error data", async () => {
  const wire = await wireOf()
  const names = Object.keys(wire.schemas)
  const outside = names.filter((name) => !/^(rpc|notification|errorData)\./.test(name))
  assert.deepEqual(outside, [])
  assert.equal(names.filter((name) => name.startsWith("rpc.")).length, Object.keys(protocol.rpcMethods).length * 2)
  assert.ok(!names.some((name) => /machineCredentialSchema|transferStepSchema/.test(name)))
  for (const name of [...Object.values(notificationSchemas), ...errorDataSchemas]) {
    assert.ok(name in protocol, `${name} is not exported by the protocol package`)
  }
})

test("names every notification the daemon broadcasts", () => {
  const server = readFileSync(join(root, "apps/daemon/src/server.ts"), "utf8")
  const sent = new Set([...server.matchAll(/#broadcastNotification\(\s*"([^"]+)"/g)].map((match) => match[1]))
  assert.deepEqual([...sent].sort(), Object.keys(notificationSchemas).sort())
})

test("keeps the current build within its release rule", async () => {
  const versions = readdirSync(join(root, wireReleasesPath))
    .map((name) => /^(\d+\.\d+\.\d+)\.json$/.exec(name)?.[1]).filter(Boolean)
  const current = await wireOf()
  const baseline = releaseBaseline(versions, current.protocolVersion)
  assert.ok(baseline, "no release record at or below the current protocol version")
  const recorded = JSON.parse(readFileSync(join(root, wireReleasesPath, `${baseline}.json`), "utf8"))
  assert.equal(wireChangeRefusal(recorded, current), undefined)
})
