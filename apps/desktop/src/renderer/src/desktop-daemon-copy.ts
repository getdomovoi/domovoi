import type { DaemonRefusalReason } from "../../shared/daemon-acquisition.js"
import type { DesktopDaemonConnection } from "./desktop-startup.js"

export type DesktopDaemonCopy = {
  inApp?: boolean
  title: string
  detail: string
  owner?: "app" | "other-app" | "outside"
}

export function daemonConnectionCopy(daemon: DesktopDaemonConnection): DesktopDaemonCopy {
  if (daemon.kind === "owned") {
    return {
      title: "Running Domovoi inside this app",
      detail: "This app started the local daemon and stops it when the app quits.",
      inApp: true,
      owner: "app",
    }
  }
  if (daemon.owner === "daemon") {
    return {
      title: "Connected to the installed Domovoi service",
      detail: "The daemon runs outside this app and keeps running after it quits.",
      owner: "outside",
    }
  }
  return {
    title: "Connected to the daemon another Domovoi Desktop started",
    detail: "That app owns the daemon and stops it when it quits.",
    owner: "other-app",
  }
}

const refusalTitles: Record<DaemonRefusalReason, string> = {
  "owner-busy": "The local daemon is changing owners",
  "owner-unreachable": "No local daemon answered",
  "owner-incompatible": "The local daemon and this app need an update",
  "owner-unverified": "The local daemon could not be verified",
  "profile-invalid": "The local daemon profile is invalid",
  "port-in-use": "The local daemon's port is in use",
  "state-locked": "Another process holds this profile's state",
  "identity-mismatch": "The stored workspace belongs to another machine identity",
}

export function daemonRefusalCopy(refusal: { reason: DaemonRefusalReason; message: string }): DesktopDaemonCopy {
  return { title: refusalTitles[refusal.reason], detail: refusal.message }
}
