import { z } from "zod"

/** Domovoi string bounds use JavaScript String.length, measured in UTF-16 code units. */
export function utf16MaxLength(maximum: number) {
  return declareWireBound(z.check<string>(({ value, issues }) => {
    if (value.length <= maximum) return
    issues.push({
      code: "too_big", origin: "string", maximum, inclusive: true, input: value, continue: true,
      message: `Expected at most ${maximum} UTF-16 code units`,
    })
  }), { utf16MaxLength: maximum })
}

/** Keep exact string lengths in the same units as maxima and client String.length checks. */
export function utf16Length(length: number) {
  return declareWireBound(z.check<string>(({ value, issues }) => {
    if (value.length === length) return
    const common = {
      origin: "string" as const, inclusive: true, input: value, continue: true,
      message: `Expected exactly ${length} UTF-16 code units`,
    }
    issues.push(value.length > length
      ? { ...common, code: "too_big", maximum: length }
      : { ...common, code: "too_small", minimum: length })
  }), { utf16Length: length })
}

// A custom check's bound lives in a closure that JSON Schema cannot see. The
// wire record (scripts/protocol-wire.mjs) reads it from here instead, so a
// changed bound is a recorded wire change. Validation does not read it.
function declareWireBound<T extends { _zod: { def: object } }>(check: T, bound: Record<string, number>): T {
  Object.assign(check._zod.def, { wire: bound })
  return check
}

// Zod 4.4 admitted valid minute-precision timestamps. Keep that existing grammar
// explicit in 4.5: persisted state and hashed transfer manifests must still parse
// without rewriting their bytes. Both alternatives validate the calendar and
// time; UTC-only fields still reject offsets and neither admits local datetimes.
function compatibleDateTime(offset: boolean) {
  const seconds = z.iso.datetime({ offset })
  const minutes = z.iso.datetime({ offset, precision: -1 })
  return z.string().check(({ value, issues }) => {
    const result = seconds.safeParse(value)
    if (result.success || minutes.safeParse(value).success) return
    // Preserve a datetime issue and subsequent refinement diagnostics. A union
    // would replace this with an aborting invalid_union and "Invalid input".
    issues.push({
      code: "invalid_format", origin: "string", format: "datetime",
      input: value, continue: true, message: "Invalid ISO datetime",
    })
  })
}

export const dateTimeSchema = compatibleDateTime(false)
export const offsetDateTimeSchema = compatibleDateTime(true)
