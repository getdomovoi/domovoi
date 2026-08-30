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
