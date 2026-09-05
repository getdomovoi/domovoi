import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { buildReleaseArtifacts, checksumManifest, sbomComponents, sbomDocument } from "./release-artifacts.mjs"
import * as release from "./release-artifacts.mjs"

const protocolPath = "node_modules/@getdomovoi/protocol"
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`
function lockedFixture() {
  const entry = (version = "1.0.0") => ({ version, integrity, resolved: "https://registry.npmjs.org/test/-/test.tgz" })
  return {
    name: "@getdomovoi/daemon", version: "1.0.0", lockfileVersion: 3,
    packages: {
      "": { name: "@getdomovoi/daemon", version: "1.0.0", private: true, dependencies: { "@getdomovoi/protocol": "1.0.0", a: "1.0.0" } },
      [protocolPath]: { ...entry(), resolved: "file:runtime/protocol.tgz", dependencies: { leaf: "1.0.0" } },
      "node_modules/a": { ...entry(), dependencies: { leaf: "2.0.0" }, optionalDependencies: { "native-win": "1.0.0" } },
      "node_modules/leaf": entry(),
      "node_modules/a/node_modules/leaf": entry("2.0.0"),
      "node_modules/native-win": { ...entry(), optional: true, os: ["win32"], cpu: ["arm64"] },
    },
  }
}
function lockedComponents(lock, graph = {}, options) {
  assert.equal(typeof release.lockedSbomComponents, "function", "SBOM membership must come from the packed lock")
  return release.lockedSbomComponents(lock, graph, options)
}

test("locked inventory includes every platform and version, independent of host license membership", () => {
  const lock = lockedFixture()
  lock.packages["node_modules/a/node_modules/native-win"] = { ...lock.packages["node_modules/native-win"] }
  const components = lockedComponents(lock, { MIT: [
    { name: "leaf", versions: ["1.0.0"] }, { name: "dev-only", versions: ["1.0.0"] },
    { name: "native-win", versions: ["9.0.0"] },
  ] })
  assert.deepEqual(components.map((c) => `${c.name}@${c.version}`), [
    "@getdomovoi/protocol@1.0.0", "a@1.0.0", "leaf@1.0.0", "leaf@2.0.0", "native-win@1.0.0",
  ])
  assert.deepEqual(components[2].licenses, [{ license: { id: "MIT" } }])
  assert.deepEqual(components[3].licenses, [])
  assert.deepEqual(components[4].licenses, [])
  for (const component of components) assert.deepEqual(component.hashes, [{ alg: "SHA-512", content: "01".repeat(64) }])
})

test("protocol inventory follows only its locked closure and terminates on cycles", () => {
  const lock = lockedFixture()
  lock.packages["node_modules/leaf"].dependencies = { "@getdomovoi/protocol": "1.0.0" }
  assert.deepEqual(lockedComponents(lock, {}, { rootPath: protocolPath }).map((c) => c.name), ["leaf"])
  assert.throws(() => lockedComponents(lock, {}, { rootPath: "node_modules/missing" }), /missing.*root/i)
})

test("inventory refuses missing integrity, broken edges and conflicting bytes for one coordinate", () => {
  const mutations = [
    (lock) => { delete lock.packages["node_modules/leaf"].integrity },
    (lock) => { delete lock.packages["node_modules/leaf"] },
    (lock) => { lock.packages["node_modules/a/node_modules/duplicate/node_modules/leaf"] = {
      ...lock.packages["node_modules/leaf"], integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}`,
    } },
  ]
  for (const mutate of mutations) {
    const lock = lockedFixture()
    mutate(lock)
    assert.throws(() => lockedComponents(lock), /unlocked package|missing edge|conflicting integrity/)
  }
})

