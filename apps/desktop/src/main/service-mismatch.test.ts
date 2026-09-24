import type { LocalDaemonHandle } from "@getdomovoi/daemon"
import { describe, expect, it, vi } from "vitest"

import { withServiceMismatch } from "./service-mismatch.js"

// Ruled 2026-09-23 (#577, A): when the owner speaks a protocol this app
// cannot, and a login service is installed, the refusal names the runtime the
// service runs, read from its definition, or says it is older when that is
// not known.
describe("withServiceMismatch", () => {
  const options = { mode: "attach-only" as const, timeoutMs: 1_000 }
  const incompatible: LocalDaemonHandle = { kind: "refused", reason: "owner-incompatible", message: "The local daemon uses an incompatible protocol. Update the daemon and Desktop, then reconnect." }

  it("names the version the login service runs", async () => {
    const seam = withServiceMismatch(async () => incompatible, async () => ({ installed: true, version: "0.9.2" }))
    await expect(seam(options)).resolves.toMatchObject({ kind: "refused", reason: "owner-incompatible", message: "The login service runs Domovoi 0.9.2, which this app cannot talk to. Update the service to match this app." })
  })

  it("says the service is older when its version is not known", async () => {
    const seam = withServiceMismatch(async () => incompatible, async () => ({ installed: true }))
    await expect(seam(options)).resolves.toMatchObject({ message: "The login service runs an older Domovoi, which this app cannot talk to. Update the service to match this app." })
  })

  it("keeps the daemon's words when no login service is installed, or the read fails", async () => {
    await expect(withServiceMismatch(async () => incompatible, async () => ({ installed: false }))(options)).resolves.toEqual(incompatible)
    await expect(withServiceMismatch(async () => incompatible, async () => { throw new Error("unreadable") })(options)).resolves.toEqual(incompatible)
  })

  it("does not read the service for any other outcome", async () => {
    const read = vi.fn()
    const busy: LocalDaemonHandle = { kind: "refused", reason: "owner-busy", message: "busy" }
    await expect(withServiceMismatch(async () => busy, read)(options)).resolves.toEqual(busy)
    expect(read).not.toHaveBeenCalled()
  })
})
