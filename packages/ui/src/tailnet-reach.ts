// TailnetReach (Q404 A): what the desktop's main process answers about the
// switch, as apps/desktop/src/shared/tailnet-reach.ts defines it. The preload
// checks keys and bounds; this parses the exact shape, so the cards draw only
// what the main process can have said.

export type TailnetReachReport =
  | { state: "none"; detail: string }
  | {
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
      // A pending directory holding previous files a change could not put back.
      kept?: string
    }

export const tailnetReachSteps = ["status", "certificate", "store", "restart", "delete"] as const
export type TailnetReachStep = (typeof tailnetReachSteps)[number]
export const tailnetReachFailures = ["busy", "none", "https-off", "refused", "failed"] as const
export type TailnetReachFailure = (typeof tailnetReachFailures)[number]

export type TailnetReachOutcome =
  | { ok: true; report: TailnetReachReport }
  | { ok: false; reason: TailnetReachFailure; step: TailnetReachStep; message: string; detail?: string }

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
  if (state === "none") return { state, detail: text(fields(value, ["state", "detail"]).detail) }
  if (state !== "off" && state !== "on") throw new UnreadableAnswer()
  const read = fields(value, ["state", "name", "address", "stored", "httpsCertificates"], ["certificateExpiresAt", "renewalFailed", "ignored", "handSet", "kept"])
  if (typeof read.httpsCertificates !== "boolean") throw new UnreadableAnswer()
  const failed = read.renewalFailed === undefined ? undefined : fields(read.renewalFailed, ["at", "message"])
  return {
    state, name: text(read.name), address: text(read.address), stored: text(read.stored), httpsCertificates: read.httpsCertificates,
    ...(read.certificateExpiresAt === undefined ? {} : { certificateExpiresAt: instant(read.certificateExpiresAt) }),
    ...(failed ? { renewalFailed: { at: instant(failed.at), message: text(failed.message) } } : {}),
    ...(read.ignored === undefined ? {} : { ignored: text(read.ignored) }),
    ...(read.handSet === undefined ? {} : { handSet: text(read.handSet) }),
    ...(read.kept === undefined ? {} : { kept: text(read.kept) }),
  }
}

export function parseTailnetReachOutcome(value: unknown): TailnetReachOutcome {
  if (value && typeof value === "object" && (value as Fields).ok === true) {
    return { ok: true, report: parseTailnetReachReport(fields(value, ["ok", "report"]).report) }
  }
  const read = fields(value, ["ok", "reason", "step", "message"], ["detail"])
  const { reason, step } = read
  if (read.ok !== false || !tailnetReachFailures.includes(reason as TailnetReachFailure) || !tailnetReachSteps.includes(step as TailnetReachStep)) throw new UnreadableAnswer()
  return {
    ok: false, reason: reason as TailnetReachFailure, step: step as TailnetReachStep, message: text(read.message),
    ...(read.detail === undefined ? {} : { detail: text(read.detail) }),
  }
}
