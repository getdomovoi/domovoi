import { realpathSync } from "node:fs"
import { posix, resolve, win32 } from "node:path"

// Strings retain the existing home-based API; an explicit profile is never HOME.
// Trade: a home string silently selects its default profile. New profile-aware
// callers must pass the object form; audit callers when adding profile paths.
export type ProfileLocation = string | { profileDirectory: string }

export function profileLocation(home: string, directory?: string): ProfileLocation {
  return directory === undefined || directory === profileDirectory(home) ? home : { profileDirectory: directory }
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

export function sameProfileDirectory(left: ProfileLocation, right: ProfileLocation): boolean {
  const canonical = (location: ProfileLocation) => {
    const directory = profileDirectory(location)
    try { return realpathSync.native(directory) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(directory)
      throw error
    }
  }
  return canonical(left) === canonical(right)
}
