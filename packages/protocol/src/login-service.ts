// The names the daemon's per-user login service is installed under. The
// daemon's installer writes these and a client that describes the service
// reads them from here, so the two cannot drift apart.
export const loginServiceUnitFile = "domovoid.service"
export const loginServiceAgentLabel = "sh.domovoi.domovoid"
export const loginServiceTaskName = "Domovoi daemon"

// Where the service definition lives, relative to the installing user's home.
// Windows registers a logon task by name and writes no definition file.
export const loginServiceHomePaths = {
  linux: `.config/systemd/user/${loginServiceUnitFile}`,
  darwin: `Library/LaunchAgents/${loginServiceAgentLabel}.plist`,
} as const

// The version that names a published runtime copy's directory,
// <profile>/runtime/<version>/<id>: a release version as package.json holds it
// (semver), at most 64 characters, so it is exactly one directory name, with
// no separator, no "." or ".." and nothing a platform reserves. The desktop
// publishes only under such a name, and the daemon reads a service's runtime
// version back only from one (security review round 8 of #577).
const runtimeVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function isLoginServiceRuntimeVersion(version: string): boolean {
  return version.length <= 64 && runtimeVersionPattern.test(version)
}
