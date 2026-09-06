import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pipeline } from "node:stream/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { bootstrapDeadline, removeStaging } from "./bootstrap-deadline.mjs"
import { downloadOverHttps } from "./bootstrap-download.mjs"

// Microsoft WSL's DistributionInfo.json, Ubuntu-24.04 amd64, checked 2026-09-05.
// Pin both bytes and version. Do not execute a moving installer or accept a
// different archive because a cache or the upstream download changed.
export const wslImage = {
  url: "https://releases.ubuntu.com/24.04.4/ubuntu-24.04.4-wsl-amd64.wsl",
  sha256: "9b2f7730dc68227dd04a9f3e5eab86ad85caf556b8606ad94f1f29ff5c4fd3f5",
}
// Node's official v22.23.2 SHASUMS256.txt, checked 2026-09-05. This is
// fixture tooling, not the operator's Node or a second daemon installer.
export const wslNode = {
  url: "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz",
  sha256: "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307",
}
const mountRoot = "/domovoi-ci-drives/"
const rootDirectory = fileURLToPath(new URL("../", import.meta.url))
const require = createRequire(new URL("../apps/daemon/package.json", import.meta.url))
const execute = promisify(execFile)
const defaultBudgets = { provision: 300_000, runtime: 300_000, proofs: 240_000, cleanup: 60_000 }

function text(bytes) {
  if (typeof bytes === "string") return bytes
  return bytes.toString(bytes[1] === 0 || (bytes[0] === 0xff && bytes[1] === 0xfe) ? "utf16le" : "utf8")
    .replaceAll("\0", "").replaceAll("\uFEFF", "")
}

export async function downloadWslImage(path, deadline, { download = downloadOverHttps, image = wslImage } = {}) {
  const hash = createHash("sha256")
  async function* bytes() {
    for await (const chunk of download(image.url, {
      maximumBytes: 1024 * 1024 * 1024, deadline, inactivityTimeoutMs: 30_000,
    })) {
      hash.update(chunk)
      yield chunk
    }
  }
  // The large image streams to this invocation's private staging directory.
  // Hashing covers those exact bytes, and no WSL process sees it before match.
  await deadline.run(() => pipeline(bytes(), createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal: deadline.signal }))
  assert.equal(hash.digest("hex"), image.sha256, "WSL image sha256 differs from the pinned digest")
}

export function assertWslReport(report) {
  assert.ok(report?.success === true && report.numTotalTests >= 15
    && report.numPassedTests === report.numTotalTests && report.numFailedTests === 0
    && report.numPendingTests === 0 && report.numTodoTests === 0,
  "WSL native proofs must pass at least fifteen tests including repository assertions with no skipped, pending or failed tests")
  // A larger count could be unrelated tests. Require the actual boundary
  // assertions too, so deleting their registration cannot leave a green job.
  const assertions = report.testResults?.flatMap((suite) => suite.assertionResults ?? []) ?? []
  for (const title of [
    "opens the native repository through the Windows CLI without changing the Windows workspace",
    "keeps the native repository owned by the guest while executing real Git",
    "refuses the custom-mounted Windows drive through the Windows open shim",
    "refuses WSL shares at the Windows daemon before repository inspection",
    "rediscovers the restarted guest with its repository and pairing intact",
  ]) {
    assert.ok(assertions.some((test) => test.title === title && test.status === "passed"),
      `WSL native proofs missing repository assertion: ${title}`)
  }
}

const nodeEffects = {
  createStaging: () => mkdtemp(join(tmpdir(), "domovoi-wsl-ci-")),
  downloadImage: downloadWslImage,
  downloadNode: (path, deadline) => downloadWslImage(path, deadline, { image: wslNode }),
  run: async (command, args, options) => {
    try {
      const result = await execute(command, args, { ...options, encoding: "buffer", killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 })
      return text(result.stdout)
    } catch (error) {
      // wsl.exe writes its own diagnostics as UTF-16. Keep its reason readable,
      // including HCS_E_HYPERV_NOT_INSTALLED when nested virtualization goes.
      const output = [text(error.stdout ?? ""), text(error.stderr ?? "")].filter(Boolean).join("\n")
      throw new Error(`${command} failed: ${output || error.message}`, { cause: error })
    }
  },
  readReport: async (path) => JSON.parse(await readFile(path, "utf8")),
  log: (line) => process.stdout.write(`${line}\n`),
}

