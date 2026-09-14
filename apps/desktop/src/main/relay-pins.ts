import { mkdir, open, readFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"

// The desktop keeps each daemon's relay identity pin in one JSON file under
// userData, beside the window decoration. It is the main process's file: the
// renderer reads and swaps single keys over the bridge and never sees the
// path. Nothing in it is secret, so it needs integrity, not concealment: a
// whole-file replace through a synced temporary name, and a refusal, never a
// silent empty file, when the bytes on disk are not a file this code wrote.
export const relayPinFileName = "relay-pins.json"

// The renderer names one machine's pin; the pattern is the ui's relayPinKey
// with the machine id the protocol issues, and nothing else is a key.
export const relayPinKeyPattern = /^domovoi\.daemon\.relayPin\.machine-[0-9a-f]{32}$/u
export const maximumRelayPinValueLength = 8_192

type PinFile = { version: 1; pins: Record<string, string> }

export type RelayPinFile = {
  read(key: string): Promise<string | undefined>
  compareAndSwap(key: string, expected: string | undefined, replacement: string): Promise<boolean>
}

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !relayPinKeyPattern.test(key)) throw new Error("Desktop refused an invalid relay pin key")
}

function assertValue(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumRelayPinValueLength) {
    throw new Error("Desktop refused an invalid relay pin value")
  }
}

function assertExpected(value: unknown): asserts value is string | undefined {
  if (value !== undefined) assertValue(value)
}

const unreadable = (path: string) => new Error(`The relay pin file at ${path} is not readable. Move it aside to pair again.`)

// Only a missing file is an empty file. Anything else that is not the shape
// this code writes is refused whole, so a damaged or newer file keeps its
// bytes and no pin in it is replaced by a fresh enrolment.
async function load(path: string): Promise<PinFile> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT") return { version: 1, pins: {} }
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw unreadable(path) }
  if (typeof parsed !== "object" || parsed === null) throw unreadable(path)
  const record = parsed as { version?: unknown; pins?: unknown }
  if (record.version !== 1) throw new Error(`The relay pin file at ${path} has a version this desktop does not read. Move it aside to pair again.`)
  if (typeof record.pins !== "object" || record.pins === null) throw unreadable(path)
  const pins: Record<string, string> = {}
  for (const [key, value] of Object.entries(record.pins as Record<string, unknown>)) {
    if (!relayPinKeyPattern.test(key) || typeof value !== "string") throw unreadable(path)
    pins[key] = value
  }
  return { version: 1, pins }
}

// Publish the new bytes durably: flush the temporary file, rename it over
// the old one, then flush the directory so the rename itself is on disk. A
// flush that fails rejects the swap; the caller must not believe an
// acknowledgement the disk never gave. Windows cannot open a directory for
// fsync, and its rename is already committed on return.
async function publish(path: string, file: PinFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${relayPinFileName}.${process.pid}.${Date.now()}.tmp`)
  const handle = await open(temporary, "w", 0o600)
  try {
    await handle.writeFile(JSON.stringify(file), "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  if (process.platform === "win32") return
  const directory = await open(dirname(path), "r")
  try { await directory.sync() } finally { await directory.close() }
}

export function createRelayPinFile(path: string): RelayPinFile {
  // Swaps are serialised in this process; the main process is the only writer,
  // so the compare below is the one every renderer window goes through.
  let queue: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation)
    queue = next.catch(() => undefined)
    return next
  }
  return {
    async read(key) {
      assertKey(key)
      return (await load(path)).pins[key]
    },
    async compareAndSwap(key, expected, replacement) {
      assertKey(key)
      assertExpected(expected)
      assertValue(replacement)
      return exclusive(async () => {
        const file = await load(path)
        if (file.pins[key] !== expected) return false
        file.pins[key] = replacement
        await publish(path, file)
        return true
      })
    },
  }
}
