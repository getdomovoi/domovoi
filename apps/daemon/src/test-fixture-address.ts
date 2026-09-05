export type FixtureAddress = { url: string }

// A fixture prints one JSON line once it listens. A pipe delivers that line
// in chunks, so readiness is the newline, not a matching prefix.
export function fixtureAddress(stdout: string): FixtureAddress {
  const end = stdout.indexOf("\n")
  if (end === -1) throw new Error(`The daemon fixture has not printed its address yet: ${JSON.stringify(stdout)}`)
  const line = stdout.slice(0, end)
  const parsed = JSON.parse(line) as { url?: unknown }
  if (typeof parsed.url !== "string") throw new Error(`The daemon fixture printed no url: ${line}`)
  return { url: parsed.url }
}
