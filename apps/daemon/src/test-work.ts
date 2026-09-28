// Work a call does, counted without a clock, so a test can say how it grows
// with its input and cannot flake on a loaded runner. Counted: each visit of a
// callback given to an array method, each regular expression match attempt
// and the characters it matched, and the characters or elements built by
// slice, substring and join. Work inside one regular expression search (its
// backtracking) and inside indexOf, includes or startsWith is not visible here;
// timeGrowth below times the first.

import { performance } from "node:perf_hooks"

type Method = (this: unknown, ...args: unknown[]) => unknown

const callbackMethods = ["every", "filter", "find", "findIndex", "flatMap", "forEach", "map", "reduce", "some", "sort"] as const

export async function countWork<T>(run: () => T | Promise<T>): Promise<{ work: number; result: Awaited<T> }> {
  let work = 0
  const restores: Array<() => void> = []
  const patch = (target: object, name: string, replacement: (original: Method) => Method) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name)!
    Object.defineProperty(target, name, { ...descriptor, value: replacement(descriptor.value as Method) })
    restores.push(() => Object.defineProperty(target, name, descriptor))
  }
  const built = (original: Method): Method => function (this: unknown, ...args: unknown[]) {
    const result = Reflect.apply(original, this, args) as { length: number }
    work += result.length
    return result
  }
  try {
    for (const name of callbackMethods) {
      patch(Array.prototype, name, (original) => function (this: unknown, callback: unknown, ...rest: unknown[]) {
        const counted = typeof callback === "function"
          ? function (this: unknown, ...args: unknown[]) {
            work += 1
            return Reflect.apply(callback as Method, this, args)
          }
          : callback
        return Reflect.apply(original, this, [counted, ...rest])
      })
    }
    patch(String.prototype, "slice", built)
    patch(String.prototype, "substring", built)
    patch(Array.prototype, "slice", built)
    patch(Array.prototype, "join", built)
    patch(RegExp.prototype, "exec", (original) => function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args) as RegExpExecArray | null
      work += 1 + (result === null ? 0 : result[0].length)
      return result
    })
    const result = await run()
    return { work, result }
  } finally {
    for (let index = restores.length - 1; index >= 0; index -= 1) restores[index]!()
  }
}

// How much more work four times the input takes: about 4 when the work grows
// linearly, about 16 when it grows with the square of the input.
export async function workGrowth<T>(small: () => T | Promise<T>, large: () => T | Promise<T>): Promise<{ growth: number; results: [Awaited<T>, Awaited<T>] }> {
  const first = await countWork(small)
  const second = await countWork(large)
  return { growth: second.work / first.work, results: [first.result, second.result] }
}

// Near-linear growth for four times the input: linear is 4, and sorting adds
// a logarithm's worth.
export const nearLinearGrowth = 6