test("release refuses independently repacked protocol bytes even when name and version match", () => {
  assert.equal(typeof release.verifyProtocolArtifact, "function")
  const lock = lockedFixture()
  const manifest = { name: "@getdomovoi/protocol", version: "1.0.0" }
  assert.doesNotThrow(() => release.verifyProtocolArtifact(lock, manifest, integrity))
  assert.throws(() => release.verifyProtocolArtifact(lock, manifest, `sha512-${Buffer.alloc(64, 2).toString("base64")}`), /protocol.*bytes/i)
  assert.throws(() => release.verifyProtocolArtifact(lock, { ...manifest, version: "2.0.0" }, integrity), /protocol.*release/i)
})

test("conflicting exact-version license observations refuse instead of picking one", () => {
  assert.throws(() => lockedComponents(lockedFixture(), {
    MIT: [{ name: "leaf", versions: ["1.0.0"] }],
    ISC: [{ name: "leaf", versions: ["1.0.0"] }],
  }), /Conflicting license observations/)
})

test("writes checksums in the format sha256sum verifies", () => {
  assert.equal(
    checksumManifest([
      { file: "getdomovoi-protocol-0.0.1.tgz", sha256: "b".repeat(64) },
      { file: "getdomovoi-daemon-0.0.1.tgz", sha256: "a".repeat(64) },
    ]),
    `${"a".repeat(64)}  getdomovoi-daemon-0.0.1.tgz\n${"b".repeat(64)}  getdomovoi-protocol-0.0.1.tgz\n`,
  )
})

test("describes each dependency as a component with a package URL", () => {
  assert.deepEqual(sbomComponents({
    "MIT": [{ name: "ws", versions: ["8.18.3"] }],
  }), [
    {
      type: "library",
      name: "ws",
      version: "8.18.3",
      purl: "pkg:npm/ws@8.18.3",
      licenses: [{ license: { id: "MIT" } }],
    },
  ])
})

test("encodes the scope separator in a package URL", () => {
  assert.deepEqual(sbomComponents({
    "Apache-2.0": [{ name: "@agentclientprotocol/sdk", versions: ["1.4.0"] }],
  })[0].purl, "pkg:npm/%40agentclientprotocol/sdk@1.4.0")
})

test("records an SPDX expression as an expression, not an identifier", () => {
  assert.deepEqual(sbomComponents({
    "(MIT OR Apache-2.0)": [{ name: "dual", versions: ["1.0.0"] }],
  })[0].licenses, [{ expression: "(MIT OR Apache-2.0)" }])
})

test("records a WITH exception clause as an expression", () => {
  assert.deepEqual(sbomComponents({
    "GPL-2.0-only WITH Classpath-exception-2.0": [{ name: "exception-carrying", versions: ["1.0.0"] }],
  })[0].licenses, [{ expression: "GPL-2.0-only WITH Classpath-exception-2.0" }])
})

test("leaves a license observation marked unknown empty", () => {
  assert.deepEqual(sbomComponents({
    "Unknown": [{ name: "mystery", versions: ["1.0.0"] }],
  })[0].licenses, [])
})

test("lists every installed version of one package separately", () => {
  assert.deepEqual(
    sbomComponents({ "MIT": [{ name: "tslib", versions: ["2.6.0", "1.14.1"] }] }).map((c) => c.version),
    ["1.14.1", "2.6.0"],
  )
})

test("builds a CycloneDX document describing the packed artifact", () => {
  const document = sbomDocument({
    name: "@getdomovoi/protocol",
    version: "0.0.1",
    file: "getdomovoi-protocol-0.0.1.tgz",
    sha256: "c".repeat(64),
    components: [],
  })

  assert.equal(document.bomFormat, "CycloneDX")
  assert.equal(document.specVersion, "1.6")
  assert.deepEqual(document.metadata.component, {
    type: "library",
    name: "@getdomovoi/protocol",
    version: "0.0.1",
    purl: "pkg:npm/%40getdomovoi/protocol@0.0.1",
    hashes: [{ alg: "SHA-256", content: "c".repeat(64) }],
  })
  assert.deepEqual(document.components, [])
})

