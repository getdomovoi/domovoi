// Work a call does, counted without a clock, so a test can say how it grows
// with its input and cannot flake on a loaded runner. Counted: each visit of a
// callback given to an array method, each regular expression match attempt
// and the characters it matched, and the characters or elements built by
// slice, substring and join. Work inside one regular expression search (its
// backtracking) and inside indexOf, includes or startsWith is not visible here.

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
]
