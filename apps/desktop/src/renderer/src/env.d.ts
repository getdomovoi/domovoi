import type { DesktopWindowBridge } from "@getdomovoi/ui"

import type { DesktopDaemonBridge } from "../../shared/daemon-acquisition.js"

declare global {
  interface Window {
    domovoiDesktop: DesktopWindowBridge & DesktopDaemonBridge
    domovoiLaunchSmoke?: {
      ready(): void
    }
  }
}

export {}
