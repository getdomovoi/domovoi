import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { demoWorkspace, protocolVersion } from "@getdomovoi/protocol"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { acquireLocalDaemon } from "./local-daemon.js"
import { CliProviderProbe } from "./providers.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"

// The desktop starts its daemon through acquisition. State a newer daemon
// wrote is refused, and the refusal the desktop shows is the store's own copy,
// with the path and both versions, not a generic profile message.

const homes: string[] = []
beforeEach(() => { vi.spyOn(CliProviderProbe.prototype, "inspect").mockResolvedValue([]) })
afterEach(async () => {
  await removeScratchDirectories(homes)
  vi.restoreAllMocks()
})

it("refuses newer state with the store's own message", async () => {
  const home = await mkdtemp(join(tmpdir(), "domovoi-acquire-newer-"))
  homes.push(home)
  const profile = join(home, ".domovoi")
  await mkdir(profile, { recursive: true, mode: 0o700 })
  const statePath = join(profile, "state.sqlite")
  await new SqliteWorkspaceStore(statePath, demoWorkspace).close()
  const [major, minor] = protocolVersion.split(".").map(Number)
  const stored = `${major}.${minor! + 1}.0`
  const newer = structuredClone(demoWorkspace) as unknown as Record<string, unknown>
  newer.protocolVersion = stored
  const database = new DatabaseSync(statePath)
  database.prepare("UPDATE workspace_state SET snapshot = ? WHERE id = 1").run(JSON.stringify(newer))
  database.close()

  const handle = await acquireLocalDaemon({ environment: { DOMOVOI_PORT: "0" }, homeDirectory: home, mode: "start-or-attach", timeoutMs: 20_000 })
  expect(handle).toEqual({
    kind: "refused",
    reason: "profile-invalid",
    message: `Domovoi state at ${statePath} was written by a newer daemon (protocol ${stored}), and this daemon speaks protocol ${protocolVersion}. It was left as it is and this daemon did not start. Run the newer Domovoi again, or update this one to protocol ${major}.${minor! + 1} or later.`,
  })
})
