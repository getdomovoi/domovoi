import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { protocolVersion } from "@getdomovoi/protocol"
import { WebSocket } from "ws"

// A real production daemon in a child process, on a scratch home, with the
// daemon's own in-memory keyring fixture so nothing touches the operator's
// keychain. The CLI under test is the built dist, run as a user would run it.
const daemonFixtures = resolve(import.meta.dirname, "../../daemon/test-fixtures")
const rootToken = "k".repeat(43)
const cli = resolve(import.meta.dirname, "../dist/index.js")
const startupBudgetMs = process.platform === "win32" ? 25_000 : 20_000

let child: ReturnType<typeof spawn> | undefined
let home: string | undefined
let control: string | undefined
let url: string
// Setup awaits twice before it spawns. If teardown runs first (a hook
// timeout, an aborted run), the spawn must not happen at all, and teardown
// must clean only what setup had acquired by then.
let abandoned = false

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "domovoi-cli-e2e-home-"))
  control = await mkdtemp(join(tmpdir(), "domovoi-cli-e2e-keyring-"))
  if (abandoned) throw new Error("teardown ran before setup finished; not spawning a daemon")
  child = spawn(process.execPath, [
    // --import takes a URL: on Windows a bare D:\ path is read as a scheme.
    "--import", pathToFileURL(join(daemonFixtures, "blocked-keyring.mjs")).href,
    "--import", "tsx",
    join(daemonFixtures, "keyring-daemon.mjs"), home,
  ], {
    cwd: resolve(import.meta.dirname, "../../daemon"),
    env: { ...process.env, DOMOVOI_TEST_KEYRING_DIRECTORY: control, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout!.on("data", (bytes: Buffer) => { stdout += bytes.toString() })
  child.stderr!.on("data", (bytes: Buffer) => { stderr += bytes.toString() })
  const started = Date.now()
  while (!stdout.includes("\n")) {
    if (abandoned) throw new Error("teardown ran while the daemon was starting")
    if (child.exitCode !== null) throw new Error(`daemon fixture exited ${child.exitCode}: ${stderr}`)
    if (Date.now() - started > startupBudgetMs) throw new Error(`daemon fixture did not print its address in ${startupBudgetMs} ms: ${stderr}`)
    await new Promise((settle) => setTimeout(settle, 50))
  }
  url = (JSON.parse(stdout.slice(0, stdout.indexOf("\n"))) as { url: string }).url
}, startupBudgetMs + 5_000)

afterAll(async () => {
  abandoned = true
  if (child && child.exitCode === null) {
    // The fixture stops its daemon on SIGTERM. Nothing here waits on the
    // daemon's own stop budget: a scratch home is deleted either way.
    child.kill("SIGTERM")
    const grace = setTimeout(() => child?.kill("SIGKILL"), 5_000)
    await once(child, "exit")
    clearTimeout(grace)
  }
  for (const path of [home, control]) if (path !== undefined) await rm(path, { recursive: true, force: true })
})

// What `domovoid pair --client cli` does on the daemon host: device.pair with
// the daemon's own token, which prints the client credential once.
async function mintClientCredential(): Promise<string> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${rootToken}` } })
  await once(socket, "open")
  const reply = await new Promise<{ result?: { token: string }; error?: { message: string } }>((resolve, reject) => {
    socket.on("message", (data: { toString(): string }) => {
      const message = JSON.parse(data.toString()) as { id?: unknown; result?: { token: string }; error?: { message: string } }
      if (message.id === 2) resolve(message)
    })
    socket.once("error", reject)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system.hello", params: { client: "cli", clientVersion: "test", protocolVersion } }))
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "device.pair", params: { label: "e2e cli", client: "cli" } }))
  })
  socket.terminate()
  if (!reply.result) throw new Error(reply.error?.message ?? "no credential")
  return reply.result.token
}

function runCli(args: string[], stdinText?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString() })
    child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString() })
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }))
    if (stdinText !== undefined) child.stdin.write(stdinText)
    child.stdin.end()
  })
}

describe("domovoi against a real daemon", { timeout: 30_000 }, () => {
  it("pairs from a pasted credential, stores it in the named file, and reads status back", async () => {
    const credentialFile = join(home!, "cli-credentials.json")
    const credential = await mintClientCredential()
    const paired = await runCli(["pair", "--daemon", url, "--credential-file", credentialFile], `Client credential: ${credential}\n`)
    expect(paired.stderr).toMatch(/not in an OS keychain/)
    expect(paired).toMatchObject({ code: 0 })
    expect(paired.stdout).toMatch(/^Paired with machine-[0-9a-f]{32} as device device-[0-9a-f]{32}\. Credential stored in the file\.$/m)
    expect(paired.stdout + paired.stderr).not.toContain(credential)

    const status = await runCli(["status", "--daemon", url, "--credential-file", credentialFile])
    expect(status).toMatchObject({ code: 0 })
    expect(status.stdout).toMatch(/^daemon\s+\S/m)
    expect(status.stdout).toMatch(/^endpoint\s+ws:\/\//m)
    expect(status.stdout).toMatch(/^sessions\s+\d+/m)
  })

  it("refuses status without a pairing, and refuses a wrong credential without keeping it", async () => {
    const credentialFile = join(home!, "empty-credentials.json")
    expect(await runCli(["status", "--daemon", url, "--credential-file", credentialFile])).toMatchObject({ code: 2 })
    const wrong = await runCli(["pair", "--daemon", url, "--credential-file", credentialFile], `${"x".repeat(43)}\n`)
    expect(wrong).toMatchObject({ code: 1 })
    expect(wrong.stderr).toMatch(/authentication failed/i)
    expect(await runCli(["status", "--daemon", url, "--credential-file", credentialFile])).toMatchObject({ code: 2 })
  })

  it("doctor reports the daemon, credential and protocol probes against a real daemon", async () => {
    const credentialFile = join(home!, "doctor-credentials.json")
    const credential = await mintClientCredential()
    expect(await runCli(["pair", "--daemon", url, "--credential-file", credentialFile], `${credential}\n`)).toMatchObject({ code: 0 })
    const doctor = await runCli(["doctor", "--daemon", url, "--credential-file", credentialFile])
    expect(doctor.stdout).toMatch(/^ok {3}daemon {6}\S/m)
    expect(doctor.stdout).toMatch(/^ok {3}credential {2}accepted as device device-[0-9a-f]{32} \(cli\)$/m)
    expect(doctor.stdout).toMatch(/^ok {3}protocol {4}client \d+\.\d+\.\d+, daemon \d+\.\d+\.\d+; negotiation: unknown/m)
    expect(doctor.stdout).toMatch(/^doctor: no problems found$/m)
    expect(doctor.code).toBe(0)

    const logs = await runCli(["logs", "--daemon", url, "--credential-file", credentialFile, "--limit", "5"])
    expect(logs.code).toBe(0)
    expect(logs.stdout).toMatch(/device\.(pair|claim|current)|system\.hello/)
    expect(logs.stdout).not.toMatch(/follow/)
  })

  it("skill install previews a real directory and refuses a relative path", async () => {
    const credentialFile = join(home!, "skill-credentials.json")
    const credential = await mintClientCredential()
    expect(await runCli(["pair", "--daemon", url, "--credential-file", credentialFile], `${credential}\n`)).toMatchObject({ code: 0 })
    const skill = join(home!, "skills", "pr-triage")
    const { mkdir, writeFile } = await import("node:fs/promises")
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, "SKILL.md"), "---\nname: pr-triage\ndescription: Triage pull requests\n---\n\nTriage.\n")
    const relative = await runCli(["skill", "install", "skills/pr-triage", "--daemon", url, "--credential-file", credentialFile])
    expect(relative.code).toBe(2)
    const declined = await runCli(["skill", "install", skill, "--daemon", url, "--credential-file", credentialFile], "n\n")
    expect(declined.stdout).toMatch(/^skill {6}pr-triage/m)
    expect(declined.stdout).toMatch(/^not installed$/m)
    expect(declined.code).toBe(1)
  })

  it("refuses surplus arguments before any connection, even with --yes", async () => {
    const surplus = await runCli(["skill", "install", join(home!, "skills", "pr-triage"), "extra", "--yes", "--daemon", "ws://127.0.0.1:1/rpc", "--credential-file", join(home!, "unused.json")])
    expect(surplus.code).toBe(2)
    expect(surplus.stderr).toMatch(/takes no further arguments; got "extra"/)
    expect(await runCli(["doctor", "now", "--daemon", "ws://127.0.0.1:1/rpc", "--credential-file", join(home!, "unused.json")])).toMatchObject({ code: 2 })
  })

  it("refuses a credential passed as an argument", async () => {
    const result = await runCli(["pair", "x".repeat(43), "--daemon", url, "--credential-file", join(home!, "unused.json")])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/stdin, not as an argument/)
  })
})
