import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

type SmokePath = "userData" | "sessionData" | "logs"

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