// Only the dedicated job calls this entry. A host without WSL 2 fails here,
// never takes the normal suite's optional native-test gate. Effects are the
// same boundary exercised by the failure/timeout tests, not an alternate path.
export async function runWslCi({ platform = process.platform, effects = nodeEffects, budgets = defaultBudgets } = {}) {
  if (platform !== "win32") throw new Error("WSL native CI requires a Windows host with working WSL 2 and nested virtualization")
  const distribution = `domovoi-ci-${randomUUID()}`
  budgets = { ...defaultBudgets, ...budgets }
  const phases = []
  let created
  let staging
  let installAttempted = false
  let failure
  let report
  async function phase(name, budget, work) {
    const start = performance.now()
    const deadline = bootstrapDeadline(budget, `WSL ${name} exceeded its ${budget} ms deadline`)
    try { return await work(deadline) }
    finally {
      deadline.clear()
      const seconds = Number(((performance.now() - start) / 1000).toFixed(1))
      phases.push({ name, seconds })
      effects.log(`WSL ${name}: ${seconds} seconds`)
    }
  }
  const run = (deadline, command, args, options = {}) => deadline.run(() =>
    effects.run(command, args, { ...options, signal: deadline.signal }))
  const wsl = (deadline, args) => run(deadline, "wsl.exe", args)
  const linux = (deadline, args) => wsl(deadline, ["-d", distribution, "-u", "root", "--exec", ...args])

  try {
    await phase("provision", budgets.provision, async (deadline) => {
      // Hold the creation itself. A raced await can expire before the path is
      // assigned, so cleanup must settle this promise under its own deadline.
      deadline.check()
      created = (effects.createStaging ?? nodeEffects.createStaging)()
      staging = await deadline.run(() => created)
      effects.log(`WSL required distribution: ${distribution}`)
      effects.log(`WSL runner image: ${process.env.ImageOS ?? "unknown"} ${process.env.ImageVersion ?? "unknown"}`)
      effects.log(await wsl(deadline, ["--version"]))
      const image = join(staging, "ubuntu.wsl")
      await deadline.run(() => effects.downloadImage(image, deadline))
      await wsl(deadline, ["--set-default-version", "2"])
      // UUID names only. Even a partially failed import is cleaned up, and no
      // pre-existing distribution or runner-wide shutdown is ever targeted.
      installAttempted = true
      await wsl(deadline, ["--install", "--no-launch", "--from-file", image, "--name", distribution])
      await linux(deadline, ["sh", "-c", `printf '%s\\n' '[boot]' 'systemd=false' '[user]' 'default=root' '[automount]' 'root=${mountRoot}' > /etc/wsl.conf`])
      await wsl(deadline, ["--terminate", distribution])
      const kernel = (await linux(deadline, ["uname", "-r"])).trim()
      assert.match(kernel, /microsoft.*WSL2/i, "The required distribution did not start a WSL 2 kernel; check hosted-runner nested virtualization")
      effects.log(`WSL guest kernel: ${kernel}`)
      // Keep the guest running between probes. This finite process belongs to
      // the disposable distro; cleanup terminates it even when proofs fail.
      await linux(deadline, ["sh", "-c", "nohup sleep 600 </dev/null >/dev/null 2>&1 &"])
    })
    await phase("guest runtime", budgets.runtime, async (deadline) => {
      const archive = join(staging, "node.tar.xz")
      await deadline.run(() => effects.downloadNode(archive, deadline))
      const guestArchive = (await linux(deadline, ["wslpath", "-u", archive])).trim()
      const checkout = (await linux(deadline, ["wslpath", "-u", rootDirectory])).trim()
      assert.ok(guestArchive.startsWith("/") && checkout.startsWith("/"), "WSL did not place the runtime inputs in its filesystem")
      await linux(deadline, ["mkdir", "-m", "700", "/opt/domovoi-ci-node"])
      await linux(deadline, ["tar", "-xJf", guestArchive, "--strip-components=1", "-C", "/opt/domovoi-ci-node"])
      effects.log(await linux(deadline, ["/opt/domovoi-ci-node/bin/node", `${checkout.replace(/\/$/, "")}/scripts/wsl-ci-guest.mjs`,
        checkout, "/opt/domovoi-ci-daemon"]))
    })
    await phase("native proofs", budgets.proofs, async (deadline) => {
      const reportPath = join(staging, "native.json")
      const vitestCli = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs")
      try {
        effects.log(await run(deadline, process.execPath, [vitestCli, "run", "src/wsl-windows.test.ts",
          "--coverage.enabled=false", "--reporter=default", "--reporter=json", `--outputFile=${reportPath}`], {
          cwd: join(rootDirectory, "apps", "daemon"),
          env: { ...process.env, DOMOVOI_WSL_REQUIRED_DISTRIBUTION: distribution, DOMOVOI_WSL_EXPECTED_MOUNT_ROOT: mountRoot,
            DOMOVOI_WSL_NATIVE_TRANSPORT: "1", DOMOVOI_WSL_NATIVE_BUDGET_MS: String(budgets.proofs) },
        }))
        report = await deadline.run(() => effects.readReport(reportPath))
        assertWslReport(report)
      } catch (error) {
        // A nonzero Vitest exit still writes assertion and hook failures to
        // JSON. Print them before cleanup deletes the only copy. Diagnostics
        // get a separate five-second bound if the proof deadline is exhausted,
        // and a missing report must never replace the original process error.
        const diagnostics = bootstrapDeadline(5_000, "WSL proof report read exceeded its deadline")
        try {
          const failedReport = report ?? await diagnostics.run(() => effects.readReport(reportPath))
          effects.log(`WSL native proof report (${reportPath}):\n${JSON.stringify(failedReport, null, 2)}`)
        } catch (diagnosticError) {
          effects.log(`WSL native proof report unavailable (${reportPath}): ${diagnosticError.message}`)
        } finally { diagnostics.clear() }
        throw error
      }
    })
  } catch (error) {
    failure = error
  } finally {
    try {
      await phase("cleanup", budgets.cleanup, async (deadline) => {
        const errors = []
        if (installAttempted) {
          // Unregister even when terminate refuses. Both attempts share this
          // cleanup budget and never remove another invocation's distro.
          for (const operation of ["--terminate", "--unregister"]) {
            try { await wsl(deadline, [operation, distribution]) } catch (error) { errors.push(error) }
          }
        }
        if (created) {
          try {
            const directory = await deadline.run(() => created)
            await deadline.run(() => removeStaging(directory, rm, deadline))
          } catch (error) { errors.push(error) }
        }
        if (errors.length > 0) throw new AggregateError(errors,
          `WSL cleanup failed for ${distribution}: ${errors.map((error) => error.message).join("; ")}`)
      })
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], `${failure.message}; ${error.message}`) : error
    }
  }
  if (failure) throw failure
  effects.log(`DOMOVOI_WSL_NATIVE_OK: ${report.numPassedTests} passed, zero skipped`)
  return { phases, tests: report.numPassedTests }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await runWslCi()
    if (process.env.GITHUB_STEP_SUMMARY) {
      const summary = bootstrapDeadline(5_000, "WSL job summary write exceeded its deadline")
      try {
        await summary.run(() => appendFile(process.env.GITHUB_STEP_SUMMARY,
          `### WSL native proofs\n\n${result.tests} passed, zero skipped. One Ubuntu 24.04.4 WSL 2 distribution.\n\n`
          + result.phases.map(({ name, seconds }) => `- ${name}: ${seconds} seconds\n`).join("")
          + "\nProves guest boot, custom-mount refusal, Windows CLI repository open, guest ownership and Git, authenticated WSL routes, graceful daemon restart, stale endpoints and stopped-distribution refusal. Does not prove cross-distribution routing, service supervision, mirrored networking or VPNs.\n"))
      } finally { summary.clear() }
    }
  } catch (error) {
    process.stderr.write(`DOMOVOI_WSL_NATIVE_FAILED: ${error.message}\nNo WSL 1 fallback or skipped proof is accepted. See docs/wsl-ci.md.\n`)
    process.exitCode = 1
  }
}
