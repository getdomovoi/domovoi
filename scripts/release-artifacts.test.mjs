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

test("omits a license the package never declared", () => {
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
  t.diagnostic(`SBOM covers all ${expected.size} locked runtime components, including non-host packages and first-party protocol`)
})
