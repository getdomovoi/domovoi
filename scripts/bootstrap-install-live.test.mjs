import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { installBootstrapDaemon, runBootstrapCommand } from "./bootstrap-install.mjs"
import { daemonRuntimeLock } from "./runtime-lock.mjs"

const execute = promisify(execFile)
const digest = (bytes, algorithm) => createHash(algorithm).update(bytes).digest(algorithm === "sha256" ? "hex" : "base64")
const sri = (bytes) => `sha512-${digest(bytes, "sha512")}`

test("identical archives install the reviewed transitive bytes after the registry changes", { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "domovoi-frozen-live-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const responses = new Map()
  const requests = []
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url)
    requests.push(path)
    const value = responses.get(path)
    if (!value) { response.writeHead(404).end(); return }
    response.setHeader("content-type", Buffer.isBuffer(value) ? "application/octet-stream" : "application/json")
    response.end(Buffer.isBuffer(value) ? value : JSON.stringify(value))
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture registry did not listen in 10000 ms")), 10_000)
    const fail = (error) => { clearTimeout(timer); reject(error) }
    server.once("error", fail)
    server.listen(0, "127.0.0.1", () => { clearTimeout(timer); server.off("error", fail); resolve() })
  })
  t.after(() => { server.closeAllConnections(); server.close() })
  const registry = `http://127.0.0.1:${server.address().port}`
  let packageNumber = 0
  async function pack(manifest, files = {}) {
    const directory = join(root, `source-${packageNumber++}`)
    await mkdir(join(directory, "package"), { recursive: true })
    await writeFile(join(directory, "package/package.json"), JSON.stringify(manifest))
    for (const [path, bytes] of Object.entries(files)) {
      const target = join(directory, "package", path)
      await mkdir(join(target, ".."), { recursive: true })
      await writeFile(target, bytes)
    }
    const archive = `${directory}.tgz`
    await execute("tar", ["-czf", archive, "-C", directory, "package"], { timeout: 10_000, killSignal: "SIGKILL" })
    const bytes = await readFile(archive)
    const path = `/${manifest.name}/-/${manifest.name.split("/").at(-1)}-${manifest.version}.tgz`
    responses.set(path, bytes)
    const document = responses.get(`/${manifest.name}`) ?? { name: manifest.name, "dist-tags": {}, versions: {} }
    document.versions[manifest.version] = { ...manifest, dist: { tarball: registry + path, integrity: sri(bytes) } }
    document["dist-tags"].latest = manifest.version
    responses.set(`/${manifest.name}`, document)
    return { archive, bytes, integrity: sri(bytes) }
  }
  const protocolManifest = { name: "@getdomovoi/protocol", version: "1.0.0", type: "module" }
  const protocol = await pack(protocolManifest)
  const leaf = await pack({ name: "domovoi-lock-leaf", version: "1.0.0" })
  const parent = await pack({ name: "domovoi-lock-parent", version: "1.0.0", dependencies: { "domovoi-lock-leaf": "^1.0.0" } })
  const native = await pack({ name: "node-pty", version: "1.0.0", scripts: { install: "node build.cjs" } }, {
    "build.cjs": 'require("node:fs").writeFileSync("built.txt", "reviewed build ran")\n',
  })
  const manifest = { name: "@getdomovoi/daemon", version: "1.0.0", type: "module",
    dependencies: { "@getdomovoi/protocol": "workspace:*", "domovoi-lock-parent": "^1.0.0", "node-pty": "1.0.0" } }
  const lock = daemonRuntimeLock({ manifest, protocolManifest, protocolIntegrity: protocol.integrity,
    lock: { lockfileVersion: "9.0", importers: {
      "apps/daemon": { dependencies: {
        "@getdomovoi/protocol": { specifier: "workspace:*", version: "link:../../packages/protocol" },
        "domovoi-lock-parent": { specifier: "^1.0.0", version: "1.0.0" },
        "node-pty": { specifier: "1.0.0", version: "1.0.0" },
      } }, "packages/protocol": {},
    }, packages: {
      "domovoi-lock-leaf@1.0.0": { resolution: { integrity: leaf.integrity } },
      "domovoi-lock-parent@1.0.0": { resolution: { integrity: parent.integrity } },
      "node-pty@1.0.0": { resolution: { integrity: native.integrity } },
    }, snapshots: {
      "domovoi-lock-leaf@1.0.0": {}, "domovoi-lock-parent@1.0.0": { dependencies: { "domovoi-lock-leaf": "1.0.0" } },
      "node-pty@1.0.0": {},
    } },
  })
  const app = await pack({ ...manifest, dependencies: { ...manifest.dependencies, "@getdomovoi/protocol": "1.0.0" } }, {
    "runtime/lock.json": JSON.stringify(lock), "runtime/package.json": JSON.stringify(lock.packages[""]),
    "runtime/protocol.tgz": protocol.bytes,
    "dist/index.js": 'import {createRequire} from "node:module"; const root=createRequire(import.meta.url); const parent=createRequire(root.resolve("domovoi-lock-parent/package.json")); console.log(parent("domovoi-lock-leaf/package.json").version)\n',
  })
  const sha256 = digest(app.bytes, "sha256")
  const npmCalls = []
  const run = async (command, args, options) => {
    if (args.includes("ci") || args.includes("rebuild")) {
      if (args.includes("ci")) npmCalls.push(args)
      // Only replace the registry for this real-process fixture. npm performs
      // resolution, fetching, SRI verification and extraction itself.
      const outcome = await runBootstrapCommand(command, [...args, "--registry", registry, "--fetch-retries=0"], options)
      if (args.includes("rebuild")) t.diagnostic(JSON.stringify(outcome))
      return outcome
    }
    return await runBootstrapCommand(command, args, options)
  }
  const install = (destination) => installBootstrapDaemon({
    version: "1.0.0", destination, baseUrl: "https://release.test", expectedSha256: sha256, timeoutMs: 45_000, run,
    download: async (url) => url.endsWith("SHA256SUMS") ? `${sha256}  getdomovoi-daemon-1.0.0.tgz\n` : app.bytes,
  })
  const first = await install(join(root, "first"))
  await pack({ name: "domovoi-lock-leaf", version: "1.1.0" })
  const second = await install(join(root, "second"))
  for (const result of [first, second]) {
    const outcome = await execute(process.execPath, [join(result.runtimePath, "dist/index.js")], { timeout: 10_000, killSignal: "SIGKILL" })
    assert.equal(outcome.stdout.trim(), "1.0.0")
    assert.equal(await readFile(join(result.runtimePath, "node_modules/node-pty/built.txt"), "utf8"), "reviewed build ran")
  }
  assert.equal(npmCalls.length, 2, "both installs must resolve in fresh private trees")
  assert.equal(requests.some((path) => path.includes("1.1.0.tgz")), false)
  assert.ok(requests.some((path) => path.includes("domovoi-lock-leaf-1.0.0.tgz")))

  // Exercise the shipped command, including HTTPS download, not just the
  // install function. EC certificate generation avoids expensive RSA setup.
  const key = join(root, "release-key.pem")
  const certificate = join(root, "release-cert.pem")
  await execute("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-keyout", key, "-out", certificate, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
  { timeout: 10_000, killSignal: "SIGKILL" })
  const releaseServer = createHttpsServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
    if (request.url === "/v1.0.0/SHA256SUMS") response.end(`${sha256}  getdomovoi-daemon-1.0.0.tgz\n`)
    else if (request.url === "/v1.0.0/getdomovoi-daemon-1.0.0.tgz") response.end(app.bytes)
    else response.writeHead(404).end()
  })
  releaseServer.requestTimeout = 10_000
  releaseServer.headersTimeout = 10_000
  t.after(() => { releaseServer.closeAllConnections(); releaseServer.close() })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("HTTPS fixture listen timed out")), 10_000)
    releaseServer.once("error", (error) => { clearTimeout(timer); reject(error) })
    releaseServer.listen(0, "127.0.0.1", () => { clearTimeout(timer); resolve() })
  })
  const cli = await execute(process.execPath, [fileURLToPath(new URL("./bootstrap-daemon.mjs", import.meta.url)),
    "1.0.0", `https://127.0.0.1:${releaseServer.address().port}`, join(root, "cli"), sha256], {
    timeout: 45_000, killSignal: "SIGKILL", env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate,
      npm_config_registry: registry, npm_config_global: "true", npm_config_prefix: join(root, "ambient-prefix"),
      NPM_CONFIG_CACHE: join(root, "ambient-cache") },
  })
  const cliResult = JSON.parse(cli.stdout)
  assert.equal(cliResult.sha256, sha256)
  assert.equal(typeof cliResult.runtimePath, "string", "the shipped command must install, not merely download")
  assert.equal(await readFile(join(cliResult.runtimePath, "node_modules/node-pty/built.txt"), "utf8"), "reviewed build ran")
  await assert.rejects(readFile(join(root, "ambient-prefix/package-lock.json")), { code: "ENOENT" })

  // Change the registry bytes under the same URL. A new install must reject on
  // SRI rather than publish a graph whose manifests happen to have the right versions.
  responses.set("/domovoi-lock-leaf/-/domovoi-lock-leaf-1.0.0.tgz", Buffer.from("replaced registry tarball"))
  const rejected = join(root, "replaced")
  await assert.rejects(install(rejected), /integrity|EINTEGRITY|TAR_BAD_ARCHIVE/i)
  await assert.rejects(readFile(join(rejected, "v1.0.0/runtime.json")), { code: "ENOENT" })
  t.diagnostic("Same archive twice: leaf 1.0.0 before and after registry 1.1.0. Real HTTPS bootstrap CLI: installed and built. Replaced locked bytes: refused, no runtime receipt.")
})
