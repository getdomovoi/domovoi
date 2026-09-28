import { performance } from "node:perf_hooks"

import { parse } from "smol-toml"

// TOML as a repository's .codex/config.toml holds it, read as plain data.
// smol-toml is a parser only: it runs nothing from the document, builds every
// table with a null prototype so a `__proto__` or `constructor` key is an
// ordinary key, and refuses a document it cannot read in full. Inline arrays
// and tables nest at most this deep; a deeper file reads as invalid, and the
// reader refuses it like any other file it cannot read. Dotted keys and table
// headers are not held to it. The file cap bounds everything else.
export const maximumRepositoryTomlDepth = 64

// A parse that takes longer than this is refused, whatever it read. A file at
// the reader's 256 KiB cap parsed in under 60 ms on Node 22 in review, the
// slowest shapes included, so the limit is generous. The counted growth tests
// check how the parser's work grows but cannot see every kind of slow input
// (a native search, the collector), and this catches what they miss. The
// parser is synchronous, so the limit refuses a slow result after the parse;
// it does not stop the parse or bound how long one read holds the thread.
export const maximumRepositoryTomlParseMilliseconds = 2_000

export class RepositoryTomlTooSlowError extends Error {
  constructor() {
    super(`TOML took longer than ${maximumRepositoryTomlParseMilliseconds} ms to parse`)
    this.name = "RepositoryTomlTooSlowError"
  }
}

export function parseRepositoryToml(text: string): unknown {
  const started = performance.now()
  const document = parse(text, { maxDepth: maximumRepositoryTomlDepth })
  if (performance.now() - started > maximumRepositoryTomlParseMilliseconds) throw new RepositoryTomlTooSlowError()
  return document
}
