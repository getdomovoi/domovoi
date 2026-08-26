import type { DesktopWindowBridge } from "@getdomovoi/ui"

declare global {
  interface Window {
    domovoiDesktop: DesktopWindowBridge
  }
}

export {}
