import type { OperationDeadline } from "../operation-deadline.js"
import { withinServiceDeadline } from "./deadline.js"
import type { CapturedRun, ServiceEffects } from "./install.js"

// Decided 2026-09-17 (SHIP-PLAN S1.1): a daemon that stops at logout is not a
// daemon. A Linux install turns lingering on for the installing user, so that
// user's systemd manager starts at boot and outlives the last session, and
// service.json records whether Domovoi was the one that turned it on. Removal
// turns it off only on that record, so lingering another service or the person
// already relied on is left as found.
//
// Neither step fails the operation. A failed install restores the previous
// service files only up to the manager's registration; after that the unit is
// registered and running, and failing would report a working service as not
// installed. The manager's own refusals stay fatal. Lingering is the one step
// with a degraded but working outcome, so it is stated like the WSL install's
// "no boot supervision": the command succeeds and says what does not happen.

export type LingerTarget = { uid?: number; user?: string }

export type LingerInstallOutcome =
  | { kind: "enabled" }
  | { kind: "kept" }
  | { kind: "already-on" }
  | { kind: "failed"; detail: string }

export type LingerRemovalOutcome =
  | { kind: "disabled" }
  | { kind: "left-on" }
  | { kind: "failed"; detail: string }

type Answer = { result: CapturedRun } | { error: unknown }

// The uid when known: a number cannot be read as another option or user name.
function lingerUser(target: LingerTarget): string | undefined {
  return target.uid !== undefined ? String(target.uid) : target.user
}

export function lingerName(target: LingerTarget): string {
  return target.user ?? (target.uid !== undefined ? `user ${target.uid}` : "this user")
}

async function loginctl(args: string[], effects: Pick<ServiceEffects, "capture">, deadline: OperationDeadline): Promise<Answer> {
  try {
    return { result: await withinServiceDeadline(deadline, () => effects.capture("loginctl", args, deadline)) }
  } catch (error) {
    return { error }
  }
}

const sentence = (text: string) => text.trim().replace(/\.+$/u, "")

// loginctl exits 0 on success and non-zero on any failure; only exit 0 carries
// an answer. execFile reports a program it could not find as spawn ... ENOENT.
function failure(answer: Answer): string {
  if ("error" in answer) return sentence(answer.error instanceof Error ? answer.error.message : String(answer.error))
  const stderr = answer.result.stderr?.trim() ?? ""
  if (/\bENOENT\b/u.test(stderr)) return "loginctl was not found"
  return sentence(stderr) || `loginctl exited with code ${answer.result.code}`
}

// previous: the record an earlier Domovoi install saved, so a reinstall keeps
// a lingering Domovoi turned on as Domovoi's. An expired deadline is not a
// lingering answer and fails the install like any other step.
export async function enableLinger(
  target: LingerTarget,
  previous: boolean | undefined,
  effects: Pick<ServiceEffects, "capture">,
  deadline: OperationDeadline,
): Promise<LingerInstallOutcome> {
  const user = lingerUser(target)
  if (user === undefined) return { kind: "failed", detail: "the installing user is not known" }
  const state = await loginctl(["show-user", user, "--property=Linger", "--value"], effects, deadline)
  deadline.throwIfExpired()
  if ("error" in state || state.result.code !== 0) return { kind: "failed", detail: failure(state) }
  const value = state.result.stdout.trim()
  if (value === "yes") return { kind: previous === true ? "kept" : "already-on" }
  if (value !== "no") return { kind: "failed", detail: "loginctl did not say whether lingering is on" }
  const enabled = await loginctl(["enable-linger", user], effects, deadline)
  deadline.throwIfExpired()
  if ("error" in enabled || enabled.result.code !== 0) return { kind: "failed", detail: failure(enabled) }
  return { kind: "enabled" }
}

// What service.json records. A failure records nothing, whatever an earlier
// install recorded, so removal then leaves lingering as it finds it.
export function lingerRecord(outcome: LingerInstallOutcome): boolean | undefined {
  if (outcome.kind === "failed") return undefined
  return outcome.kind !== "already-on"
}

// Removal and a failed install's restore. Any failure, an expired deadline
// included, leaves lingering on and is reported, never thrown: by then the
// service itself is already gone or put back.
export async function disableLinger(
  target: LingerTarget,
  effects: Pick<ServiceEffects, "capture">,
  deadline: OperationDeadline,
): Promise<LingerRemovalOutcome> {
  const user = lingerUser(target)
  if (user === undefined) return { kind: "failed", detail: "the installing user is not known" }
  const disabled = await loginctl(["disable-linger", user], effects, deadline)
  if ("error" in disabled || disabled.result.code !== 0) return { kind: "failed", detail: failure(disabled) }
  return { kind: "disabled" }
}

export function lingerInstallLine(outcome: LingerInstallOutcome, target: LingerTarget): { stream: "stdout" | "stderr"; text: string } {
  const name = lingerName(target)
  switch (outcome.kind) {
    case "enabled":
      return { stream: "stdout", text: `Turned on lingering for ${name} with loginctl enable-linger, so the daemon keeps running after ${name} logs out and starts when the machine boots. domovoid service remove turns it off again.\n` }
    case "kept":
      return { stream: "stdout", text: `Lingering for ${name} stays on from an earlier Domovoi install. domovoid service remove turns it off again.\n` }
    case "already-on":
      return { stream: "stdout", text: `Lingering was already on for ${name}, so Domovoi left it as it was. domovoid service remove will leave it on.\n` }
    case "failed":
      return { stream: "stderr", text: `Could not turn on lingering for ${name}: ${outcome.detail}. The service is installed, but systemd stops the daemon when ${name} logs out of every session and starts it again at the next login. To keep it running, run loginctl enable-linger; domovoid service remove will then leave lingering on.\n` }
  }
}

export function lingerRemovalLine(outcome: LingerRemovalOutcome, target: LingerTarget): { stream: "stdout" | "stderr"; text: string } {
  const name = lingerName(target)
  switch (outcome.kind) {
    case "disabled":
      return { stream: "stdout", text: `Turned off lingering for ${name}, which Domovoi turned on at install.\n` }
    case "left-on":
      return { stream: "stdout", text: `Lingering for ${name} was on before Domovoi was installed, so it was left on.\n` }
    case "failed":
      return { stream: "stderr", text: `Could not turn off lingering for ${name}, which Domovoi turned on at install: ${outcome.detail}. Lingering stays on, so ${name}'s user services keep running after logout. Run loginctl disable-linger if nothing else needs it.\n` }
  }
}

// A failed install that put the previous service files back also turns off
// the lingering it turned on; if that fails too, the error says so.
export async function lingerAfterRestore(target: LingerTarget, effects: Pick<ServiceEffects, "capture">, deadline: OperationDeadline, cause: unknown): Promise<void> {
  const outcome = await disableLinger(target, effects, deadline)
  if (outcome.kind !== "failed") return
  const detail = sentence(cause instanceof Error ? cause.message : String(cause))
  throw new Error(`${detail}. Lingering, which this install turned on, is still on: ${outcome.detail}. Run loginctl disable-linger if nothing else needs it.`, { cause })
}
