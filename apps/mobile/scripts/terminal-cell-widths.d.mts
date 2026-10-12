// Types for the cell-width table generator, so the test that checks the
// committed table against the generator's output reads it typed.
export type UnicodeFile = { url: string, sha256: string }

export type UnicodeSource = {
  version: string
  eastAsianWidth: UnicodeFile
  generalCategory: UnicodeFile
}

export const unicodeSource: UnicodeSource

export const firstNotNarrow: number

export function cellWidthModule(eastAsianWidth: string, generalCategory: string, source: UnicodeSource): string
