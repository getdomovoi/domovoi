// The real Desktop app attaches to this production-built owner. Only the
// platform keychain and provider boundary are replaced. No profile is shared
// with an operator, and no agent or billable provider turn is started.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { createProductionDaemonWithDependencies, productionDaemonDependencies } from "../src/production-daemon.ts"
import { MachineCredentialStore } from "../src/machine-credentials.ts"
import { asyncTestCredentials } from "../src/test-machine-credentials.ts"
import { OperationDeadline } from "../src/operation-deadline.ts"
import { callDaemonOnce } from "../src/cli-rpc.ts"

const directory = process.argv[2]
const daemons = []
const timer = setTimeout(() => { console.error("Fleet Desktop backend expired"); process.exit(1) }, 120_000)
const agent = {
  permissionCapabilities: { ask: "read-only", buildAuto: "pre-execution" },
  connect: async () => {}, close: async () => {},
  listModels: async () => [{ provider: "claude-code", id: "claude-opus-5", displayName: "Fixture model", description: "No provider calls", isDefault: true,
    supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high" }],
  startThread: async () => "fixture-thread", stopThread: async () => {}, resumeThread: async () => {},
  startTurn: async () => "fixture-turn", steerTurn: async () => {}, interruptTurn: async () => {}, resolveApproval: () => {}, onEvent: () => () => {},
}
async function machine(label) {
  const values = new Map()
  const store = new MachineCredentialStore({ get: id => values.get(id), set: (id, value) => values.set(id, value), delete: id => values.delete(id) })
  const handle = await createProductionDaemonWithDependencies({ homeDirectory: join(directory, label), machineLabel: label, environment: { DOMOVOI_PORT: "0" } }, {
    ...productionDaemonDependencies,
    createMachineCredentials: () => asyncTestCredentials(store),
    createProviderProbe: () => ({ inspect: async () => [{ id: "claude-code", command: "claude", status: "ready" }] }),
    createDaemon: options => productionDaemonDependencies.createDaemon({ ...options, agents: { "claude-code": agent } }),
  })
  daemons.push(handle)
  const address = await handle.start()
  const rpc = async (method, params) => {
    const deadline = OperationDeadline.start(15_000)
    try { return await callDaemonOnce({ target: address, token: handle.authToken, method, params, deadline }) }
    finally { deadline.clear() }
  }
  const snapshot = await rpc("workspace.get", {})
  return { url: address.url, id: snapshot.machine.id, rpc }
}
let stopping = false
async function stop(code = 0) {
  if (stopping) return
  stopping = true
  clearTimeout(timer)
  const outcomes = await Promise.allSettled(daemons.map(daemon => daemon.stop()))
  process.exit(code || (outcomes.some(outcome => outcome.status === "rejected") ? 1 : 0))
}
process.once("message", message => { if (message === "stop") void stop() })
process.once("disconnect", () => { void stop() })
try {
  const home = await machine("Home")
  const target = await machine("Studio")
  const repo = join(directory, "repository")
  await mkdir(join(repo, ".agents", "skills", "fleet-proof"), { recursive: true })
  await writeFile(join(repo, ".agents", "skills", "fleet-proof", "SKILL.md"), "---\nname: fleet-proof\ndescription: Native client inventory proof\n---\nRead repository files.\n")
  const git = promisify(execFile)
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"], ["add", "."], ["commit", "-m", "fixture"]]) {
    await git("git", args, { cwd: repo, timeout: 15_000 })
  }
  await target.rpc("project.open", { client: "cli", path: repo })
  const session = await target.rpc("session.create", { title: "Remote proof session", client: "cli", runtime: {
    provider: "claude-code", model: "claude-opus-5", reasoning: "high", permissionMode: "build", auto: false,
  } })
  assert.ok(session.activeSessionId)
  const { code } = await target.rpc("device.issueCode", {})
  const enrollment = await home.rpc("fleet.enroll", { client: "cli", endpoint: target.url, code, expectedMachineId: target.id, sourceDeviceLabel: "Home" })
  assert.equal(enrollment.outcome, "enrolled")
  assert.equal((await home.rpc("skill.inventory", {})).skills.length, 0)
  assert.deepEqual((await target.rpc("skill.inventory", {})).skills.map(skill => skill.name), ["fleet-proof"])
  const grant = await target.rpc("device.pair", { client: "cli", targetClient: "desktop", label: "Proof desktop" })
  // The IPC payload stays in the supervising process, not logs or a file.
  process.send({ ready: true, machineId: target.id, deviceId: grant.device.id, credential: grant.token })
} catch (error) { console.error(error); await stop(1) }
