import { readFile, writeFile } from "node:fs/promises"

import { withoutAttribution } from "./commit-trailers.mjs"

const [, , path] = process.argv
const original = await readFile(path, "utf8")
const { message, removed } = withoutAttribution(original)
if (removed.length > 0) {
  await writeFile(path, message)
  const lines = removed.map(({ name, text }) => `  removed ${name}: ${text}`)
  process.stderr.write(`Assistant attribution stripped from the commit message.\n${lines.join("\n")}\n`)
}
