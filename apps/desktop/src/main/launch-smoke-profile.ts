import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

type SmokePath = "userData" | "sessionData" | "logs"

// T24: test-only. The login-service calls take the service-operation lease
// under the account's passwd home (the daemon's nodeServiceEffects), which a
// smoke's HOME cannot move, so a status read from Settings wrote the real
// ~/.domovoi. The unpackaged smokes pass this switch to turn those calls off.
// It is read from the command line only, never the environment, and a
// packaged app ignores it, so no shipped build can lose its lease this way.
export const loginServiceOffSwitch = "--domovoi-test-no-login-service"

export function loginServiceTurnedOff({ isPackaged, argv }: { isPackaged: boolean; argv: readonly string[] }): boolean {
  return !isPackaged && argv.includes(loginServiceOffSwitch)
}

export function configureLaunchSmokeProfile(
  app: { setPath(name: SmokePath, path: string): void },
  profile: string | undefined,
  homeDirectory: string,
): void {
  if (!profile || resolve(profile) !== resolve(homeDirectory) || existsSync(join(profile, ".domovoi"))) {
    throw new Error("Desktop launch smoke requires its own empty profile from scripts/launch-smoke.mjs")
  }
  // HOME does not define Electron's paths on every host. Set them before the
  // single-instance lock or default session can touch the real app profile.
  app.setPath("userData", join(profile, "config"))
  app.setPath("sessionData", join(profile, "data"))
  app.setPath("logs", join(profile, "data"))
}
