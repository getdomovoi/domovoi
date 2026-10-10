// @ts-check
// Worker for src/test-wait-for.test.ts: lists every direct vi.waitFor call
// in the *.test.ts files under workerData.root whose timeout is not a
// positive numeric literal, and the files it had to parse.
//
// It runs on a worker thread because `vitest run --coverage` profiles every
// function on the test's own thread, the TypeScript parser included, and that
// made the same parse about four times slower. A worker thread is a separate
// V8 isolate the coverage session does not profile. This file is plain
// JavaScript so the worker loads it without a TypeScript loader.
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { parentPort, workerData } from "node:worker_threads"

import ts from "typescript"

/** @param {string} root */
async function scanWaitForTimeouts(root) {
  /** @type {string[]} */
  const offenders = []
  /** @type {string[]} */
  const parsed = []
  const entries = await readdir(root, { recursive: true })
  for (const entry of entries.filter((path) => path.endsWith(".test.ts"))) {
    const path = join(root, entry)
    const text = await readFile(path, "utf8")
    const relative = entry.replaceAll("\\", "/")
    // Parsing is most of the cost of the scan. A property named waitFor spells
    // the word in the text once its \uXXXX escapes are decoded, so any other
    // file cannot hold an offender and skips the parse. Decoding escapes
    // outside identifiers too only admits extra files, never hides one.
    // TypeScript 5.9 can drop identifier text before a braced \u{...}
    // escape, so decoding may not give the name it reads; a file with a
    // braced escape always parses.
    if (
      text.includes("\\u{") === false
      && /\bwaitFor\b/.test(text.includes("\\u") ? decodeUnicodeEscapes(text) : text) === false
    ) continue
    parsed.push(relative)
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest)
    /** @param {ts.Node} node */
    const visit = (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(source) === "vi"
        && node.expression.name.text === "waitFor"
      ) {
        const options = node.arguments[1]
        const timeout = options && ts.isObjectLiteralExpression(options)
          ? options.properties.find((property) => (
            ts.isPropertyAssignment(property) && property.name.getText(source) === "timeout"
          ))
          : undefined
        const value = timeout && ts.isPropertyAssignment(timeout) ? timeout.initializer : options
        if (
          value === undefined
          || ts.isNumericLiteral(value) === false
          || Number.isFinite(Number(value.text)) === false
          || Number(value.text) <= 0
        ) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          offenders.push(`${relative}:${line}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { offenders, parsed }
}

/** @param {string} text */
function decodeUnicodeEscapes(text) {
  return text.replace(
    /\\u([0-9a-fA-F]{4})/g,
    /** @type {(escape: string, code: string) => string} */
    (_escape, code) => String.fromCharCode(Number.parseInt(code, 16)),
  )
}

parentPort?.postMessage(await scanWaitForTimeouts(workerData.root))
