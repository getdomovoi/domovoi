import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"

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

// pnpm-lock.yaml v9 as parsed: importers by workspace path, registry
// packages by name@version, and snapshots holding the edges.
function workspaceLockFixture() {
  const resolution = { integrity }
  return {
    lockfileVersion: "9.0",
    importers: {
      "apps/cli": { dependencies: {
        "@getdomovoi/credential-store": { specifier: "workspace:*", version: "link:../../packages/credential-store" },
        ws: { specifier: "^8.18.3", version: "8.18.3" },
      } },
      "packages/credential-store": { dependencies: {
        "@napi-rs/keyring": { specifier: "^2.0.0", version: "2.0.0" },
      } },
      "apps/daemon": { dependencies: { "not-in-cli": { specifier: "1.0.0", version: "1.0.0" } } },
    },
    packages: {
      "ws@8.18.3": { resolution },
      "@napi-rs/keyring@2.0.0": { resolution },
      "@napi-rs/keyring-darwin-arm64@2.0.0": { resolution, os: ["darwin"], cpu: ["arm64"] },
      "@napi-rs/keyring-linux-x64-gnu@2.0.0": { resolution, os: ["linux"], cpu: ["x64"] },
      "not-in-cli@1.0.0": { resolution },
    },
    snapshots: {
      "ws@8.18.3": {},
      "@napi-rs/keyring@2.0.0": { optionalDependencies: {
        "@napi-rs/keyring-darwin-arm64": "2.0.0", "@napi-rs/keyring-linux-x64-gnu": "2.0.0",
      } },
      "@napi-rs/keyring-darwin-arm64@2.0.0": {},
      "@napi-rs/keyring-linux-x64-gnu@2.0.0": {},
      "not-in-cli@1.0.0": {},
    },
  }
}
const credentialStoreArtifact = { "@getdomovoi/credential-store": { version: "1.0.0", integrity: `sha512-${Buffer.alloc(64, 3).toString("base64")}` } }

test("a package without a runtime lock takes its inventory from the pnpm lock, across platforms and workspace links", () => {
  assert.equal(typeof release.workspaceSbomComponents, "function", "CLI and credential store inventories come from pnpm-lock.yaml")
  const components = release.workspaceSbomComponents(workspaceLockFixture(), "apps/cli", {
    MIT: [{ name: "ws", versions: ["8.18.3"] }],
    "Apache-2.0": [{ name: "@getdomovoi/credential-store", versions: ["1.0.0"] }],
  }, credentialStoreArtifact)
  assert.deepEqual(components.map((c) => `${c.name}@${c.version}`), [
    "@getdomovoi/credential-store@1.0.0", "@napi-rs/keyring@2.0.0", "@napi-rs/keyring-darwin-arm64@2.0.0",
    "@napi-rs/keyring-linux-x64-gnu@2.0.0", "ws@8.18.3",
  ])
  assert.deepEqual(components[0].hashes, [{ alg: "SHA-512", content: "03".repeat(64) }])
  assert.deepEqual(components[0].licenses, [{ license: { id: "Apache-2.0" } }])
  assert.deepEqual(components[4].hashes, [{ alg: "SHA-512", content: "01".repeat(64) }])
  assert.deepEqual(components[4].licenses, [{ license: { id: "MIT" } }])
  assert.deepEqual(components[1].licenses, [])
})

