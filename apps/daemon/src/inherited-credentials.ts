// A launcher can hand this process the daemon bearer and its credential path
// through DOMOVOI_AUTH_TOKEN and DOMOVOI_CREDENTIAL_PATH. Every provider, agent
// server and terminal the daemon starts inherits process.env, and the bearer
// resolves approvals, so the values are taken out of process.env the first time
// they are read and kept here. A later acquisition in the same process, such as
// the desktop reacquiring its daemon, gets the same values back instead of
// falling through to a different credential.

const inheritedNames = ["DOMOVOI_AUTH_TOKEN", "DOMOVOI_CREDENTIAL_PATH"] as const

const kept: Partial<Record<(typeof inheritedNames)[number], string>> = {}

export function takeInheritedCredentials(): void {
  for (const name of inheritedNames) {
    const value = process.env[name]
    if (value !== undefined && value !== "") kept[name] = value
    delete process.env[name]
  }
}

// The environment to read settings from: the given one, with the kept bearer
// and path filled in where it no longer carries them.
export function withInheritedCredentials(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  takeInheritedCredentials()
  const filled: NodeJS.ProcessEnv = { ...environment }
  for (const name of inheritedNames) {
    if ((filled[name] === undefined || filled[name] === "") && kept[name] !== undefined) filled[name] = kept[name]
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
