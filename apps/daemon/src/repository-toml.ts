import { parse } from "smol-toml"

// TOML as a repository's .codex/config.toml holds it, read as plain data.
// smol-toml is a parser only: it runs nothing from the document, builds every
// table with a null prototype so a `__proto__` or `constructor` key is an
// ordinary key, and refuses a document it cannot read in full. Inline arrays
// and tables nest at most this deep; a deeper file reads as invalid, and the
// reader refuses it like any other file it cannot read. The file cap bounds
// everything else.
export const maximumRepositoryTomlDepth = 64

export function parseRepositoryToml(text: string): unknown {
  return parse(text, { maxDepth: maximumRepositoryTomlDepth })
}
