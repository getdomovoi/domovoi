import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { DomovoiDaemon } from "./server.js"
import type { WorkspaceService } from "./workspace.js"

const running: DomovoiDaemon[] = []
const cliPath = fileURLToPath(new URL("../dist/index.js", import.meta.url))

function testAuthToken(label: string): string {
  return createHash("sha256").update(label).digest("base64url")
}

const workspaceService = {
  inspect: async (path: string) => ({
    root: path,
    name: "project",
    branch: "main",
    head: "a".repeat(40),
  }),
  createSessionWorkspace: async () => ({
    path: "/unused",
    branch: "unused",
    baseCommit: "a".repeat(40),
  }),
  removeSessionWorkspace: async () => {},
  checkpoint: async () => ({ commit: "a".repeat(40), changedFiles: [] }),
  restore: async () => ({
    restoredCommit: "a".repeat(40),
    recoveryCommit: "a".repeat(40),
  }),
} satisfies WorkspaceService

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
})

async function startDaemon(): Promise<DomovoiDaemon> {
  const daemon = new DomovoiDaemon({
    port: 0,
    statePath: ":memory:",
    authToken: testAuthToken("cli-identity-seam"),
    workspaceService,
  })
  running.push(daemon)
  await daemon.start()
  return daemon
}

async function runCli(daemon: DomovoiDaemon, args: readonly string[]) {
  const address = daemon.address!
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        DOMOVOI_HOST: address.host,
        DOMOVOI_PORT: String(address.port),
        DOMOVOI_AUTH_TOKEN: daemon.authToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`domovoid ${args.join(" ")} did not exit`))
    }, 5_000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (data: string) => { stdout += data })
    child.stderr.on("data", (data: string) => { stderr += data })
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (exitCode) => {
      clearTimeout(timeout)
      resolve({ exitCode, stdout, stderr })
    })
  })
}

describe("domovoid CLI connection identity", () => {
  it("pairs through a real daemon socket", async () => {
    const result = await runCli(await startDaemon(), ["pair"])

    expect(result).toMatchObject({ exitCode: 0, stderr: "" })
    expect(result.stdout).toContain("Pairing code:")
    expect(result.stdout).toContain("Enter it on the machine you are pairing from.")
  })

  it("opens a project through a real daemon socket", async () => {
    const result = await runCli(await startDaemon(), ["open", "/code/project"])

    expect(result).toMatchObject({ exitCode: 0, stderr: "" })
    expect(result.stdout).toBe("Opened /code/project\n")
  })
})
