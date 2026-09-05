import type { DaemonRefusalReason } from "../../shared/daemon-acquisition.js"
import type { DesktopDaemonConnection } from "./desktop-startup.js"

export type DesktopDaemonCopy = {
  title: string
  detail: string
}

export function daemonConnectionCopy(daemon: DesktopDaemonConnection): DesktopDaemonCopy {
  if (daemon.kind === "owned") {
    return {
      title: "Running Domovoi inside this app",
      detail: "This app started the local daemon and stops it when the app quits.",
    }
  }
  if (daemon.owner === "daemon") {
    return {
      title: "Connected to the installed Domovoi service",
      detail: "The daemon runs outside this app and keeps running after it quits.",
    }
  }
  return {
    title: "Connected to the daemon another Domovoi Desktop started",
    detail: "That app owns the daemon and stops it when it quits.",
  }
}

const refusalTitles: Record<DaemonRefusalReason, string> = {
  "owner-busy": "The local daemon is changing owners",
  "owner-unreachable": "No local daemon answered",
  "owner-incompatible": "The local daemon and this app need an update",
  "owner-unverified": "The local daemon could not be verified",
  "profile-invalid": "The local daemon profile is invalid",
}

export function daemonRefusalCopy(refusal: { reason: DaemonRefusalReason; message: string }): DesktopDaemonCopy {
  return { title: refusalTitles[refusal.reason], detail: refusal.message }
}
