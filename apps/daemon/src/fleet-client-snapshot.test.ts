import { afterEach, expect, it, vi } from "vitest"

import { fleetProductionHarness } from "./test-fleet-production.js"

const { cleanup, machine, enroll } = fleetProductionHarness()
afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
})

it("stamps daemon time on fleet lists, changes and mutation replies", async () => {
  const source = await machine("source")
  const target = await machine("target")
  const now = Date.now()
  const clock = vi.spyOn(Date, "now").mockReturnValue(now)
  const daemonTime = new Date(now).toISOString()

  expect.soft(await source.root.ok("fleet.list", {})).toMatchObject({ daemonTime })
  expect.soft(await source.root.ok("fleet.list", { includeQuarantined: true })).toMatchObject({ daemonTime })
  source.root.notifications.length = 0
  expect.soft(await enroll(source, target)).toMatchObject({ fleet: { daemonTime } })
  await source.root.ok("workspace.get", {})
  const notices = source.root.notifications.filter((notice) => notice.method === "fleet.changed")
  expect(notices.length).toBeGreaterThan(0)
  for (const notice of notices) expect.soft(notice.params).toMatchObject({ daemonTime })

  clock.mockReturnValue(now + 60_000)
  expect.soft(await source.root.ok("fleet.forget", { machineId: target.id, client: "cli" }))
    .toMatchObject({ fleet: { daemonTime: new Date(now + 60_000).toISOString() } })
}, 30_000)
