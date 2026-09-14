import type { PermissionMode, Runtime } from "@getdomovoi/protocol"

// The protocol has three modes and a separate auto flag that is only legal with
// build. The pre-v2 UI offered "Read only / Ask before writes / Auto in
// worktree", which matched neither, and let auto survive a move out of build.
export const permissionModes = [
  {
    id: "plan",
    label: "Plan",
    meaning: "handoff",
    note: "Reads and proposes. It cannot write or run anything.",
  },
  {
    id: "ask",
    label: "Ask",
    meaning: "waiting",
    note: "Writes and commands ask first, one at a time.",
  },
  {
    id: "build",
    label: "Build",
    meaning: "online",
    note: "Writes and runs inside the worktree. Gates still apply.",
  },
] as const satisfies readonly { id: PermissionMode; label: string; meaning: string; note: string }[]

// `satisfies` proves every entry's id is a real mode. It does not prove the list
// carries every mode, and the lookup below asserts non-null, so a fourth mode
// added upstream would read as undefined at runtime rather than failing here.
// This closes that: the type is `never` unless the list covers the union, so the
// assignment stops compiling the moment it does not.
type UncoveredPermissionMode = Exclude<PermissionMode, (typeof permissionModes)[number]["id"]>
const permissionModesAreExhaustive: [UncoveredPermissionMode] extends [never] ? true : never = true

export function permissionModeLabel(mode: PermissionMode, auto: boolean): string {
  void permissionModesAreExhaustive
  const named = permissionModes.find((entry) => entry.id === mode)!
  return auto ? `${named.label} · auto` : named.label
}

// Auto is a separate control, not a fourth mode, and it cannot outlive the mode
// that permits it. Leaving build clears it rather than remembering it.
export function withPermissionMode(runtime: Runtime, mode: PermissionMode): Runtime {
  return { ...runtime, permissionMode: mode, auto: mode === "build" ? runtime.auto : false }
}

export function withAuto(runtime: Runtime, auto: boolean): Runtime {
  if (auto && runtime.permissionMode !== "build") return runtime
  return { ...runtime, auto }
}

export function autoIsOffered(mode: PermissionMode): boolean {
  return mode === "build"
}
