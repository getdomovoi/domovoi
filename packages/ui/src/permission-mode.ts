import type { PermissionMode, Runtime } from "@getdomovoi/protocol"

// The protocol has three modes and a separate auto flag that is only legal with
// build. The pre-v2 UI offered "Read only / Ask before writes / Auto in
// worktree", which matched neither, and let auto survive a move out of build.
// What each mode does depends on what the daemon enforces for the provider,
// so the notes come from permissionModeNote rather than living here.
export const permissionModes = [
  { id: "plan", label: "Plan", meaning: "handoff" },
  { id: "ask", label: "Ask", meaning: "waiting" },
  { id: "build", label: "Build", meaning: "online" },
] as const satisfies readonly { id: PermissionMode; label: string; meaning: string }[]

// What holds the provider in Plan and Ask, as the daemon configures it:
// - Codex runs both in its read-only sandbox (codexPolicyFor: domovoi-read),
//   so it can still run commands, and they cannot write. Plan never asks
//   (approvalPolicy never). Ask is approvalPolicy on-request, and every
//   commandExecution approval request becomes a Domovoi gate, so a command
//   that needs more than the sandbox gives asks first.
// - opencode and kilo deny edit and bash to the plan and domovoi-ask agents.
// - Claude in Ask: Claude Code approves its own read-only Bash and file reads
//   inside the working directory before Domovoi's callback runs
//   (claude-read-scope.ts), so cat, ls and read-only git run; past that the
//   callback allows only Read, Glob, Grep, WebFetch and WebSearch and refuses
//   the rest, edits included. Plan is Claude's own plan permission mode.
// - Any other provider: Ask is read-only where the daemon allows it at all,
//   and Plan is the provider's own plan mode, which the daemon does not hold.
export function readOnlyEnforcement(mode: "plan" | "ask", provider: string): string {
  if (provider === "codex") {
    return mode === "plan"
      ? "Commands run in a read-only sandbox, so nothing is written."
      : "Commands run in a read-only sandbox. A command that needs more asks you first."
  }
  if (provider === "opencode" || provider === "kilo") return "Edits and shell commands are refused."
  if (provider === "claude-code") return mode === "plan" ? "Claude's own plan mode makes no changes." : "Edits are refused; only read-only shell commands inside the worktree run."
  return mode === "plan" ? "The provider's own plan mode decides what it may run." : "Anything that would write is refused."
}

// Whether a provider can raise a gate in Ask, which an Allow answers with a
// checkpoint first. Only Codex asks there; the others refuse.
export function askRaisesGates(provider: string): boolean {
  return provider === "codex"
}

export function permissionModeNote(mode: PermissionMode, provider: string): string {
  if (mode === "plan") return `Reads and proposes a plan. ${readOnlyEnforcement("plan", provider)}`
  if (mode === "ask") return `Reads only. ${readOnlyEnforcement("ask", provider)}`
  return "Writes and runs inside the worktree. Gates still apply."
}

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
