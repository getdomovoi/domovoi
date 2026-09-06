import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { workspaceSnapshotSchema, type FleetMachine } from "@getdomovoi/protocol"
import { beforeAll, describe, expect, it } from "vitest"

import { callDaemonOnce } from "./cli-rpc.js"
import { readMachineDescriptor } from "./machine-socket.js"
import type { MachineConnection } from "./machine-dial.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import type { FleetDaemon } from "./test-fleet-production.js"
import type { DistroEndpoint } from "./wsl-endpoint.js"
import { distroGitCommand } from "./wsl-git.js"

const execute = promisify(execFile)
const cliPath = fileURLToPath(new URL("../dist/index.js", import.meta.url))

type NativeRepositoryFixture = {
  distribution: string
  source(): FleetDaemon
  endpoint(): DistroEndpoint
  guest(): FleetMachine
  scratch(): Promise<string>
  repository(name: string): Promise<string>
  linux(deadline: OperationDeadline, args: string[]): Promise<string>
  run(deadline: OperationDeadline, args: string[]): Promise<string>
  dial(deadline: OperationDeadline): Promise<MachineConnection>
  restart(deadline: OperationDeadline): Promise<void>
}

// Registered inside the native transport fixture, before its deliberate kill
// and stopped-guest proofs. Nothing here substitutes path translation, Git,
// the Windows CLI, the guest daemon or its repository inspection.
export function nativeWslRepositoryProofs(fixture: NativeRepositoryFixture): void {
  describe("Windows to WSL repository boundaries", () => {
    const repository = "/tmp/domovoi-native space $HOME $(printf altered)"
    const unc = (path: string, host = "wsl$") => `\\\\${host}\\${fixture.distribution}${path.replaceAll("/", "\\")}`
    let cliDirectory: string
    let commit: string

    const workspace = async (deadline: OperationDeadline) => workspaceSnapshotSchema.parse(await callDaemonOnce({
      target: fixture.endpoint(), token: fixture.endpoint().token, method: "workspace.get", params: {}, deadline,
    }))
    const hostProject = async (deadline: OperationDeadline) => workspaceSnapshotSchema.parse(
      await beforeDeadline(fixture.source().root.ok("workspace.get", {}), deadline),
    ).project

    async function cli(deadline: OperationDeadline, args: string[]) {
      deadline.throwIfExpired()
      try {
        // Intentionally configure the Windows daemon, not the guest. A WSL
        // open must discover and authenticate the guest rather than reuse this
        // machine's endpoint or credential. execFile does not invoke a shell.
        const result = await execute(process.execPath, [cliPath, ...args], {
          cwd: cliDirectory, signal: deadline.signal, timeout: Math.ceil(deadline.remainingMs()),
          killSignal: "SIGKILL", maxBuffer: 65_536,
          env: { ...process.env, DOMOVOI_HOST: "127.0.0.1",
            DOMOVOI_PORT: String(new URL(fixture.source().address.url).port),
            DOMOVOI_AUTH_TOKEN: fixture.source().handle.authToken },
        })
        deadline.throwIfExpired()
        return { code: 0, ...result }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "number") throw error
        const output = error as Error & { code: number; stdout: string; stderr: string }
        return { code: output.code, stdout: output.stdout, stderr: output.stderr }
      }
    }

    beforeAll(async () => {
      const deadline = OperationDeadline.start(30_000)
      try {
        cliDirectory = await beforeDeadline(fixture.scratch(), deadline)
        process.stdout.write(`WSL repository Git: ${(await fixture.linux(deadline, ["git", "--version"])).trim()}\n`)
        await fixture.linux(deadline, ["git", "init", "-b", "main", "--", repository])
        await fixture.linux(deadline, ["git", "-C", repository, "-c", "user.name=WSL proof", "-c", "user.email=test@example.invalid",
          "commit", "--allow-empty", "-m", "Native WSL fixture"])
        commit = (await fixture.linux(deadline, ["git", "-C", repository, "rev-parse", "HEAD"])).trim()
        expect(commit).toMatch(/^[0-9a-f]{40}$/)
      } finally { deadline.clear() }
    }, 40_000)

    it("opens the native repository through the Windows CLI without changing the Windows workspace", async () => {
      const deadline = OperationDeadline.start(30_000)
      try {
        const original = await hostProject(deadline)
        const discovered = await cli(deadline, ["wsl", "list"])
        expect(discovered.code, discovered.stderr).toBe(0)
        expect(discovered.stdout).toContain(fixture.distribution)
        expect(discovered.stdout).toContain(`daemon at ws://127.0.0.1:${fixture.endpoint().port}/rpc`)
        expect(discovered.stdout).not.toContain(fixture.endpoint().token)
        for (const host of ["wsl$", "wsl.localhost"]) {
          const opened = await cli(deadline, ["open", unc(repository, host)])
          expect(opened.code, opened.stderr).toBe(0)
          expect(opened.stdout).toContain(`Opened ${repository} in ${fixture.distribution}`)
          const actual = await workspace(deadline)
          expect(actual.machine.id).toBe(fixture.guest().id)
          expect(actual.machine.id).not.toBe(fixture.source().id)
          expect(actual.project).toMatchObject({ machineId: actual.machine.id, path: repository, branch: "main" })
          expect(await hostProject(deadline)).toEqual(original)
        }
      } finally { deadline.clear() }
    }, 40_000)

    it("keeps the native repository owned by the guest while executing real Git", async () => {
      const deadline = OperationDeadline.start(20_000)
      try {
        const command = await beforeDeadline(distroGitCommand({ distribution: fixture.distribution,
          repositoryPath: repository, args: ["rev-parse", "--show-toplevel", "HEAD"],
          timeoutMs: Math.ceil(deadline.remainingMs()),
        }), deadline)
        expect(command.command).toBe("wsl.exe")
        expect((await fixture.run(deadline, command.args)).trim().split(/\r?\n/)).toEqual([repository, commit])
        const owner = (await fixture.linux(deadline, ["stat", "-c", "%u", "--", `${repository}/.git`])).trim()
        expect(owner).toBe((await fixture.linux(deadline, ["id", "-u"])).trim())
        const readBack = (await fixture.linux(deadline, ["wslpath", "-w", repository])).trim().toLowerCase()
        expect([unc(repository).toLowerCase(), unc(repository, "wsl.localhost").toLowerCase()]).toContain(readBack)
        expect((await fixture.linux(deadline, ["git", "-C", repository, "status", "--porcelain"])).trim()).toBe("")
      } finally { deadline.clear() }
    }, 30_000)

    it("refuses the custom-mounted Windows drive through the Windows open shim", async () => {
      const deadline = OperationDeadline.start(30_000)
      try {
        // A real, valid Windows repository prevents a non-repository error
        // from masquerading as the filesystem boundary being enforced.
        const windowsRepository = await beforeDeadline(fixture.repository("mounted Windows repository"), deadline)
        const mounted = (await fixture.linux(deadline, ["wslpath", "-u", windowsRepository])).trim()
        expect(process.env["DOMOVOI_WSL_EXPECTED_MOUNT_ROOT"]).toBe("/domovoi-ci-drives/")
        expect(mounted).toMatch(/^\/domovoi-ci-drives\/[a-z]\//)
        const original = (await workspace(deadline)).project
        const originalHost = await hostProject(deadline)
        for (const host of ["wsl$", "wsl.localhost"]) {
          const refused = await cli(deadline, ["open", unc(mounted, host)])
          expect(refused.code, refused.stdout).toBe(1)
          expect(refused.stderr).toContain("Windows drive")
          expect(refused.stderr).toContain("from Windows instead")
          expect((await workspace(deadline)).project).toEqual(original)
          expect(await hostProject(deadline)).toEqual(originalHost)
        }
        await expect(distroGitCommand({ distribution: fixture.distribution, repositoryPath: mounted,
          args: ["status"], timeoutMs: Math.ceil(deadline.remainingMs()) })).rejects.toThrow(/Windows drive/)
      } finally { deadline.clear() }
    }, 40_000)

    it("refuses WSL shares at the Windows daemon before repository inspection", async () => {
      const deadline = OperationDeadline.start(20_000)
      try {
        const original = await hostProject(deadline)
        for (const host of ["wsl$", "wsl.localhost"]) {
          const refused = await beforeDeadline(fixture.source().root.call("project.open", { path: unc(repository, host), client: "cli" }), deadline)
          expect(refused.result).toBeUndefined()
          expect(refused.error).toMatchObject({ code: -32602 })
          expect(refused.error?.message).toContain("does not reach through the share")
          expect(refused.error?.message).toContain("domovoid open")
          expect(await hostProject(deadline)).toEqual(original)
        }
      } finally { deadline.clear() }
    }, 30_000)

    it("rediscovers the restarted guest with its repository and pairing intact", async () => {
      const deadline = OperationDeadline.start(60_000)
      try {
        const original = await workspace(deadline)
        await fixture.restart(deadline)
        const discovered = await cli(deadline, ["wsl", "list"])
        expect(discovered.code, discovered.stderr).toBe(0)
        expect(discovered.stdout).toContain(`daemon at ws://127.0.0.1:${fixture.endpoint().port}/rpc`)
        const restarted = await workspace(deadline)
        expect(restarted.machine.id).toBe(original.machine.id)
        expect(restarted.project).toEqual(original.project)
        const route = await fixture.dial(deadline)
        try {
          expect(await readMachineDescriptor(route, fixture.guest().id,
            fixture.source().credentials.forMachine(fixture.guest().id)!, deadline)).toMatchObject({ id: original.machine.id })
        } finally { route.close() }
        expect((await fixture.linux(deadline, ["git", "-C", repository, "rev-parse", "HEAD"])).trim()).toBe(commit)
        const opened = await cli(deadline, ["open", unc(repository)])
        expect(opened.code, opened.stderr).toBe(0)
      } finally { deadline.clear() }
    }, 70_000)
  })
}
