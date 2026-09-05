import { execFile, fork } from "node:child_process"
import { once } from "node:events"
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { expect, it } from "vitest"

import { OperationDeadline } from "../operation-deadline.js"
import { serviceConfigurationPath } from "./configuration.js"
import { withinServiceDeadline } from "./deadline.js"

const cliPath = fileURLToPath(new URL("../../dist/index.js", import.meta.url))
const managerSource = new URL("../../test-fixtures/service-manager.mjs", import.meta.url)
const run = promisify(execFile)
const budget = process.platform === "win32" ? 60_000 : 20_000
const cleanupBudget = 10_000

it.each(["install", "remove"])("excludes real CLI contenders while %s waits on its manager", async (first) => {
  const deadline = OperationDeadline.start(budget)
  const within = <T>(operation: () => Promise<T>) => withinServiceDeadline(deadline, operation)
  const home = await within(() => mkdtemp(join(tmpdir(), "domovoi-service-process-")))
  let child: ReturnType<typeof fork> | undefined
  let exited: Promise<unknown> | undefined
  try {
    const preload = join(home, "manager # shim.mjs")
    await within(() => copyFile(managerSource, preload))
    const moduleUrl = pathToFileURL(preload).href
    const log = join(home, "manager.jsonl")
    const env = {
      ...process.env, HOME: home, USERPROFILE: home, NODE_NO_WARNINGS: "1",
      DOMOVOI_TEST_MANAGER_LOG: log, DOMOVOI_TEST_SERVICE_HOME: home,
      DOMOVOI_TEST_MANAGER_HOLD: undefined, DOMOVOI_AUTH_TOKEN: undefined,
      DOMOVOI_HOST: "127.0.0.1", DOMOVOI_PORT: "0", DOMOVOI_ALLOW_REMOTE_TRANSPORT: "0",
      DOMOVOI_TLS_CERT_PATH: undefined, DOMOVOI_TLS_KEY_PATH: undefined,
      DOMOVOI_ALLOWED_ORIGINS: undefined, DOMOVOI_ADVERTISE_HOST: undefined,
      DOMOVOI_CREDENTIAL_PATH: join(home, ".domovoi", "daemon.token"),
      DOMOVOI_MACHINE_IDENTITY_PATH: join(home, ".domovoi", "machine.json"),
    }
    const command = (verb: string, environment = env) => within(() => run(process.execPath,
      ["--import", moduleUrl, cliPath, "service", verb], {
        env: environment, signal: deadline.signal, timeout: Math.ceil(deadline.remainingMs()), killSignal: "SIGKILL",
      }))
    await command("install")
    deadline.throwIfExpired()
    child = fork(cliPath, ["service", first], {
      execArgv: ["--import", moduleUrl], env: { ...env, DOMOVOI_TEST_MANAGER_HOLD: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"], signal: deadline.signal, killSignal: "SIGKILL",
    })
    exited = once(child, "exit")
    void exited.catch(() => {})
    let output = ""
    child.stderr?.on("data", (bytes: Buffer) => { output += bytes.toString() })
    child.stdout?.on("data", (bytes: Buffer) => { output += bytes.toString() })
    const ready = once(child, "message", { signal: deadline.signal })
    const earlyExit = exited.then(() => { throw new Error(`CLI exited before manager hold: ${output}`) })
    expect(await within(() => Promise.race([ready, earlyExit]))).toEqual([{ state: "manager-held" }, undefined])
    const recorded = await within(() => readFile(log, "utf8"))
    const configuration = await within(() => readFile(serviceConfigurationPath(home, process.platform), "utf8"))

    for (const verb of ["install", "remove", "status"]) {
      // Changing the shell's profile path must not fork the native OS user's
      // one service lock. No alternate profile may even be published here.
      const alternate = join(home, `alternate-${verb}`)
      await expect(command(verb, { ...env, HOME: alternate, USERPROFILE: alternate }))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Another Domovoi service operation") })
      expect(await within(() => readFile(log, "utf8"))).toBe(recorded)
      expect(await within(() => readFile(serviceConfigurationPath(home, process.platform), "utf8"))).toBe(configuration)
      await expect(within(() => stat(alternate))).rejects.toMatchObject({ code: "ENOENT" })
    }
    const leasePath = join(home, ".domovoi", "service-operation-lease.sqlite")
    const metadata = await within(() => stat(leasePath))
    if (process.platform !== "win32") expect(metadata.mode & 0o777).toBe(0o600)

    if (first === "install") {
      // The OS releases the operation lease after an ungraceful CLI exit.
      // This fixture submits no real native job, so reacquisition is not a
      // claim that killing systemctl cancels work accepted by systemd.
      child.kill("SIGKILL")
      await within(() => exited!)
      await command("remove")
      await expect(within(() => stat(serviceConfigurationPath(home, process.platform)))).rejects.toMatchObject({ code: "ENOENT" })
    } else {
      child.send("resume")
      expect(await within(() => exited!), output).toEqual([0, null])
      await command("install")
      await within(() => stat(serviceConfigurationPath(home, process.platform)))
    }
    // Unlocking never removes the inode. Deleting it would split future locks.
    const after = await within(() => stat(leasePath))
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: metadata.dev, ino: metadata.ino })
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    deadline.clear()
    const cleanup = OperationDeadline.start(cleanupBudget)
    try {
      if (exited) await withinServiceDeadline(cleanup, () => exited!)
      await withinServiceDeadline(cleanup, () => rm(home, { recursive: true, force: true }))
    } finally { cleanup.clear() }
  }
}, budget + cleanupBudget + 1_000)
