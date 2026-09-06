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

// This test runs npm for real four times, and on a Windows runner that is the
// slowest thing CI does. Measured on this test across every CI job since it
// landed: 104 passing Linux runs took 2.8 to 8.3 seconds end to end and 98
// passing macOS runs took 3.0 to 8.5, while 91 passing Windows runs took 8.0 to
// 50.4, median 14.0. Two further Windows runs spent the whole of a 45 second
// budget inside a single one of those installs, at 46.8 and 45.3 seconds end to
// end, in CI runs 33982814495 and 34040862830. So 45 seconds was a fixed window
// rather than a bound: it sat just above the whole test's typical Windows cost
// and below what one stalled step there can reach.
//
// These are bounds on a stall, not on the work. The largest real npm install
// measured on these runners is the packed daemon bootstrap next door, which
// takes up to 142 seconds on Windows against its own 600 second budget, so a
// per-install budget has to clear that before it can claim to be a bound.
// Install stays under the 300000 ms production default, so this still refuses
// sooner than a shipped bootstrap would.
const installBudgetMs = 180_000
// The shipped command spends the production default in its own process, and a
// parent that killed it first would replace its named refusal with a signal.
// This is the backstop for a child that never exits, not a phase budget.
const commandBudgetMs = 180_000
// Above any single phase budget, so one stalled step is reported by the
// bootstrap message that names it rather than by a blunt outer timeout. Four
// simultaneous maximal stalls would still land here, and that is deliberate.
const testBudgetMs = 300_000
// Every fixture spawn and loopback listen below carried the same fixed ten
// second window, which is the bound that a bare where.exe spawn blew twice on
// these runners at 10.1 and 10.8 seconds. The sibling that measured those
// stalls settled the same class at sixty seconds. These guard against a hung
// helper, and the test budget above still stops the run either way.
const fixtureBudgetMs = 60_000

test("identical archives install the reviewed transitive bytes after the registry changes", { timeout: testBudgetMs }, async (t) => {
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
  server.requestTimeout = fixtureBudgetMs
  server.headersTimeout = fixtureBudgetMs
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture registry did not listen in ${fixtureBudgetMs} ms`)), fixtureBudgetMs)
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
    await execute("tar", ["-czf", archive, "-C", directory, "package"], { timeout: fixtureBudgetMs, killSignal: "SIGKILL" })
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
    "index.js": 'require("node:fs").readFileSync(require("node:path").join(__dirname, "built.txt"))\n',
    "lib/utils.js": 'exports.loadNativeModule = () => ({ module: require("../index.js") })\n',
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
    version: "1.0.0", destination, baseUrl: "https://release.test", expectedSha256: sha256, timeoutMs: installBudgetMs, run,
    download: async (url) => url.endsWith("SHA256SUMS") ? `${sha256}  getdomovoi-daemon-1.0.0.tgz\n` : app.bytes,
  })
  const first = await install(join(root, "first"))
  await pack({ name: "domovoi-lock-leaf", version: "1.1.0" })
  const second = await install(join(root, "second"))
  for (const result of [first, second]) {
    const outcome = await execute(process.execPath, [join(result.runtimePath, "dist/index.js")], { timeout: fixtureBudgetMs, killSignal: "SIGKILL" })
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
  { timeout: fixtureBudgetMs, killSignal: "SIGKILL" })
  const releaseServer = createHttpsServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
    if (request.url === "/v1.0.0/SHA256SUMS") response.end(`${sha256}  getdomovoi-daemon-1.0.0.tgz\n`)
    else if (request.url === "/v1.0.0/getdomovoi-daemon-1.0.0.tgz") response.end(app.bytes)
    else response.writeHead(404).end()
  })
  releaseServer.requestTimeout = fixtureBudgetMs
  releaseServer.headersTimeout = fixtureBudgetMs
  t.after(() => { releaseServer.closeAllConnections(); releaseServer.close() })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`HTTPS fixture did not listen in ${fixtureBudgetMs} ms`)), fixtureBudgetMs)
    releaseServer.once("error", (error) => { clearTimeout(timer); reject(error) })
    releaseServer.listen(0, "127.0.0.1", () => { clearTimeout(timer); resolve() })
  })
  const cli = await execute(process.execPath, [fileURLToPath(new URL("./bootstrap-daemon.mjs", import.meta.url)),
    "1.0.0", `https://127.0.0.1:${releaseServer.address().port}`, join(root, "cli"), sha256], {
    timeout: commandBudgetMs, killSignal: "SIGKILL", env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate,
      npm_config_registry: registry, npm_config_global: "true", npm_config_prefix: join(root, "ambient-prefix"),
      NPM_CONFIG_CACHE: join(root, "ambient-cache") },
  })
  const cliResult = JSON.parse(cli.stdout)
  assert.equal(cliResult.sha256, sha256)
  assert.equal(typeof cliResult.runtimePath, "string", "the shipped command must install, not merely download")
  assert.equal(await readFile(join(cliResult.runtimePath, "node_modules/node-pty/built.txt"), "utf8"), "reviewed build ran")
  await assert.rejects(readFile(join(root, "ambient-prefix/package-lock.json")), { code: "ENOENT" })

  // Keep the replacement a valid archive with the same name and version. A
  // malformed tarball could fail without checking integrity and prove nothing
  // about the pin. Only the content hash distinguishes this substituted release.
  await pack({ name: "domovoi-lock-leaf", version: "1.0.0" }, { "replacement.txt": "different bytes under the same version" })
  const rejected = join(root, "replaced")
  await assert.rejects(install(rejected), /EINTEGRITY/)
  await assert.rejects(readFile(join(rejected, "v1.0.0/runtime.json")), { code: "ENOENT" })
  t.diagnostic("Same archive twice: leaf 1.0.0 before and after registry 1.1.0. Real HTTPS bootstrap CLI: installed and built. Replaced locked bytes: refused, no runtime receipt.")
})
