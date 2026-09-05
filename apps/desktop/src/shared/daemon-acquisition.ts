export const daemonRefusalReasons = [
  "owner-busy",
  "owner-unreachable",
  "owner-incompatible",
  "owner-unverified",
  "profile-invalid",
] as const

export type DaemonRefusalReason = (typeof daemonRefusalReasons)[number]

export type DaemonOwner = "daemon" | "desktop"

export type DesktopDaemonAcquisition =
  | { kind: "owned"; url: string; token: string }
  | { kind: "attached"; owner: DaemonOwner; url: string; token: string }
  | { kind: "refused"; reason: DaemonRefusalReason; message: string }

export type DesktopDaemonBridge = {
  acquireDaemon(): Promise<DesktopDaemonAcquisition>
  reacquireDaemon(): Promise<DesktopDaemonAcquisition>
}
