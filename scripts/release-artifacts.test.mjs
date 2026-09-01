import assert from "node:assert/strict"
import test from "node:test"

import { checksumManifest, sbomComponents, sbomDocument } from "./release-artifacts.mjs"

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
