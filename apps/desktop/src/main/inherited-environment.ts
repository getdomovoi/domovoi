import type { InheritedCredentialValues } from "@getdomovoi/daemon"

// The first import of the desktop main process, so this runs before any other
// module of the app: before the startup callback, before any window, daemon,
// terminal or helper exists to inherit process.env. The daemon bearer, its
// credential path and the relay credential file leave process.env here, with
// this module's own code: the daemon loads later, at run time, from the
// runtime the app ships (#577), so nothing of it is imported here. The values
// are held in memory until that daemon loads, then handed to its own capture
// (daemon-module.ts), which pins them to their profile for the daemon's
// acquisition. Limit (owner ruling 2026-09-26): the profile is pinned at
// daemon load, not here. The development daemon token leaves process.env too,
// and only the development seam reads it back.
const inheritedCredentialNames = ["DOMOVOI_AUTH_TOKEN", "DOMOVOI_CREDENTIAL_PATH", "DOMOVOI_RELAY_CREDENTIAL_FILE"] as const
let held: Partial<Record<(typeof inheritedCredentialNames)[number], string>> = {}
for (const name of inheritedCredentialNames) {
  const value = process.env[name]
  if (value !== undefined && value !== "") held[name] = value
  delete process.env[name]
}
const developmentDaemonTokenVariable = "DOMOVOI_DEV_DAEMON_TOKEN"
const developmentDaemonToken = process.env[developmentDaemonTokenVariable]
delete process.env[developmentDaemonTokenVariable]

// The held values, once: this module keeps no copy after the hand-over.
export function takeInheritedCredentials(): InheritedCredentialValues {
  const taken = held
  held = {}
  return taken
}

// The environment the development loop decides from: process.env plus the
// development daemon token it was started with. Never passed to a child.
export function developmentEnvironment(): NodeJS.ProcessEnv {
  return developmentDaemonToken === undefined
    ? process.env
    : { ...process.env, [developmentDaemonTokenVariable]: developmentDaemonToken }
}
