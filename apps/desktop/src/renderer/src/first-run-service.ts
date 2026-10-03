import { installMovesDaemon, type DaemonServiceStatusReport, type DesktopWindowBridge, type FirstRunService } from "@getdomovoi/ui"

// The service as read back after setup installed it. Settings draws the
// service from these until the shell's next own change, rather than from the
// read it took before the install.
export type ServiceFacts = { serviceInstalled?: boolean; serviceRunning?: boolean }

function factsOf(read: DaemonServiceStatusReport | undefined): ServiceFacts {
  if (!read || "unavailable" in read || read.installed === null) return {}
  return { serviceInstalled: read.installed, serviceRunning: read.running }
}

// Q351 A: desktop setup installs the login service through the same bridge
// Settings uses. After an install that may have moved who holds the daemon,
// the window resolves its daemon again (as the shell does after its own
// service changes), carrying the service as read back.
export function desktopFirstRunService({ bridge, owner, endpoint, onDaemonMoved }: {
  bridge: Pick<DesktopWindowBridge, "platform" | "daemonService">
  owner: FirstRunService["owner"]
  // The URL of the daemon this window reached, for setup's attach row.
  endpoint?: string | undefined
  onDaemonMoved: (facts: ServiceFacts) => void
}): FirstRunService | undefined {
  const service = bridge.daemonService
  if (!service) return undefined
  const readBack = () => service.status().catch(() => undefined)
  return {
    owner,
    platform: bridge.platform,
    endpoint,
    install: async () => {
      let outcome
      try {
        outcome = await service.install()
      } catch (cause) {
        const after = await readBack()
        if (after && "installed" in after && after.installed === true) onDaemonMoved(factsOf(after))
        throw cause
      }
      if (installMovesDaemon(outcome)) onDaemonMoved(factsOf(await readBack()))
      return outcome
    },
  }
}