// Inputs a redaction pass has taken more than linear work on, each at a base
// size whose four times still fits the reader's file limit. Each builds one
// command line.
export const adversarialCommands: ReadonlyArray<readonly [string, number, (size: number) => string]> = [
  ["a scheme word before a flag, repeated in one word", 500, (size) => `echo '${"Token --x ".repeat(size)}'`],
  ["a scheme word and its value, repeated in one word", 500, (size) => `echo '${"Bearer x ".repeat(size)}'`],
  ["bare opening braces", 2_000, (size) => `echo ${"{".repeat(size)}x`],
  ["a punctuation run after a scheme word", 2_000, (size) => `curl Bearer ${".".repeat(size)}x`],
  ["a shell's options that take an argument", 250, (size) => `${"sh -o ".repeat(size)}x`],
  ["private key headers before one footer", 250, (size) => `echo '${"-----BEGIN PRIVATE KEY----- ".repeat(size)}-----END PRIVATE KEY-----' x`],
  ["header flags in one word", 1_000, (size) => `echo '${"-H ".repeat(size)}'`],
  ["header lines in one word", 500, (size) => `echo '${"-H a:b ".repeat(size)}'`],
  ["token-shaped runs", 1_000, (size) => `echo ${"eyJ-".repeat(size)}`],
  ["chained scheme words", 1_000, (size) => `curl ${"Bearer Basic ".repeat(size)}x`],
  ["chained flags and scheme words", 500, (size) => `curl ${"--token Token ".repeat(size)}x`],
  ["assignments in one word", 1_000, (size) => `echo '${"A=a ".repeat(size)}'`],
  // Words every rule reads again inside a value another rule took.
  ["scheme words in a URL's path", 500, (size) => `curl 'https://h/ ${"Bearer ".repeat(size)}' x`],
  ["sensitive flags in a URL's path", 500, (size) => `curl 'https://h/ ${"--token ".repeat(size)}' x`],
  ["scheme words after a header's name", 500, (size) => `curl -H 'X-Foo: ${"Bearer ".repeat(size)}' x`],
  ["scheme words in a shell's script", 500, (size) => `sh -c '${"curl Bearer ".repeat(size)}' x`],
  ["private key headers in a URL's path", 250, (size) => `curl 'https://h/ ${"-----BEGIN PRIVATE KEY----- ".repeat(size)}' x`],
  ["header flags in a URL's path", 500, (size) => `curl 'https://h/ ${"-H X: ".repeat(size)}' x`],
  // Values in the same word as the word that names them, inside a URL.
  ["scheme words and values in a URL's authority", 500, (size) => `curl 'https://h ${"Token x ".repeat(size)}' x`],
  ["sensitive keys in a URL's query names", 500, (size) => `curl 'https://h/?${"--token x=1&".repeat(size)}' x`],
  ["assignments in a URL's query", 500, (size) => `curl 'https://h/?${"a=1&b=".repeat(size)}' x`],
  // Triggers read only in a view the protocol backstop reads, and outputs it
  // is asked about again.
  ["percent-encoded scheme words in a URL's authority", 500, (size) => `curl 'https://h ${"%54oken x ".repeat(size)}' x`],
  ["percent-encoded blanks after scheme words", 500, (size) => `curl 'https://h ${"Token%20x ".repeat(size)}' x`],
  ["percent-encoded keys in one word", 500, (size) => `echo '${"api%5fkey=x ".repeat(size)}'`],
  ["\\u escapes in scheme words", 500, (size) => `echo '${"\\u0054oken x ".repeat(size)}'`],
  ["ANSI C escapes the decoded shell words read", 500, (size) => `echo '$'"'"'${"\\x54oken x ".repeat(size)}'`],
  ["a JSON argv's strings in one word", 500, (size) => `curl '[${"\"--token\",\"x\",".repeat(size)}]'`],
  ["quotes before scheme values in one word", 500, (size) => `curl 'https://h ${"Token \"x\" ".repeat(size)}' x`],
  ["escaped blanks after a sensitive header's name", 500, (size) => `curl -H X-Api-Token:${"\\ --token".repeat(size)}\\ x`],
  ["escaped blanks after assignments", 500, (size) => `echo ${"A=\\ x ".repeat(size)}`],
  ["quoted strings a hidden string pairs again, in a script", 250, (size) => `sh -c '${"curl \"\\\\u0054oken\" \"\\\"x\" \"t\\\"\" ".repeat(size)}'`],
]

// The scanning inside one regular expression search is the work the counter
// cannot see, so it is timed instead. A pattern such as /[.,;:!?]+$/u starts
// again at every character of a long run it fails on, and one search then
// takes time that grows with the square of the run. Time is noisy where
// counted work is not: each size takes the least of several runs, a growth at
// or over the limit is measured again, and the limit sits between linear (4)
// and quadratic (16), where the linear work around a quadratic search still
// leaves its growth.
export const quadraticTimeGrowth = 7

function leastTime(run: () => unknown, runs: number): number {
  run()
  let least = Number.POSITIVE_INFINITY
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now()
    run()
    least = Math.min(least, performance.now() - start)
  }
  return least
}

// How much longer four times the input takes: the least of up to three
// measurements, stopping at the first under the limit.
export function timeGrowth(small: () => unknown, large: () => unknown, runs = 5): number {
  let least = Number.POSITIVE_INFINITY
  for (let attempt = 0; attempt < 3 && least >= quadraticTimeGrowth; attempt += 1) {
    least = Math.min(least, leastTime(large, runs) / leastTime(small, runs))
  }
  return least
}

// Input a regular expression once searched in quadratic time, each with that
// pattern, so a test can show the timing check fails when it comes back. Each
// builds one command line.
export const regexAdversaries: ReadonlyArray<readonly [string, number, (size: number) => string, (text: string) => string]> = [
  ["a punctuation run after a scheme word", 4_000, (size) => `curl Bearer ${".".repeat(size)}x`, (text) => text.replace(/[.,;:!?]+$/u, "")],
  [
    "token-shaped runs", 4_000, (size) => `echo ${"eyJ-".repeat(size / 4)}`,
    (text) => text.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/gu, "[REDACTED]"),
  ],
]
