import { once } from "node:events"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { WebSocket } from "ws"
import { protocolVersion } from "@getdomovoi/protocol"
import { createProductionDaemonWithDependencies, productionDaemonDependencies, type ProductionDaemonHandle } from "./production-daemon.js"
import { claimProfile } from "./profile-lease.js"
import { MachineCredentialStore } from "./machine-credentials.js"
import { asyncTestCredentials } from "./test-machine-credentials.js"
import { removeScratchDirectories } from "./test-scratch.js"

const scratch: string[] = []
const daemons: ProductionDaemonHandle[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await removeScratchDirectories(scratch)
})

it("owns two isolated profiles and authenticates two sockets without changing HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "domovoi-two-profiles-"))
  scratch.push(root)
  const homeDirectory = join(root, "same-home")
  const realHome = process.env.HOME
  const profiles = [join(root, "first"), join(root, "second")]
  for (const profileDirectory of profiles) {
    const daemon = await createProductionDaemonWithDependencies({ homeDirectory,
      environment: { DOMOVOI_PROFILE_DIR: profileDirectory, DOMOVOI_PORT: "0" },
    }, { ...productionDaemonDependencies, createProviderProbe: () => ({ inspect: async () => {
      expect(process.env.HOME).toBe(realHome)
      return []
    } }), wslFacts: () => undefined,
      createMachineCredentials: () => asyncTestCredentials(new MachineCredentialStore({ get: () => undefined, set: () => {}, delete: () => {} })),
    })
    daemons.push(daemon)
    const address = await daemon.start()
    const socket = new WebSocket(address.url)
    sockets.push(socket)
    const signal = AbortSignal.timeout(5_000)
    await once(socket, "open", { signal })
    const reply = once(socket, "message", { signal })
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system.hello", params: {
      client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
    } }))
    const [raw] = await reply
    expect(JSON.parse(String(raw))).toMatchObject({ id: 1, result: { protocolVersion } })
    expect(() => { const unexpected = claimProfile({ profileDirectory }); unexpected.release() }).toThrow(/already owned/)
    expect((await stat(join(profileDirectory, "profile-lease.sqlite"))).isFile()).toBe(true)
    expect((await readFile(join(profileDirectory, "daemon.token"), "utf8")).trim() === daemon.authToken).toBe(true)
    expect((await stat(join(profileDirectory, "state.sqlite"))).isFile()).toBe(true)
  }
  expect(daemons[0]!.authToken === daemons[1]!.authToken).toBe(false)
  expect(process.env.HOME).toBe(realHome)
  await expect(stat(join(homeDirectory, ".domovoi"))).rejects.toMatchObject({ code: "ENOENT" })
  for (const socket of sockets.splice(0)) socket.terminate()
  for (const daemon of daemons.splice(0)) await daemon.stop()
  for (const profileDirectory of profiles) claimProfile({ profileDirectory }).release()
}, 15_000)
