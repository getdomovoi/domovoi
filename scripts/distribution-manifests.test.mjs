import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const version = "0.1.0-alpha.0"
const commit = "a".repeat(40)
const baseUrl = "https://updates.example.test/metadata/"
const targetBaseUrl = "https://updates.example.test/targets/"
const releaseBaseUrl = "https://github.com/getdomovoi/domovoi/releases/download"
const config = { schemaVersion: 1, releaseBaseUrl, cask: { token: "domovoi", name: "Domovoi",
  description: "Private workspace access", homepage: "https://domovoi.sh", packageName: "@getdomovoi/desktop",
  bundleId: "sh.domovoi.desktop", app: "Domovoi.app", architectures: {
    arm64: { platform: "darwin", arch: "arm64", format: "dmg" },
    x64: { platform: "darwin", arch: "x64", format: "dmg" },
  } } }

async function repository() {
  const { canonicalUpdateJson } = await import("../apps/daemon/dist/update-verification.js")
  const keys = Array.from({ length: 3 }, () => generateKeyPairSync("ed25519"))
  const keyids = keys.map((_, index) => String(index + 1).padStart(64, "0"))
  const envelope = (signed, indices = [2]) => ({ signed, signatures: indices.map((index) => ({ keyid: keyids[index],
    sig: sign(null, Buffer.from(canonicalUpdateJson(signed)), keys[index].privateKey).toString("hex") })) })
  const trustedRoot = envelope({ _type: "root", spec_version: "1.0.31", consistent_snapshot: true,
    version: 1, expires: "2099-01-01T00:00:00Z", keys: Object.fromEntries(keys.map((key, index) => [keyids[index],
      { keytype: "ed25519", scheme: "ed25519", keyval: { public: key.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") } }])),
    roles: { root: { keyids: keyids.slice(0, 2), threshold: 2 }, ...Object.fromEntries(["targets", "snapshot", "timestamp"].map((role) => [role, { keyids: [keyids[2]], threshold: 1 }])) },
  }, [0, 1])
  const payloads = new Map()
  const files = []
  const add = (name, kind, identity = {}) => {
    const bytes = Buffer.from(`synthetic ${name}`)
    payloads.set(name, bytes)
    files.push({ name, kind, length: bytes.length, sha256: hash(bytes), ...identity })
  }
  for (const name of ["protocol", "credential-store", "daemon", "cli"]) {
    add(`getdomovoi-${name}-${version}.tgz`, "npm", { packageName: `@getdomovoi/${name}` })
    add(`getdomovoi-${name}-${version}.sbom.json`, "sbom", { packageName: `@getdomovoi/${name}` })
  }
  add(`domovoi-web-${version}.tar.gz`, "web")
  add("SHA256SUMS", "checksums")
  add("reproducibility.json", "reproducibility")
  for (const arch of ["arm64", "x64"]) add(`domovoi-desktop-${version}-${arch}.dmg`, "desktop",
    { packageName: "@getdomovoi/desktop", platform: "darwin", arch, format: "dmg", bundleId: "sh.domovoi.desktop", app: "Domovoi.app" })
  const inventory = { schemaVersion: 2, version, channel: "beta", commit, gitTag: `v${version}`, files }
  const documents = new Map()
  const binding = (bytes, number) => ({ version: number, length: bytes.length, hashes: { sha256: hash(bytes) } })
  const publish = (number = 1) => {
    const bytes = Buffer.from(JSON.stringify(inventory))
    const common = { spec_version: "1.0.31", version: number, expires: "2099-01-01T00:00:00Z" }
    const target = { length: bytes.length, hashes: { sha256: hash(bytes) }, custom: {
      schemaVersion: 1, kind: "release-inventory", version, channel: "beta", sourceCommit: commit,
    } }
    const targets = Buffer.from(JSON.stringify(envelope({ ...common, _type: "targets", targets: { "release.json": target } })))
    const snapshot = Buffer.from(JSON.stringify(envelope({ ...common, _type: "snapshot", meta: { "targets.json": binding(targets, number) } })))
    const timestamp = Buffer.from(JSON.stringify(envelope({ ...common, _type: "timestamp", meta: { "snapshot.json": binding(snapshot, number) } })))
    documents.clear()
    documents.set(`${baseUrl}timestamp.json`, timestamp)
    documents.set(`${baseUrl}${number}.snapshot.json`, snapshot)
    documents.set(`${baseUrl}${number}.targets.json`, targets)
    documents.set(`${targetBaseUrl}${hash(bytes)}.release.json`, bytes)
  }
  publish()
  const requested = []
  let trusted = {}
  const verification = () => ({ baseUrl, targetBaseUrl, trustedRoot, trusted, version, channel: "beta", sourceCommit: commit,
    persist: async (next) => { trusted = next }, fetcher: async (url) => {
      requested.push(String(url))
      return documents.has(String(url)) ? new Response(documents.get(String(url))) : new Response(null, { status: 404 })
    } })
  return { inventory, documents, payloads, publish, requested, verification }
}

test("a cask uses both authenticated DMG identities and fixed release URLs", async () => {
  const repo = await repository()
  const { generateDistributionManifests } = await import("./distribution-manifests.mjs")
  const result = await generateDistributionManifests({ config, verification: repo.verification() })
  const cask = result.files["domovoi.rb"]
  assert.match(cask, /^cask 'domovoi' do\n/)
  assert.match(cask, /on_arm do/)
  assert.match(cask, /on_intel do/)
  for (const file of repo.inventory.files.filter((entry) => entry.kind === "desktop")) {
    assert.ok(cask.includes(`sha256 '${file.sha256}'`))
    assert.ok(cask.includes(`url '${releaseBaseUrl}/v${version}/${file.name}'`))
  }
  assert.match(cask, /app 'Domovoi.app'/)
  assert.match(cask, /depends_on :macos/)
  assert.equal(result.inventorySha256, hash(Buffer.from(JSON.stringify(repo.inventory))))
  assert.ok(repo.requested.some((url) => /[a-f0-9]{64}\.release\.json$/.test(url)))
})

test("manifest generation authenticates bytes and refuses unsigned substitution", async () => {
  const repo = await repository()
  const target = [...repo.documents.keys()].find((url) => url.endsWith(".release.json"))
  repo.documents.set(target, Buffer.from(JSON.stringify({ ...repo.inventory, commit: "b".repeat(40) })))
  const { generateDistributionManifests } = await import("./distribution-manifests.mjs")
  await assert.rejects(generateDistributionManifests({ config, verification: repo.verification() }))
})

test("signed but incomplete architecture inventory cannot generate a cask", async () => {
  const repo = await repository()
  repo.inventory.files = repo.inventory.files.filter((file) => file.arch !== "x64")
  repo.publish()
  const { generateDistributionManifests } = await import("./distribution-manifests.mjs")
  await assert.rejects(generateDistributionManifests({ config, verification: repo.verification() }), /architectur|DMG/i)
})

for (const [label, mutate] of [
  ["Ruby interpolation", (value) => { value.cask.name = '#{system("touch injected")}' }],
  ["newline", (value) => { value.cask.description = "safe\napp 'other'" }],
  ["identity override", (value) => { value.cask.app = "Other.app" }],
  ["duplicate architecture", (value) => { value.cask.architectures.x64.arch = "arm64" }],
  ["credential URL", (value) => { value.releaseBaseUrl = "https://user:password@example.test" }],
  ["unknown option", (value) => { value.verified = true }],
]) test(`manifest config refuses ${label}`, async () => {
  const repo = await repository()
  const input = structuredClone(config)
  mutate(input)
  const { generateDistributionManifests } = await import("./distribution-manifests.mjs")
  await assert.rejects(generateDistributionManifests({ config: input, verification: repo.verification() }), /config|identity|architectur|app|Ruby|URL/i)
})

test("persisted role floors reject replay on a second generation", async () => {
  const repo = await repository()
  const { generateDistributionManifests } = await import("./distribution-manifests.mjs")
  repo.publish(2)
  await generateDistributionManifests({ config, verification: repo.verification() })
  repo.publish(1)
  await assert.rejects(generateDistributionManifests({ config, verification: repo.verification() }), (error) => error.reason === "replay")
})

test("cask output is deterministic and caller callbacks cannot mutate validated config", async () => {
  const repo = await repository()
  const { generateDistributionManifests } = await import("./distribution-manifests.mjs")
  const first = await generateDistributionManifests({ config, verification: repo.verification() })
  const input = structuredClone(config)
  const verification = repo.verification()
  const persist = verification.persist
  verification.persist = async (documents) => {
    input.cask.name = "#{untrusted_ruby}"
    await persist(documents)
  }
  assert.deepEqual(await generateDistributionManifests({ config: input, verification }), first)
})

test("single quotes and backslashes remain literal cask data", async () => {
  const repo = await repository()
  const { generateDistributionManifests } = await import("./distribution-manifests.mjs")
  const input = structuredClone(config)
  input.cask.name = "Domovoi's \\ desktop"
  const result = await generateDistributionManifests({ config: input, verification: repo.verification() })
  assert.ok(result.files["domovoi.rb"].includes("name 'Domovoi\\'s \\\\ desktop'"))
})

test("signed bootstrap obtains its archive pin from the verified inventory", async (t) => {
  const repo = await repository()
  const destination = await mkdtemp(join(tmpdir(), "domovoi-signed-bootstrap-"))
  t.after(() => rm(destination, { recursive: true, force: true }))
  const file = repo.inventory.files.find((entry) => entry.kind === "npm" && entry.packageName === "@getdomovoi/daemon")
  const { bootstrapDaemonFromInventory } = await import("./bootstrap-daemon.mjs")
  const result = await bootstrapDaemonFromInventory({ verification: repo.verification(), baseUrl: releaseBaseUrl, destination,
    download: async function* (url) {
      if (url.endsWith("SHA256SUMS")) { yield Buffer.from(`${file.sha256}  ${file.name}\n`); return }
      const bytes = repo.payloads.get(file.name)
      for (let index = 0; index < bytes.length; index += 7) yield bytes.subarray(index, index + 7)
    } })
  assert.deepEqual(await readFile(result.path), repo.payloads.get(file.name))
  assert.equal(result.sha256, file.sha256)
  const forged = Buffer.alloc(file.length, 0)
  await assert.rejects(bootstrapDaemonFromInventory({ verification: repo.verification(), baseUrl: releaseBaseUrl, destination,
    expectedSha256: hash(forged), download: async (url) => url.endsWith("SHA256SUMS") ? Buffer.from(`${hash(forged)}  ${file.name}\n`) : forged }), /sha256|checksum|match/)
})

test("signed installation admits no npm command until inventory verification succeeds", async () => {
  const repo = await repository()
  const { installBootstrapDaemonFromInventory } = await import("./bootstrap-daemon.mjs")
  let commands = 0
  const options = { verification: repo.verification(), baseUrl: releaseBaseUrl,
    run: async () => { commands++; throw new Error("fixture installation boundary reached") } }
  await assert.rejects(installBootstrapDaemonFromInventory(options), /fixture installation boundary reached/)
  assert.equal(commands, 1)
  const target = [...repo.documents.keys()].find((url) => url.endsWith(".release.json"))
  repo.documents.set(target, Buffer.from("untrusted inventory"))
  await assert.rejects(installBootstrapDaemonFromInventory({ ...options, verification: repo.verification() }))
  assert.equal(commands, 1)
})

test("signed bootstrap refuses a declared length larger than the exact hash-matching archive", async (t) => {
  const repo = await repository()
  const destination = await mkdtemp(join(tmpdir(), "domovoi-signed-length-"))
  t.after(() => rm(destination, { recursive: true, force: true }))
  const file = repo.inventory.files.find((entry) => entry.kind === "npm" && entry.packageName === "@getdomovoi/daemon")
  file.length++
  repo.publish()
  const { bootstrapDaemonFromInventory } = await import("./bootstrap-daemon.mjs")
  await assert.rejects(bootstrapDaemonFromInventory({ verification: repo.verification(), baseUrl: releaseBaseUrl, destination,
    download: async (url) => url.endsWith("SHA256SUMS") ? Buffer.from(`${file.sha256}  ${file.name}\n`) : repo.payloads.get(file.name) }), /length/)
  await assert.rejects(readFile(join(destination, `v${version}`, file.name)), { code: "ENOENT" })
})