test("offline CycloneDX 1.6 validation rejects malformed release documents", async () => {
  const { validateCycloneDx } = await import("./cyclonedx-validation.mjs").catch(() => ({}))
  assert.equal(typeof validateCycloneDx, "function", "release metadata needs pinned offline schema validation")
  const document = sbomDocument({ name: "@getdomovoi/daemon", version: "1.0.0", sha256: "a".repeat(64),
    components: lockedComponents(lockedFixture()), lockSha256: "b".repeat(64) })
  assert.doesNotThrow(() => validateCycloneDx(document))
  for (const mutate of [
    (doc) => { doc.specVersion = "1.5" },
    (doc) => { doc.components[0].hashes[0].content = "not a hash" },
    (doc) => { doc.components[0].licenses = [{ license: { id: "invented-license" } }] },
    (doc) => { doc.components[0].type = "invented-type" },
    (doc) => { doc.extra = true },
  ]) {
    const invalid = structuredClone(document)
    mutate(invalid)
    assert.throws(() => validateCycloneDx(invalid), /CycloneDX 1.6/)
  }
})

test("the real release SBOM covers every packed runtime coordinate, not just this host", { timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-sbom-release-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const output = join(directory, "release")
  await buildReleaseArtifacts(fileURLToPath(new URL("../", import.meta.url)), output, { timeoutMs: 150_000 })
  const manifest = JSON.parse(await readFile(new URL("../apps/daemon/package.json", import.meta.url), "utf8"))
  const archive = join(output, `getdomovoi-daemon-${manifest.version}.tgz`)
  const { stdout } = await promisify(execFile)("tar", ["-xOf", archive, "package/runtime/lock.json"], {
    timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
  })
  const lock = JSON.parse(stdout)
  const expected = new Map(Object.entries(lock.packages).filter(([path]) => path).map(([path, entry]) => [
    `${path.split("node_modules/").at(-1)}@${entry.version}`, entry,
  ]))
  const document = JSON.parse(await readFile(archive.replace(/\.tgz$/, ".sbom.json"), "utf8"))
  const actual = new Map(document.components.map((component) => [`${component.name}@${component.version}`, component]))
  const missing = [...expected.keys()].filter((key) => !actual.has(key))
  assert.equal(missing.length, 0, `SBOM omitted ${missing.length} packed runtime components: ${missing.join(", ")}`)
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort())
  for (const [key, entry] of expected) {
    assert.deepEqual(actual.get(key).hashes, [{ alg: "SHA-512", content: Buffer.from(entry.integrity.slice(7), "base64").toString("hex") }])
  }
  assert.equal(document.metadata.component.hashes[0].content,
    createHash("sha256").update(await readFile(archive)).digest("hex"))
  assert.equal(document.metadata.properties.find((p) => p.name === "domovoi:sbom:runtime-lock-sha256").value,
    createHash("sha256").update(stdout).digest("hex"))
  assert.deepEqual(actual.get(`@getdomovoi/protocol@${manifest.version}`).licenses, [{ license: { id: "Apache-2.0" } }])
  const protocolArchive = join(output, `getdomovoi-protocol-${manifest.version}.tgz`)
  assert.equal(`sha512-${createHash("sha512").update(await readFile(protocolArchive)).digest("base64")}`, lock.packages[protocolPath].integrity)
  const protocolDocument = JSON.parse(await readFile(protocolArchive.replace(/\.tgz$/, ".sbom.json"), "utf8"))
  assert.equal(protocolDocument.components.some((c) => c.name === "@getdomovoi/protocol"), false)
  assert.equal(protocolDocument.components.some((c) => c.name.includes("claude-agent-sdk")), false)
  const { validateCycloneDx } = await import("./cyclonedx-validation.mjs")
  validateCycloneDx(document)
  validateCycloneDx(protocolDocument)
  const checksums = await readFile(join(output, "SHA256SUMS"), "utf8")
  for (const line of checksums.trim().split("\n")) {
    const [digest, file] = line.split("  ")
    assert.equal(createHash("sha256").update(await readFile(join(output, file))).digest("hex"), digest)
  }
  t.diagnostic(`SBOM covers all ${expected.size} locked runtime components, including non-host packages and first-party protocol`)
})
