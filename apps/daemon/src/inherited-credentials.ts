import { configuredProfileDirectory, profileLocation, sameProfileDirectory, type ProfileLocation } from "./profile-directory.js"

// A launcher can hand this process the daemon bearer and its credential path
// through DOMOVOI_AUTH_TOKEN and DOMOVOI_CREDENTIAL_PATH. Every provider, agent
// server and terminal the daemon starts inherits process.env, and the bearer
// resolves approvals, so the values are taken out of process.env the first time
// they are read and kept here. A later acquisition in the same process, such as
// the desktop reacquiring its daemon, gets the same values back instead of
// falling through to a different credential.
//
// The kept values belong to the profile the process environment named when it
// carried them. Only a later read of process.env itself for that same profile
// gets them back. Another profile loads its own credential, and an environment
// the caller built itself is read as given.

const inheritedNames = ["DOMOVOI_AUTH_TOKEN", "DOMOVOI_CREDENTIAL_PATH"] as const

type KeptCredentials = {
  profile: ProfileLocation
  values: Partial<Record<(typeof inheritedNames)[number], string>>
}

const kept: KeptCredentials[] = []

function profileOf(environment: NodeJS.ProcessEnv, homeDirectory: string): ProfileLocation | undefined {
  try {
    return profileLocation(homeDirectory, configuredProfileDirectory(environment.DOMOVOI_PROFILE_DIR, homeDirectory))
  } catch {
    // An invalid profile setting fails where the settings are parsed; nothing
    // is kept for it or filled into it.
    return undefined
  }
}

function keptFor(profile: ProfileLocation): KeptCredentials | undefined {
  return kept.find((entry) => sameProfileDirectory(entry.profile, profile))
}

function takeInheritedCredentials(homeDirectory: string): void {
  const values: KeptCredentials["values"] = {}
  for (const name of inheritedNames) {
    const value = process.env[name]
    if (value !== undefined && value !== "") values[name] = value
  }
  if (Object.keys(values).length > 0) {
    const profile = profileOf(process.env, homeDirectory)
    if (profile !== undefined) {
      const existing = keptFor(profile)
      if (existing) existing.values = values
      else kept.push({ profile, values })
    }
  }
  for (const name of inheritedNames) delete process.env[name]
}

// The environment to read settings from. process.env itself gets back the
// bearer and path kept for the profile it names; any other environment is
// returned as given.
export function withInheritedCredentials(environment: NodeJS.ProcessEnv, homeDirectory: string): NodeJS.ProcessEnv {
  takeInheritedCredentials(homeDirectory)
  const filled: NodeJS.ProcessEnv = { ...environment }
  if (environment !== process.env) return filled
  const profile = profileOf(filled, homeDirectory)
  const entry = profile === undefined ? undefined : keptFor(profile)
  if (!entry) return filled
  for (const name of inheritedNames) {
    const value = entry.values[name]
    if (value !== undefined) filled[name] = value
  }
  return filled
}

// The same environment for anything that is not reading settings, with the
// bearer and path removed even from a copy taken before they were scrubbed.
export function withoutInheritedCredentials(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped: NodeJS.ProcessEnv = { ...environment }
  for (const name of inheritedNames) delete stripped[name]
  return stripped
}
