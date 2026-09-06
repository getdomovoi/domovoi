import { spawn, type ChildProcess } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"

import { fleetSnapshotSchema, type FleetMachine } from "@getdomovoi/protocol"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { callDaemonOnce } from "./cli-rpc.js"
import { createMachineDialer } from "./machine-dial.js"
import { MachinePairingRequiredError, openMachineSocket, readMachineDescriptor } from "./machine-socket.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { fleetProductionHarness, remote, type FleetDaemon } from "./test-fleet-production.js"
import { asyncTestCredentials } from "./test-machine-credentials.js"
import { readDistroEndpoint, type DistroEndpoint } from "./wsl-endpoint.js"
import { listWslDistributions } from "./wsl-list.js"
import { runWslText } from "./wsl-run.js"

// Loaded only by wsl-windows.test.ts. The job provisions this one disposable
// guest and its exact locked runtime before asking Windows to run these proofs.
// Enrollment, guest facts, endpoint files, credentials and sockets are real.
// The final proof deliberately restores an obsolete loopback route on the
// observed target to check that it cannot bypass a stopped distribution.
export function nativeWslTransportProofs(distribution: string | undefined): void {
  describe.skipIf(distribution === undefined || process.env["DOMOVOI_WSL_NATIVE_TRANSPORT"] !== "1")(
    "production WSL transport in the required guest", () => {
      const harness = fleetProductionHarness()
      let source: FleetDaemon
      let endpoint: DistroEndpoint
      let guest: FleetMachine
      let pid: string
      let guestProcess: ChildProcess | undefined
      let guestOutput = ""
      let guestExit: string | undefined
      let guestLifetime: OperationDeadline | undefined
      const run = (deadline: OperationDeadline, args: string[]) => {
        deadline.throwIfExpired()
        return beforeDeadline(runWslText("wsl.exe", args, {
          timeoutMs: Math.ceil(deadline.remainingMs()), signal: deadline.signal,
        }), deadline)
      }
      const linux = (deadline: OperationDeadline, args: string[]) => run(deadline, ["-d", distribution!, "--exec", ...args])
      async function observe<T>(deadline: OperationDeadline, check: () => Promise<T | undefined>): Promise<T> {
        for (;;) {
          deadline.throwIfExpired()
          const value = await beforeDeadline(check(), deadline)
          if (value !== undefined) return value
          await delay(100, undefined, { signal: deadline.signal })
        }
      }
      function dial(credential?: string) {
        return createMachineDialer({ machine: () => guest,
          credentials: credential === undefined ? asyncTestCredentials(source.credentials)
            : asyncTestCredentials({ forMachine: () => credential, machines: () => [guest.id], save: () => {}, forget: () => {} }),
          dialTimeoutMs: 5_000,
          open: (input) => openMachineSocket({ ...input, callTimeoutMs: 5_000 }),
        })(guest.id)
      }

      beforeAll(async () => {
        expect(process.platform).toBe("win32")
        expect(distribution).toMatch(/^domovoi-ci-[0-9a-f-]{36}$/)
        const deadline = OperationDeadline.start(60_000)
        let phase = "start Windows source"
        const progress = (next: string) => {
          phase = next
          process.stdout.write(`WSL transport setup: ${phase}\n`)
        }
        try {
          progress(phase)
          source = await beforeDeadline(harness.machine("Windows WSL route owner"), deadline)
          // Fixed fixture paths in the job's UUID guest. The launched binary is
          // the real CLI and uses createProductionDaemon, its normal stores and
          // endpoint publisher. It never imports a test daemon constructor.
          progress("launch guest daemon")
          // Keep the WSL invocation attached to its real CLI, not a shell that
          // leaves before its background child's startup can be observed. The
          // fixture's lifetime is bounded independently of individual RPCs.
          guestLifetime = OperationDeadline.start(180_000)
          guestProcess = spawn("wsl.exe", ["-d", distribution!, "--exec", "sh", "-c",
            "echo $$ >/tmp/domovoi-ci-daemon.pid; "
            + "exec env PATH=/opt/domovoi-ci-node/bin:/usr/sbin:/usr/bin:/sbin:/bin DOMOVOI_HOST=127.0.0.1 DOMOVOI_PORT=0 "
            + "/opt/domovoi-ci-node/bin/node /opt/domovoi-ci-daemon/dist/index.js"], {
            stdio: ["ignore", "pipe", "pipe"], signal: guestLifetime.signal, killSignal: "SIGKILL",
          })
          const output = (bytes: Buffer) => { guestOutput = (guestOutput + bytes.toString()).slice(-65_536) }
          guestProcess.stdout?.on("data", output)
          guestProcess.stderr?.on("data", output)
          guestProcess.once("error", (error) => { guestExit = error.message })
          guestProcess.once("exit", (code, signal) => { guestExit = `code ${code}, signal ${signal}` })
          progress("observe guest endpoint publication")
          endpoint = await observe(deadline, () => {
            if (guestExit !== undefined) throw new Error(`Guest daemon exited before endpoint publication: ${guestExit}`)
            return readDistroEndpoint({ distribution: distribution!, timeoutMs: Math.ceil(deadline.remainingMs()) })
          })
          pid = (await linux(deadline, ["cat", "/tmp/domovoi-ci-daemon.pid"])).trim()
          expect(pid).toMatch(/^[1-9][0-9]*$/)
          // The listener may be up before WSL's localhost forward is installed.
          // Each probe gets only its remaining caller budget; the poll itself
          // shares this setup deadline and never creates a second daemon.
          progress("authenticate Windows-to-guest root setup socket")
          const issued = await observe(deadline, async () => {
            const attempt = deadline.limit(3_000)
            try {
              return await callDaemonOnce({ target: endpoint, token: endpoint.token,
                method: "device.issueCode", params: {}, deadline: attempt }) as { code: string }
            } catch { return undefined }
            finally { attempt.clear() }
          })
          progress("enroll guest through the source daemon")
          const enrolled = await source.root.ok("fleet.enroll", {
            endpoint: `ws://127.0.0.1:${endpoint.port}/rpc`, code: issued.code,
            sourceDeviceLabel: "Windows WSL proof", client: "cli",
          }) as { outcome: string; machineId: string }
          expect(enrolled.outcome).toBe("enrolled")
          progress("observe an authenticated WSL heartbeat")
          guest = await observe(deadline, async () => {
            const facts = remote(fleetSnapshotSchema.parse(await source.root.ok("fleet.list", {})), enrolled.machineId)
            return facts.connection === "wsl" ? facts : undefined
          })
          expect(guest).toMatchObject({ platform: "linux", wsl: { distribution, version: 2 }, health: "healthy" })
          expect(guest.verifiedRoute).toBeUndefined()
          progress("complete")
        } catch (error) {
          process.stderr.write(`WSL transport setup failed during: ${phase}\n`)
          process.stderr.write(`Guest daemon output: ${guestOutput || "(none)"}\n`)
          throw new Error(`WSL transport setup failed during: ${phase}`, { cause: error })
        } finally { deadline.clear() }
      }, 70_000)

      // The outer wsl-ci invocation owns this UUID guest and terminates then
      // unregisters it even after a hook failure. Do not re-enter a deliberately
      // stopped guest here or kill a remembered PID after the kill proof ran.
      afterAll(async () => {
        guestProcess?.kill("SIGKILL")
        guestLifetime?.clear()
        await harness.cleanup()
      }, 30_000)

      it("produces an authenticated WSL candidate through the production fleet heartbeat and dialer", async () => {
        const route = await dial()
        const deadline = OperationDeadline.start(5_000)
        try {
          expect(route).toMatchObject({ routeSource: "wsl", transport: {
            kind: "wsl", endpoint: `ws://127.0.0.1:${endpoint.port}/rpc`, authenticated: true,
          } })
          expect(await readMachineDescriptor(route, guest.id, source.credentials.forMachine(guest.id)!, deadline))
            .toMatchObject({ id: guest.id, wsl: { distribution, version: 2 } })
          // A successful socket alone is not authority. Machine admission must
          // not grant the source the root credential's workspace access.
          await expect(route.call("workspace.get", {}, undefined, deadline)).rejects.toThrow()
        } finally { deadline.clear(); route.close() }
      }, 20_000)

      it("refuses both a wrong pairing and the endpoint file's root token", async () => {
        for (const credential of ["x".repeat(43), endpoint.token]) {
          await expect(dial(credential)).rejects.toBeInstanceOf(MachinePairingRequiredError)
        }
      }, 20_000)

      it("produces no route from the real leftover endpoint after the daemon is killed", async () => {
        const deadline = OperationDeadline.start(15_000)
        try {
          await linux(deadline, ["kill", "-KILL", "--", pid])
          // kill returns after sending a signal, not after socket teardown.
          await observe(deadline, async () => {
            const stat = await linux(deadline, ["sh", "-c", `test ! -r /proc/${pid}/stat || cat /proc/${pid}/stat`])
            return stat === "" || /\) Z /.test(stat) ? true : undefined
          })
          expect(await readDistroEndpoint({ distribution: distribution!, timeoutMs: 5_000 })).toEqual(endpoint)
          await expect(dial()).rejects.toMatchObject({ name: "WslTransportError" })
        } finally { deadline.clear() }
      }, 25_000)

      it("refuses a stopped distribution without starting it or reusing the old loopback port", async () => {
        source.root.socket.terminate()
        await source.handle.stop()
        const deadline = OperationDeadline.start(15_000)
        try {
          await run(deadline, ["--terminate", distribution!])
          const state = async () => (await listWslDistributions({ timeoutMs: Math.ceil(deadline.remainingMs()) }))
            .find((entry) => entry.name === distribution)?.state
          await observe(deadline, async () => await state() === "Stopped" ? true : undefined)
          // Also fence the loopback route enrollment stored before the first
          // heartbeat. A stopped guest must not bypass production discovery.
          guest = { ...guest, connection: "direct", verifiedRoute: {
            endpoint: `ws://127.0.0.1:${endpoint.port}/rpc`, lastAuthenticatedAt: new Date().toISOString(),
          } }
          await expect(dial()).rejects.toMatchObject({ name: "WslTransportError", reason: "stopped" })
          expect(await state()).toBe("Stopped")
        } finally { deadline.clear() }
      }, 30_000)
    },
  )
}
