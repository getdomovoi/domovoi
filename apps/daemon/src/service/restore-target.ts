import { posix, win32 } from "node:path"

import type { ServiceRuntimeRecord } from "./configuration.js"

// Security review round 2 (20c23ba7): an update puts back what the service ran
// before, read from a plist, a unit, a task action or a saved WSL runtime that
// this user's account can change. What it names is registered and started on
// a failed step, so it is put back only in the shape a Domovoi install writes:
// the runtime, the daemon entry, the configuration flag and the saved
// configuration path, in that order and nothing more. The runtime and the
// entry are absolute and normalized. No value has a quote or a control
// character, so none can break out of the file or command line it is written
// into. One check for launchd, systemd, the Windows task and the WSL task.
export type ServiceProgram = { execPath: string; args: readonly string[] }

export type DomovoiServiceShape = {
  paths: "posix" | "win32"
  flag: "--service-config" | "--service-supervise"
  configurationPath: string
}

function plainPath(path: string | undefined, paths: DomovoiServiceShape["paths"]): boolean {
  if (path === undefined || path.includes("\"") || [...path].some((character) => character < " " || character === "\x7f")) return false
  // A Windows path needs its drive: a rooted path without one resolves
  // against whatever drive the task starts on.
  if (paths === "win32") return /^[A-Za-z]:\\/.test(path) && win32.normalize(path) === path
  return posix.isAbsolute(path) && posix.normalize(path) === path
}

export function hasDomovoiServiceShape({ execPath, args }: ServiceProgram, shape: DomovoiServiceShape): boolean {
  const [entry, flag, configurationPath, ...rest] = args
  return rest.length === 0
    && plainPath(execPath, shape.paths)
    && plainPath(entry, shape.paths)
    && flag === shape.flag
    && configurationPath === shape.configurationPath
}

// Security review round 3 (3364a577): any absolute runtime and entry had that
// shape, /usr/bin/env and an unrelated program included. Ruled 2026-09-24 (A):
// what is put back must also be exactly the runtime and daemon entry recorded
// in service.json (serviceRuntime), compared as written, with no case folding
// or further normalization. Without that record nothing is put back.
export function isRecordedServiceProgram(program: ServiceProgram, shape: DomovoiServiceShape, recorded: ServiceRuntimeRecord | undefined): boolean {
  return recorded !== undefined
    && hasDomovoiServiceShape(program, shape)
    && program.execPath === recorded.executable
    && program.args[0] === recorded.entry
}
