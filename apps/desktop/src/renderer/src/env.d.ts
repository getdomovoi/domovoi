import type { DesktopWindowBridge } from "@getdomovoi/ui"

declare global {
  interface Window {
    domovoiDesktop: DesktopWindowBridge
    domovoiLaunchSmoke?: {
      ready(): void
    }
  }
}

export {}
