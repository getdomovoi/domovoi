import { realpathSync } from "node:fs"
import { posix, resolve, win32 } from "node:path"

// Strings retain the existing home-based API; an explicit profile is never HOME.
// Trade: a home string silently selects its default profile. New profile-aware
// callers must pass the object form; audit callers when adding profile paths.
export type ProfileLocation = string | { profileDirectory: string }

// platform: the platform whose path rules apply, when it is not this
// process's (a service is checked by its own platform's rules).
export function profileLocation(home: string, directory?: string, platform?: string): ProfileLocation {
  return directory === undefined || directory === profileDirectory(home, platform) ? home : { profileDirectory: directory }
}

export function profileDirectory(location: ProfileLocation, platform?: string): string {
  if (typeof location !== "string") return location.profileDirectory
  const windows = platform === "win32" || (platform === undefined
    && (process.platform === "win32" || (win32.isAbsolute(location) && !posix.isAbsolute(location))))
  return (windows ? win32 : posix).join(location, ".domovoi")
}

export function configuredProfileDirectory(value: string | undefined, home: string): string {
  if (value === undefined) return profileDirectory(home)
  const paths = win32.isAbsolute(home) && !posix.isAbsolute(home) ? win32 : posix
  if (!paths.isAbsolute(value) || value.length > 4096 || /[\0\r\n]/u.test(value)) {
    throw new Error("DOMOVOI_PROFILE_DIR must be an absolute directory path")
  }
  return value
}

// platform: the platform whose path rules apply. A directory is resolved on
// disk only when those rules are this process's; otherwise the paths are
// compared by the platform's own rules. Windows paths compare without case.
// No platform keeps this process's rules, as before.
export function sameProfileDirectory(left: ProfileLocation, right: ProfileLocation, platform?: string): boolean {
  const windows = platform === "win32"
  const local = platform === undefined || windows === (process.platform === "win32")
  // Security review round 13 of #577 (P2): posix follows a link before its
  // "..", so link/../victim names victim beside the link's target. This host
  // cannot follow links on another machine, so there a posix path with a ".."
  // segment matches only the same text, never its lexical collapse.
  if (!local && !windows) {
    const leftDirectory = profileDirectory(left, platform)
    const rightDirectory = profileDirectory(right, platform)
    const dotDot = (directory: string) => directory.split("/").includes("..")
    if (dotDot(leftDirectory) || dotDot(rightDirectory)) return leftDirectory === rightDirectory
  }
  const canonical = (location: ProfileLocation) => {
    const directory = profileDirectory(location, platform)
    let resolved: string
    if (!local) resolved = (windows ? win32 : posix).resolve(directory)
    else {
      try { resolved = realpathSync.native(directory) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        resolved = resolve(directory)
      }
    }
    return windows ? resolved.toLowerCase() : resolved
  }
  return canonical(left) === canonical(right)
}
