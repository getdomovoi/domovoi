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
