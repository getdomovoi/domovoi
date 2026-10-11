import { spawn } from "node:child_process"
import { once } from "node:events"
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { encodePairingPayload, protocolVersion } from "@getdomovoi/protocol"
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

// What `domovoid pair --client cli` does on the daemon
// host: device.issueCode with the daemon's own token, then the payload it
// prints under "Cannot scan it? Paste this on the device:".
async function issueCliCode(targetClient: "cli" | "phone" = "cli"): Promise<{ payload: string; code: string }> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${rootToken}` } })
  await once(socket, "open")
  type Issued = { code: string; pairingAddress: { url: string; label?: string } | { problem: string } }
  const reply = await new Promise<{ result?: Issued; error?: { message: string } }>((resolve, reject) => {
    socket.on("message", (data: { toString(): string }) => {
      const message = JSON.parse(data.toString()) as { id?: unknown; result?: Issued; error?: { message: string } }
      if (message.id === 2) resolve(message)
    })
    socket.once("error", reject)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system.hello", params: { client: "cli", clientVersion: "test", protocolVersion } }))
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "device.issueCode", params: { targetClient } }))
  })
  socket.terminate()
  if (!reply.result) throw new Error(reply.error?.message ?? "no code")
  const address = reply.result.pairingAddress
  if ("problem" in address) throw new Error(address.problem)
  const code = reply.result.code
  return { code, payload: encodePairingPayload({ v: 1, url: address.url, code, ...(address.label === undefined ? {} : { label: address.label }) }) }
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

// The daemon admits three pairing claims per source per minute, counting the
// ones that succeed, so this file redeems at most twice and the later tests
// read the credential the first one stored.
const pairedCredentialFile = () => join(home!, "cli-credentials.json")

describe("domovoi against a real daemon", { timeout: 30_000 }, () => {
  it("pairs from a pasted pairing code, stores the credential in the named file, and reads status back", async () => {
    const credentialFile = pairedCredentialFile()
    const issued = await issueCliCode()
    // No --daemon: the payload names the address, as it does for a phone.
    const paired = await runCli(["pair", "--credential-file", credentialFile, "--label", "e2e cli"], `Cannot scan it? Paste this on the device:\n${issued.payload}\n`)
    expect(paired.stderr).toMatch(/not in an OS keychain/)
    expect(paired).toMatchObject({ code: 0 })
    expect(paired.stdout).toMatch(/^Paired with machine-[0-9a-f]{32} at ws:\/\/\S+\/rpc as e2e cli \(cli\), device device-[0-9a-f]{32}\. Credential stored in the file\.$/m)
    // The payload's address is the record's key; it is not the default, so
    // the line says what later commands need (the fixture binds a free port).
    expect(paired.stdout).toContain(` at ${url} as `)
    expect(paired.stdout).toMatch(/^The default daemon is ws:\/\/127\.0\.0\.1:47831\/rpc, so later commands need --daemon ws:\/\/\S+\/rpc\.$/m)
    expect(paired.stdout + paired.stderr).not.toContain(issued.code)

    const status = await runCli(["status", "--daemon", url, "--credential-file", credentialFile])
    expect(status).toMatchObject({ code: 0 })
    expect(status.stdout).toMatch(/^daemon\s+\S/m)
    expect(status.stdout).toMatch(/^endpoint\s+ws:\/\//m)
    expect(status.stdout).toMatch(/^sessions\s+\d+/m)
  })

  it("refuses status without a pairing, and refuses a code the daemon will not take without keeping anything", async () => {
    const credentialFile = join(home!, "empty-credentials.json")
    const unpaired = await runCli(["status", "--daemon", url, "--credential-file", credentialFile])
    expect(unpaired).toMatchObject({ code: 5 })
    expect(unpaired.stderr).toMatch(/^Not paired with ws:\/\//m)
    // Since #767 domovoid pair takes --label as an optional suggested name, so
    // the message names the daemon command as it runs.
    expect(unpaired.stderr).toContain("Run 'domovoid pair --client cli' where the daemon runs, then paste its pairing code into 'domovoi pair --daemon ")
    const wrong = await runCli(["pair", "--daemon", url, "--credential-file", credentialFile], "hearth-quiet-ember-42\n")
    expect(wrong).toMatchObject({ code: 1 })
    expect(wrong.stderr).toMatch(/Pairing was refused/)
    expect(await runCli(["status", "--daemon", url, "--credential-file", credentialFile])).toMatchObject({ code: 5 })
  })

  it("names the daemon's pair command in help as it runs, with no label", async () => {
    const help = await runCli(["--help"])
    expect(help).toMatchObject({ code: 0 })
    expect(help.stderr).toContain("the daemon, run 'domovoid pair --client cli'. It prints a")
    expect(help.stderr).not.toContain("--client cli --label")
  })

  it("exits 3 when no daemon answers, before anything is sent", async () => {
    const unreachable = await runCli(["pair", "--daemon", "ws://127.0.0.1:1/rpc", "--credential-file", join(home!, "unused.json")], "hearth-quiet-ember-42\n")
    expect(unreachable.code).toBe(3)
    expect(unreachable.stderr).toMatch(/Could not reach ws:\/\/127\.0\.0\.1:1\/rpc/)
  })

  it("doctor reports the daemon, credential and protocol probes against a real daemon", async () => {
    const credentialFile = pairedCredentialFile()
    const doctor = await runCli(["doctor", "--daemon", url, "--credential-file", credentialFile])
    expect(doctor.stdout).toMatch(/^ok {3}daemon {6}\S/m)
    expect(doctor.stdout).toMatch(/^ok {3}credential {2}accepted as device device-[0-9a-f]{32} \(cli\)$/m)
    expect(doctor.stdout).toMatch(/^ok {3}protocol {4}client \d+\.\d+\.\d+, daemon \d+\.\d+\.\d+; compatible: major and minor match, patch may differ/m)
    expect(doctor.stdout).toMatch(/^doctor: no problems found$/m)
    expect(doctor.code).toBe(0)

    const logs = await runCli(["logs", "--daemon", url, "--credential-file", credentialFile, "--limit", "5"])
    expect(logs.code).toBe(0)
    expect(logs.stdout).toMatch(/device\.(redeemCode|claim|current)|system\.hello/)
    expect(logs.stdout).not.toMatch(/follow/)
  })

  it("skill install previews a real directory and refuses a relative path", async () => {
    const credentialFile = pairedCredentialFile()
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

  it("refuses a label the daemon would refuse before any connection, so no admission is spent", async () => {
    // An unreachable address: reaching it would exit 3, so a 2 proves the
    // label was refused first.
    const long = await runCli(["pair", "--label", "x".repeat(129), "--daemon", "ws://127.0.0.1:1/rpc", "--credential-file", join(home!, "unused.json")], "hearth-quiet-ember-42\n")
    expect(long.code).toBe(2)
    expect(long.stderr).toMatch(/^--label takes at most 128 characters$/m)
  })

  it("refuses a pairing code passed as an argument", async () => {
    const result = await runCli(["pair", "hearth-quiet-ember-42", "--daemon", url, "--credential-file", join(home!, "unused.json")])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/stdin, not as an argument/)
  })
})

// `domovoi daemon` runs the daemon package's own installer (ruling Q3 B). The
// OS boundary is the daemon's manager shim, preloaded into the CLI process: it
// answers systemctl, launchctl, loginctl and Task Scheduler from a log, so the
// real files and launch command are written into a scratch home and no real
// service is installed. Every DOMOVOI_ setting of the shell running the tests
// is dropped, so the live profile is never read or written.
const daemonEntry = resolve(import.meta.dirname, "../../daemon/dist/index.js")
const managerShim = pathToFileURL(resolve(import.meta.dirname, "../test-fixtures/service-manager.mjs")).href

// Node 22 announces node:sqlite on stderr, for domovoid as well (ruling Q32 A).
const sqliteNotice = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature[^\n]*\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n)?/gmu
const withoutNotice = (stderr: string) => stderr.replace(sqliteNotice, "")

async function serviceHome(): Promise<{ home: string; environment: NodeJS.ProcessEnv; done: () => Promise<void> }> {
  // Real path: macOS reaches the temporary directory through /var, a link.
  const home = await realpath(await mkdtemp(join(tmpdir(), "domovoi-cli-daemon-")))
  const environment: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(environment)) if (key.startsWith("DOMOVOI_")) delete environment[key]
  Object.assign(environment, {
    HOME: home, USERPROFILE: home, XDG_STATE_HOME: join(home, ".local", "state"),
    DOMOVOI_TEST_SERVICE_HOME: home, DOMOVOI_TEST_MANAGER_LOG: join(home, "manager.jsonl"),
  })
  return { home, environment, done: () => rm(home, { recursive: true, force: true }) }
}

function runWithShim(program: string[], environment: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(program[0]!, program.slice(1), { env: environment, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString() })
    child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString() })
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr: withoutNotice(stderr) }))
  })
}

const domovoi = (args: string[], environment: NodeJS.ProcessEnv) => runWithShim([process.execPath, "--import", managerShim, cli, "daemon", ...args], environment)
const domovoid = (args: string[], environment: NodeJS.ProcessEnv) => runWithShim([process.execPath, "--import", managerShim, daemonEntry, "service", ...args], environment)

// What the service manager was told to run: the unit, the launch agent, or the
// program and arguments the COM registration received.
async function registeredLaunch(home: string): Promise<string> {
  if (process.platform === "win32") {
    const commands = (await readFile(join(home, "manager.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { command: string; args: string[] })
    const create = commands.findLast(({ command, args }) => command.endsWith("powershell.exe") && Buffer.from(args.at(-1)!, "base64").toString("utf16le").includes("$folder.RegisterTaskDefinition("))!
    return registeredTaskCommand(create.args)
  }
  return readFile(process.platform === "darwin"
    ? join(home, "Library", "LaunchAgents", "sh.domovoi.domovoid.plist")
    : join(home, ".config", "systemd", "user", "domovoid.service"), "utf8")
}

describe("domovoi daemon", { timeout: 60_000 }, () => {
  it("refuses a verb it does not have, and surplus words, before anything runs", async () => {
    const { home, environment, done } = await serviceHome()
    try {
      for (const [args, refusal] of [
        [[], /^domovoi daemon takes one of install, status or remove\n/],
        [["start"], /^domovoi daemon takes one of install, status or remove; got "start"\n/],
        [["install", "now"], /^domovoi daemon install takes no further arguments; got "now"\n/],
        [["status", "--verbose"], /^Unknown option --verbose\n/],
        // The service is this machine's: no option names another daemon, so
        // none is accepted and silently dropped (review round 1, Major).
        [["remove", "--daemon", "ws://203.0.113.7:47831/rpc"], /^domovoi daemon remove acts on this machine's login service and takes no options; got --daemon\n/],
        [["install", "--credential-file", join(home, "x.json"), "--yes"], /^domovoi daemon install acts on this machine's login service and takes no options; got --credential-file, --yes\n/],
      ] as const) {
        const refused = await domovoi([...args], environment)
        expect(refused.code, args.join(" ")).toBe(2)
        expect(refused.stderr).toMatch(refusal)
        expect(refused.stderr).toContain("domovoi daemon install|status|remove")
      }
      await expect(readFile(join(home, "manager.jsonl"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally { await done() }
  })

  it("registers the daemon's own worker entry, never this CLI's", async () => {
    const { home, environment, done } = await serviceHome()
    try {
      const installed = await domovoi(["install"], environment)
      expect(installed.stderr).toBe("")
      expect(installed.code).toBe(0)
      expect(installed.stdout).toMatch(/^Installed the Domovoi daemon service /m)
      const launch = await registeredLaunch(home)
      expect(launch).toContain(await realpath(daemonEntry))
      expect(launch).not.toContain(resolve(import.meta.dirname, "../dist"))
      expect(launch).toContain(process.platform === "win32" ? "--service-supervise" : "--service-config")
      // Q28 A: the follow-up line names the command that was run. The shim
      // answers loginctl, so only a Linux install turns lingering on.
      if (process.platform === "linux") expect(installed.stdout).toMatch(/turns it off again\.$/m)
      if (process.platform === "linux") expect(installed.stdout).toContain(" domovoi daemon remove turns it off again.")
      expect(installed.stdout).not.toContain("domovoid service")
    } finally { await done() }
  })

  // Task Scheduler's status reads supervisor evidence the shim does not
  // produce, so the exit meanings are checked where the manager answers.
  it.skipIf(process.platform === "win32")("keeps domovoid service's exit codes: status 0 while installed, 1 once removed", async () => {
    const { environment, done } = await serviceHome()
    try {
      expect((await domovoi(["status"], environment))).toMatchObject({ code: 1, stdout: expect.stringMatching(/^not installed, not running: /) })
      expect((await domovoi(["install"], environment)).code).toBe(0)
      expect(await domovoi(["status"], environment)).toMatchObject({ code: 0, stderr: "", stdout: expect.stringMatching(/^installed, /) })
      const removed = await domovoi(["remove"], environment)
      expect(removed).toMatchObject({ code: 0, stderr: "", stdout: expect.stringMatching(/^Removed the Domovoi daemon service /) })
      expect((await domovoi(["status"], environment))).toMatchObject({ code: 1, stdout: expect.stringMatching(/^not installed, not running: /) })
      // The same answers from domovoid, the daemon's own entry.
      expect((await domovoid(["status"], environment)).code).toBe(1)
    } finally { await done() }
  })

  // Q28 A and Q33 A: profile recovery has no domovoi form, and domovoid may
  // not be on PATH, so through the CLI the line says what domovoid is.
  it.skipIf(process.platform === "win32")("names the command that was run when removal cannot prove the profile owner", async () => {
    const { home, environment, done } = await serviceHome()
    try {
      const unreadableOwner = async () => {
        await mkdir(join(home, ".domovoi"), { recursive: true })
        await writeFile(join(home, ".domovoi", "local-owner.json"), "{not json", { mode: 0o600 })
      }
      expect((await domovoi(["install"], environment)).code).toBe(0)
      await unreadableOwner()
      const throughCli = await domovoi(["remove"], environment)
      expect(throughCli).toMatchObject({ code: 0, stderr: "" })
      expect(throughCli.stdout).toContain(`run domovoid profile recover --confirm-no-supervisor (domovoid is Node running ${await realpath(daemonEntry)}).\n`)

      expect((await domovoid(["install"], environment)).code).toBe(0)
      await unreadableOwner()
      const throughDaemon = await domovoid(["remove"], environment)
      expect(throughDaemon).toMatchObject({ code: 0, stderr: "" })
      expect(throughDaemon.stdout).toContain("run domovoid profile recover --confirm-no-supervisor.\n")
    } finally { await done() }
  })

  // Q31 A: the desktop runtime ships this CLI beside the daemon, without a
  // second daemon copy, and links domovoi into ~/.local/bin through a launcher
  // (apps/desktop/scripts/daemon-runtime.mjs). Through that link, install
  // runs the runtime's daemon, which the daemon recognises as an app's (Q408)
  // and copies under the profile, so the service never runs from inside the
  // app. The desktop writes no launcher on Windows.
  it.skipIf(process.platform === "win32")("from the CLI an app links, registers a copy of the app's daemon, not the app's own", async () => {
    const { home, environment, done } = await serviceHome()
    try {
      const resources = join(home, "Domovoi.app", "Contents", "Resources")
      const runtime = join(resources, "daemon-runtime")
      for (const part of ["daemon", "cli"]) {
        await cp(resolve(import.meta.dirname, `../../${part}/dist`), join(runtime, part, "dist"), { recursive: true })
        await cp(resolve(import.meta.dirname, `../../${part}/package.json`), join(runtime, part, "package.json"))
      }
      // The runtime's Node, standing in for the pinned program it ships.
      await mkdir(join(runtime, "node", "bin"), { recursive: true })
      await writeFile(join(runtime, "node", "bin", "node"), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`)
      await chmod(join(runtime, "node", "bin", "node"), 0o755)
      // Third-party packages resolve from above the runtime, so the copy the
      // install makes holds only what the runtime holds. No @getdomovoi/daemon
      // is reachable from the CLI: only the sibling daemon can answer.
      await symlink(resolve(import.meta.dirname, "../../daemon/node_modules"), join(home, "node_modules"), "dir")
      // The desktop's own launcher writer, so the link runs what the app ships.
      const desktopRuntime = new URL("../../desktop/scripts/daemon-runtime.mjs", import.meta.url).href
      const { writeCommandLaunchers } = await import(desktopRuntime) as { writeCommandLaunchers: (input: { root: string; platform: string }) => Promise<string[]> }
      expect(await writeCommandLaunchers({ root: runtime, platform: process.platform })).toContain("domovoi")
      await mkdir(join(home, ".local", "bin"), { recursive: true })
      await symlink(join(runtime, "bin", "domovoi"), join(home, ".local", "bin", "domovoi"))

      const installed = await runWithShim([join(home, ".local", "bin", "domovoi"), "daemon", "install"], { ...environment, NODE_OPTIONS: `--import=${managerShim}` })
      expect(installed.stderr).toBe("")
      expect(installed.code).toBe(0)
      const versions = join(home, ".domovoi", "runtime", JSON.parse(await readFile(join(runtime, "daemon", "package.json"), "utf8")).version as string)
      const [copy, ...others] = await readdir(versions)
      expect(others).toEqual([])
      expect(installed.stdout).toContain(`Copied the daemon runtime out of the app to ${join(versions, copy!)}, so the service does not run from inside the app.\n`)
      const launch = await registeredLaunch(home)
      expect(launch).toContain(join(versions, copy!, "daemon", "dist", "index.js"))
      expect(launch).not.toContain(runtime)
    } finally { await done() }
  })
})

function registeredTaskCommand(args: string[]) {
  const body = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
  const value = (property: string) => windowsTaskData(body, `$action.${property}`)
  const path = value("Path"), arguments_ = value("Arguments")
  if (path === undefined || arguments_ === undefined) throw new Error("Invalid task registration")
  return `${path} ${arguments_}`
}

// Decode only the data expression emitted by the Windows registration builder.
function windowsTaskData(script: string, property: string): string | undefined {
  const line = script.split("\n").find((line) => line.startsWith(`${property} = `))
  const encoded = / = \[System\.Text\.Encoding\]::UTF8\.GetString\(\[System\.Convert\]::FromBase64String\('([A-Za-z0-9+/=]*)'\)\)$/.exec(line ?? "")?.[1]
  return encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("utf8")
}
