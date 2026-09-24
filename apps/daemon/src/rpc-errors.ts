import { redactDurableText } from "./secret-redaction.js"

export const internalRpcErrorMessage = "Internal daemon error"

const maximumErrorDetailLength = 4_096
const maximumRawErrorDetailLength = 8_192
const maximumNestedErrorDepth = 4
const maximumAggregateErrors = 8
export class PublicRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = "PublicRpcError"
  }
}

export function redactErrorDetail(error: unknown): string {
  const detail = redactDurableText(
    errorDetail(error).slice(0, maximumRawErrorDetailLength),
  ).value

  return detail.length <= maximumErrorDetailLength
    ? detail
    : `${detail.slice(0, maximumErrorDetailLength - 1)}…`
}

function errorDetail(error: unknown): string {
  const detail = new BoundedDetail(maximumRawErrorDetailLength)
  appendErrorDetail(detail, error, 0, new Set())
  return detail.value
}

class BoundedDetail {
  #value = ""

  constructor(readonly maximumLength: number) {}

  get value(): string {
    return this.#value
  }

  get full(): boolean {
    return this.#value.length >= this.maximumLength
  }

  append(value: unknown): void {
    const remaining = this.maximumLength - this.#value.length
    if (remaining <= 0) return
    this.#value += safeString(value, remaining)
  }
}

function appendErrorDetail(
  detail: BoundedDetail,
  error: unknown,
  depth: number,
  seen: Set<object>,
): void {
  if (detail.full) return
  if (depth > maximumNestedErrorDepth) {
    detail.append("[Nested error omitted]")
    return
  }

  if (!(error instanceof Error)) {
    detail.append(error)
    return
  }
  if (seen.has(error)) {
    detail.append("[Circular error]")
    return
  }
  seen.add(error)
  detail.append(errorSummary(error))

  const cause = errorCause(error)
  if (cause !== undefined) {
    detail.append("\nCaused by: ")
    appendErrorDetail(detail, cause, depth + 1, seen)
  }

  if (error instanceof AggregateError) appendAggregateErrors(detail, error, depth, seen)
}

function appendAggregateErrors(
  detail: BoundedDetail,
  error: AggregateError,
  depth: number,
  seen: Set<object>,
): void {
  let errors: unknown
  try {
    errors = error.errors
  } catch {
    detail.append("\n[Aggregate errors unavailable]")
    return
  }
  if (!Array.isArray(errors)) {
    detail.append("\n[Aggregate errors omitted]")
    return
  }

  const retained = Math.min(errors.length, maximumAggregateErrors)
  for (let index = 0; index < retained; index += 1) {
    if (detail.full) return
    detail.append(`\nAggregate error ${index + 1}: `)
    appendErrorDetail(detail, errors[index], depth + 1, seen)
  }
  if (errors.length > retained) {
    detail.append(`\n${errors.length - retained} additional aggregate errors omitted`)
  }
}

function errorSummary(error: Error): string {
  try {
    if (typeof error.stack === "string") return error.stack.slice(0, maximumRawErrorDetailLength)
  } catch {
    // Fall through to the bounded name and message representation.
  }
  return `${safeString(error.name, 256)}: ${safeString(error.message, maximumRawErrorDetailLength)}`
}

function errorCause(error: Error): unknown {
  try {
    return error.cause
  } catch {
    return undefined
  }
}

function safeString(value: unknown, maximumLength: number): string {
  try {
    return String(value).slice(0, maximumLength)
  } catch {
    return "[Unprintable error detail]".slice(0, maximumLength)
  }
}

// project.open answers a folder that is not a repository with this fixed text,
// which quotes nothing from the machine, so a CLI may repeat it.
export const notARepositoryMessage = "That folder is not a Git repository with at least one commit"

// Only git's own "no repository here" answers map to notARepositoryMessage: no
// repository, no commit behind HEAD, or a folder that does not exist. A git
// binary that is missing, a safe.directory ownership refusal or a permission
// error is a different problem and keeps the internal path.
export function isMissingRepository(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  if (typeof code === "string") return false
  const stderr = (error as { stderr?: unknown }).stderr
  const text = `${typeof stderr === "string" ? stderr : ""}\n${error.message}`
  if (/detected dubious ownership/i.test(text)) return false
  return /not a git repository|unknown revision or path not in the working tree|bad revision 'HEAD'|cannot change to '/i.test(text)
}

// Fixed answers for the two inspection failures a person fixes outside the
// repository. Neither quotes anything from the machine, so a CLI may repeat them.
export const gitMissingMessage = "Git was not found on this machine's PATH. Install Git, then restart Domovoi so it can find it."
export const gitOwnershipRefusedMessage = "Git refused this folder because a different user owns it. Add it to Git's safe.directory list, then open it again."

// The public answer for a failed repository inspection, or undefined when the
// failure keeps the internal path (a permission error, for one).
export function repositoryInspectionRefusal(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const { code, syscall, stderr } = error as { code?: unknown; syscall?: unknown; stderr?: unknown }
  if (code === "ENOENT" && typeof syscall === "string" && syscall.startsWith("spawn")) return gitMissingMessage
  if (/detected dubious ownership/i.test(`${typeof stderr === "string" ? stderr : ""}\n${error.message}`)) {
    return gitOwnershipRefusedMessage
  }
  return isMissingRepository(error) ? notARepositoryMessage : undefined
}

// The fixed project.open answers a CLI may repeat as they are.
export const repeatableOpenMessages: ReadonlySet<string> = new Set([
  notARepositoryMessage,
  gitMissingMessage,
  gitOwnershipRefusedMessage,
])