test("a pnpm lock inventory refuses missing integrity, an unknown importer and an unreleased workspace link", () => {
  const mutations = [
    [(lock) => { delete lock.packages["ws@8.18.3"].resolution.integrity }, "apps/cli", credentialStoreArtifact],
    [(lock) => { delete lock.snapshots["ws@8.18.3"] }, "apps/cli", credentialStoreArtifact],
    [() => {}, "apps/missing", credentialStoreArtifact],
    [() => {}, "apps/cli", {}],
  ]
  for (const [mutate, importer, firstParty] of mutations) {
    const lock = workspaceLockFixture()
    mutate(lock)
    assert.throws(() => release.workspaceSbomComponents(lock, importer, {}, firstParty), /pnpm lock/)
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

// The ustar headers of a gzipped archive, read the way the format lays them
// out, so a test sees the modes and names tar would apply.
function tarHeaders(archive) {
  const tar = gunzipSync(archive)
  const headers = []
  for (let offset = 0; offset + 512 <= tar.length;) {
    const block = tar.subarray(offset, offset + 512)
    if (block.every((byte) => byte === 0)) break
    const text = (start, length) => block.subarray(start, start + length).toString("utf8").replace(/\0.*$/su, "")
    const octal = (start, length) => Number.parseInt(text(start, length).trim(), 8)
    const prefix = text(345, 155)
    const name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100)
    const size = octal(124, 12)
    headers.push({ name, mode: octal(100, 8), uid: octal(108, 8), gid: octal(116, 8), size, mtime: octal(136, 12), type: text(156, 1), magic: text(257, 6) })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return headers
}

test("packs the web app as a flat, reproducible tar.gz that tar unpacks with owner-only write", async (t) => {
  assert.equal(typeof release.webArchive, "function", "the web app archive is written by the release script")
  assert.equal(release.webArchiveName("1.2.3"), "domovoi-web-1.2.3.tar.gz")
  // Past ustar's 100-byte name field, so it is split into prefix and name.
  const folder = `assets/${"d".repeat(60)}`
  const long = `${folder}/${"a".repeat(60)}.js`
  const files = [
    { path: "index.html", bytes: Buffer.from("<!doctype html>") },
    { path: "assets/index-B0V_-a_P.js", bytes: Buffer.from("console.log(1)") },
    { path: long, bytes: Buffer.alloc(1300, 7) },
    { path: "domovoi-web.json", bytes: Buffer.from("{}\n") },
  ]
  const archive = release.webArchive(files)
  assert.deepEqual(release.webArchive([...files].reverse()), archive, "the same files give the same bytes in any order")
  assert.deepEqual(archive.subarray(0, 4), Buffer.from([0x1f, 0x8b, 8, 0]), "gzip with no name or comment")
  assert.equal(archive.readUInt32LE(4), 0, "no build time in the gzip header")
  const headers = tarHeaders(archive)
  assert.deepEqual(headers.map((header) => header.name), ["assets/", `${folder}/`, long, "assets/index-B0V_-a_P.js", "domovoi-web.json", "index.html"])
  for (const header of headers) {
    assert.equal(header.magic, "ustar")
    assert.equal(header.uid, 0)
    assert.equal(header.gid, 0)
    assert.equal(header.mtime, headers[0].mtime, "one fixed time for every entry")
    assert.equal(header.mode, header.type === "5" ? 0o755 : 0o644, `${header.name} is writable by its owner only`)
    assert.equal(header.type, header.name.endsWith("/") ? "5" : "0", `${header.name} is a plain file or folder, never a link`)
  }

  const directory = await mkdtemp(join(tmpdir(), "domovoi-web-archive-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, "web.tar.gz"), archive)
  await mkdir(join(directory, "web"))
  await promisify(execFile)("tar", ["-xzf", "web.tar.gz", "-C", "web"], { cwd: directory, timeout: 10_000, killSignal: "SIGKILL" })
  for (const { path, bytes } of files) assert.deepEqual(await readFile(join(directory, "web", ...path.split("/"))), bytes, path)
})

// A VITE_ variable in the release shell would be compiled into the app:
// VITE_DOMOVOI_RPC_URL would send every served page's socket to that address
// instead of the daemon that served it.
test("refuses to build the release web app with a VITE_ variable set", () => {
  assert.equal(typeof release.refuseWebBuildEnvironment, "function")
  assert.doesNotThrow(() => release.refuseWebBuildEnvironment({ PATH: "/usr/bin", DOMOVOI_WEB_DIR: "/srv/web" }))
  assert.throws(() => release.refuseWebBuildEnvironment({ VITE_DOMOVOI_RPC_URL: "ws://elsewhere/rpc" }), /VITE_DOMOVOI_RPC_URL/u)
})

test("refuses a web app path tar could not hold as written", () => {
  for (const path of ["../escape.js", "/root.js", "assets\\index.js", "a//b.js", "./index.html", "", `${"a".repeat(101)}.js`, `${"d".repeat(156)}/x.js`]) {
    assert.throws(() => release.webArchive([{ path, bytes: Buffer.from("x") }]), /web app path/u, JSON.stringify(path))
  }
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
  const sha512 = async (file) => createHash("sha512").update(await readFile(file)).digest("hex")
  const credentialStoreArchive = join(output, `getdomovoi-credential-store-${manifest.version}.tgz`)
  const cliArchive = join(output, `getdomovoi-cli-${manifest.version}.tgz`)
  for (const archiveFile of [credentialStoreArchive, cliArchive]) {
    const inventory = JSON.parse(await readFile(archiveFile.replace(/\.tgz$/, ".sbom.json"), "utf8"))
    validateCycloneDx(inventory)
    // Q3 B: the CLI depends on the daemon package for `domovoi daemon`, so
    // its inventory includes the daemon's graph; the credential store's not.
    const cli = archiveFile === cliArchive
    assert.equal(inventory.components.some((c) => c.name.includes("claude-agent-sdk")), cli,
      cli ? `${archiveFile} is described with the daemon graph it installs` : `${archiveFile} is not described by the daemon graph`)
    assert.ok(inventory.components.some((c) => c.name.startsWith("@napi-rs/keyring-")), `${archiveFile} lists keyring binaries for every platform`)
    assert.equal(inventory.metadata.properties.find((p) => p.name === "domovoi:sbom:pnpm-lock-sha256").value,
      createHash("sha256").update(await readFile(new URL("../pnpm-lock.yaml", import.meta.url))).digest("hex"))
  }
  const cliInventory = JSON.parse(await readFile(cliArchive.replace(/\.tgz$/, ".sbom.json"), "utf8"))
  for (const [name, archiveFile] of [["@getdomovoi/credential-store", credentialStoreArchive], ["@getdomovoi/protocol", protocolArchive], ["@getdomovoi/daemon", archive]]) {
    const component = cliInventory.components.find((c) => c.name === name)
    assert.deepEqual(component?.hashes, [{ alg: "SHA-512", content: await sha512(archiveFile) }], `the CLI inventory names the released ${name} bytes`)
    assert.deepEqual(component.licenses, [{ license: { id: "Apache-2.0" } }])
  }
  const checksums = await readFile(join(output, "SHA256SUMS"), "utf8")
  for (const line of checksums.trim().split("\n")) {
    const [digest, file] = line.split("  ")
    assert.equal(createHash("sha256").update(await readFile(join(output, file))).digest("hex"), digest)
  }

  // S3.2 slice 6: the web app tarball, listed in SHA256SUMS, unpacks to a
  // bundle whose manifest lists every file but itself and the notices, which
  // the daemon therefore never serves (it serves listed files only).
  const web = release.webArchiveName(manifest.version)
  assert.ok(checksums.split("\n").some((line) => line.endsWith(`  ${web}`)), `${web} has its line in SHA256SUMS`)
  const unpacked = join(directory, "web")
  await mkdir(unpacked)
  await promisify(execFile)("tar", ["-xzf", join(output, web), "-C", unpacked], { timeout: 30_000, killSignal: "SIGKILL" })
  const bundle = JSON.parse(await readFile(join(unpacked, "domovoi-web.json"), "utf8"))
  assert.equal(bundle.version, manifest.version, "the web app is built at the release version")
  const unpackedFiles = (await readdir(unpacked, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(unpacked.length + 1).split(/[\\/]/u).join("/"))
    .sort()
  assert.deepEqual(unpackedFiles, [...Object.keys(bundle.files), "THIRD_PARTY_NOTICES.txt", "domovoi-web.json"].sort())
  assert.equal(Object.hasOwn(bundle.files, "THIRD_PARTY_NOTICES.txt"), false, "the notices are not part of the served app")
  for (const [path, { sha256, bytes }] of Object.entries(bundle.files)) {
    const contents = await readFile(join(unpacked, ...path.split("/")))
    assert.equal(contents.byteLength, bytes, path)
    assert.equal(createHash("sha256").update(contents).digest("hex"), sha256, path)
  }
  const notices = await readFile(join(unpacked, "THIRD_PARTY_NOTICES.txt"), "utf8")
  assert.match(notices, /^Third-party software in the Domovoi web app$/mu)
  assert.match(notices, /^react-dom@/mu)
  // Each font's section carries the whole OFL, from its title to its last line.
  for (const font of ["instrument-sans", "jetbrains-mono"]) {
    const section = notices.split(/^={72}$/mu).find((text) => text.startsWith(`\n@fontsource-variable/${font}@`))
    assert.ok(section, `${font} has a notice`)
    assert.match(section, /^License: OFL-1\.1$/mu)
    assert.match(section, /SIL OPEN FONT LICENSE Version 1\.1 - 26 February 2007[\s\S]*OTHER DEALINGS IN THE\s+FONT SOFTWARE\./u)
  }
  t.diagnostic(`SBOM covers all ${expected.size} locked runtime components, including non-host packages and first-party protocol`)
})
