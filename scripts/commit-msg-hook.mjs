import { readFile } from "node:fs/promises"

import { offendingLines } from "./commit-trailers.mjs"

const [, , path] = process.argv
const found = offendingLines(await readFile(path, "utf8"))
if (found.length > 0) {
  const lines = found.map(({ line, name, text }) => `  line ${line}: ${name}\n    ${text}`)
  process.stderr.write(`Commit rejected: assistant attribution is not allowed in a commit message.\n${lines.join("\n")}\n\nRemove those lines and commit again. Caught here it costs one edit; caught after a merge it costs a history rewrite, and with it every commit signature on the branch.\n`)
  process.exitCode = 1
}
