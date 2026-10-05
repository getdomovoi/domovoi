// TailnetReach (Q404 A): what the desktop's main process answers about the
// switch, as apps/desktop/src/shared/tailnet-reach.ts defines it. The preload
// checks keys and bounds; this parses the exact shape, so the cards draw only
// what the main process can have said.

export type TailnetReachReport =
  | ({ state: "none"; detail: string } & TailnetReachRetained)
  | ({
      state: "off" | "on"
      name: string
      address: string
      stored: string
      httpsCertificates: boolean
      certificateExpiresAt?: string
      renewalFailed?: { at: string; message: string }
      ignored?: string
      // The daemon inside this app takes a tailnet listener from settings set
      // by hand, which turning the switch off does not clear.
      handSet?: string
    } & TailnetReachRetained)

// Pending directories still holding files of the switch's, said with every
// state: turning off does not need Tailscale, so neither does naming them.
export type TailnetReachRetained = {
  // One holding previous files a change could not put back.
  kept?: string
  // One found when the app started; it may be from a change that did not finish.
  setAside?: string
  // One holding the files a turn-off could not delete once the record was gone.
  undeleted?: string
}
const retainedKeys = ["kept", "setAside", "undeleted"] as const

function retained(read: Fields): TailnetReachRetained {
  return {
    ...(read.kept === undefined ? {} : { kept: text(read.kept) }),
    ...(read.setAside === undefined ? {} : { setAside: text(read.setAside) }),
    ...(read.undeleted === undefined ? {} : { undeleted: text(read.undeleted) }),
  }
}

export const tailnetReachSteps = ["status", "certificate", "store", "restart", "delete"] as const
export type TailnetReachStep = (typeof tailnetReachSteps)[number]
export const tailnetReachFailures = ["busy", "none", "https-off", "refused", "failed"] as const
export type TailnetReachFailure = (typeof tailnetReachFailures)[number]

export type TailnetReachOutcome =
  | { ok: true; report: TailnetReachReport }
  // Q439 B: a turn-off that is done, whose status read after it did not
  // answer by the desktop's deadline; undeleted names the files it set aside
  // and could not delete. This and the next are the successes with no report.
  // Codex review of PR #722, round 2 (P3-2): a turn-on too, without undeleted.
  | { ok: true; statusUnanswered: true; undeleted?: string }
  // Q441 A: a change that is done, whose status read after it failed before
  // the deadline, in the read's own words.
  | { ok: true; statusFailed: string; undeleted?: string }
  // undeleted: the restart failed after a turn-off deleted the record but
  // could not delete the files it set aside, which are in this directory.
  | { ok: false; reason: TailnetReachFailure; step: TailnetReachStep; message: string; detail?: string; undeleted?: string }

class UnreadableAnswer extends Error {
  constructor() {
    super("The desktop sent an unreadable tailnet answer")
  }
}

type Fields = Record<string, unknown>

function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UnreadableAnswer()
  const record = value as Fields
  const keys = Object.keys(record)
  if (!required.every((key) => keys.includes(key)) || !keys.every((key) => required.includes(key) || optional.includes(key))) throw new UnreadableAnswer()
  return record
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) throw new UnreadableAnswer()
  return value
}

function instant(value: unknown): string {
  const read = text(value)
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(read) || Number.isNaN(Date.parse(read))) throw new UnreadableAnswer()
  return read
}

export function parseTailnetReachReport(value: unknown): TailnetReachReport {
  const state = (value && typeof value === "object" ? (value as Fields).state : undefined)
  if (state === "none") {
    const read = fields(value, ["state", "detail"], retainedKeys)
    return { state, detail: text(read.detail), ...retained(read) }
  }
  if (state !== "off" && state !== "on") throw new UnreadableAnswer()
  const read = fields(value, ["state", "name", "address", "stored", "httpsCertificates"], ["certificateExpiresAt", "renewalFailed", "ignored", "handSet", ...retainedKeys])
  if (typeof read.httpsCertificates !== "boolean") throw new UnreadableAnswer()
  const failed = read.renewalFailed === undefined ? undefined : fields(read.renewalFailed, ["at", "message"])
  return {
    state, name: text(read.name), address: text(read.address), stored: text(read.stored), httpsCertificates: read.httpsCertificates,
    ...(read.certificateExpiresAt === undefined ? {} : { certificateExpiresAt: instant(read.certificateExpiresAt) }),
    ...(failed ? { renewalFailed: { at: instant(failed.at), message: text(failed.message) } } : {}),
    ...(read.ignored === undefined ? {} : { ignored: text(read.ignored) }),
    ...(read.handSet === undefined ? {} : { handSet: text(read.handSet) }),
    ...retained(read),
  }
}

// The answer to the change the card asked for. Only a turn-off sets files
// aside and then cannot delete them, so only its answer may name them.
export function parseTailnetReachOutcome(value: unknown, action: "on" | "off"): TailnetReachOutcome {
  const left = action === "off" ? ["undeleted"] : []
  if (value && typeof value === "object" && (value as Fields).ok === true) {
    if ("statusUnanswered" in value) {
      const read = fields(value, ["ok", "statusUnanswered"], left)
      if (read.statusUnanswered !== true) throw new UnreadableAnswer()
      return { ok: true, statusUnanswered: true, ...(read.undeleted === undefined ? {} : { undeleted: text(read.undeleted) }) }
    }
    if ("statusFailed" in value) {
      const read = fields(value, ["ok", "statusFailed"], left)
      return { ok: true, statusFailed: text(read.statusFailed), ...(read.undeleted === undefined ? {} : { undeleted: text(read.undeleted) }) }
    }
    return { ok: true, report: parseTailnetReachReport(fields(value, ["ok", "report"]).report) }
  }
  const read = fields(value, ["ok", "reason", "step", "message"], ["detail", ...left])
  const { reason, step } = read
  if (read.ok !== false || !tailnetReachFailures.includes(reason as TailnetReachFailure) || !tailnetReachSteps.includes(step as TailnetReachStep)) throw new UnreadableAnswer()
  return {
    ok: false, reason: reason as TailnetReachFailure, step: step as TailnetReachStep, message: text(read.message),
    ...(read.detail === undefined ? {} : { detail: text(read.detail) }),
    ...(read.undeleted === undefined ? {} : { undeleted: text(read.undeleted) }),
  }
}
