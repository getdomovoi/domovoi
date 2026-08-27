import type { ClientKind } from "@getdomovoi/protocol"

export type BrowserDeviceProfile = {
  coarsePointer: boolean
  maxTouchPoints: number
  platform: string
  userAgent: string
  viewportWidth: number
}

export function clientKindForBrowser(profile: BrowserDeviceProfile): ClientKind {
  if (/iPhone|iPod/i.test(profile.userAgent)) return "phone"
  if (/iPad/i.test(profile.userAgent)) return "tablet"
  if (profile.platform === "MacIntel" && profile.maxTouchPoints > 1) return "tablet"
  if (/Android/i.test(profile.userAgent)) {
    return /Mobile/i.test(profile.userAgent) ? "phone" : "tablet"
  }
  if (!profile.coarsePointer) return "web"
  return profile.viewportWidth < 768 ? "phone" : "tablet"
}
