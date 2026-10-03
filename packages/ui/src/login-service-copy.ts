import { loginServiceHomePaths, loginServiceTaskName } from "@getdomovoi/protocol"

import type { DaemonServiceOutcome } from "./desktop-platform.js"

// The login service's names and the lines said after a failed change, shared
// by Settings and desktop first-run setup so both say the same thing. Kept
// apart from settings-shell.tsx, which loads only when Settings opens.

// J24 (2026-09-23). What each platform's login service is. The names come from
// the daemon's installer through login-service; this window only names them.
// Native Windows runs the logon task without the crash supervisor, which only
// the WSL task has (Phase 1 decided to supervise it like WSL).
export const loginServices = {
  darwin: { kind: "LaunchAgent", manager: "launchd", definition: `~/${loginServiceHomePaths.darwin}`, removeLabel: "Unload and delete the LaunchAgent", crash: "launchd starts it again." },
  linux: { kind: "systemd user unit", manager: "systemd", definition: `~/${loginServiceHomePaths.linux}`, removeLabel: "Stop, disable and delete the user unit", crash: "systemd starts it again." },
  win32: { kind: "logon task", manager: "Task Scheduler", definition: `Task Scheduler task "${loginServiceTaskName}"`, removeLabel: "Delete the logon task", crash: "Nothing restarts it until you next sign in." },
} as const

export type LoginServicePlatform = keyof typeof loginServices

// Security review round 1 of #576, lines approved by fetzy on 2026-09-25: a
// failed install or removal the service manager left half done, a read-back
// that could not be taken, or a daemon this app did not start.

export type FailedServiceOutcome = Extract<DaemonServiceOutcome, { ok: false; reason: "failed" }>

export function readBackFact(kind: string, action: "install" | "remove", service: FailedServiceOutcome["service"]): string {
  if (!service || service.installed === null) return `Whether the ${kind} is installed is not known from here.`
  if (action === "install") return service.installed ? `The ${kind} is installed${service.running ? " and running" : " but not running"}.` : "Nothing was installed."
  return service.installed ? `The ${kind} is still installed ${service.running ? "and running" : "but not running"}.` : `The ${kind} is gone, but the removal did not finish.`
}

function daemonFact(daemon: FailedServiceOutcome["daemon"]): string {
  if (daemon === "restarted") return "The daemon is running inside this app again."
  if (daemon === "attached") return "This app is connected to a daemon it did not start."
  if (daemon === "stopped") return "No daemon is running for this app, so no session is running. Quit and reopen Domovoi to start it."
  return "The daemon inside this app was not stopped."
}

// What is still true after a failed install or removal. The approved lines
// hold only when the service read back afterwards shows nothing changed.
export function failedStill(kind: string, action: "install" | "remove", outcome: FailedServiceOutcome): string {
  const service = outcome.service
  if (action === "install" && service?.installed === false && outcome.daemon !== "attached") {
    return outcome.daemon === "restarted"
      ? "The daemon is back inside this app. Nothing else was touched."
      : outcome.daemon === "stopped"
        ? "Nothing was installed. The daemon inside this app stopped and did not start again, so no session is running. Quit and reopen Domovoi to start it."
        : "Nothing was installed."
  }
  if (action === "remove" && service?.installed === true && service.running && outcome.daemon === "untouched") {
    return `Nothing was removed. The ${kind} still holds the daemon, and every session keeps running.`
  }
  return `${readBackFact(kind, action, service)} ${daemonFact(outcome.daemon)}`
}
