import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

// The desktop keeps each daemon's relay identity pin in one JSON file under
// userData, beside the window decoration. It is the main process's file: the
// renderer reads and writes single keys over the bridge and never sees the
// path. Nothing in it is secret, so it needs integrity, not concealment, and
// a whole-file replace through a temporary name is what gives it that.
export const relayPinFileName = "relay-pins.json"

// The renderer names one machine's pin; the pattern is the ui's relayPinKey
// with the machine id the protocol issues, and nothing else is a key.
export const relayPinKeyPattern = /^domovoi\.daemon\.relayPin\.machine-[0-9a-f]{32}$/u
export const maximumRelayPinValueLength = 8_192

type PinFile = { version: 1; pins: Record<string, string> }

export type RelayPinFile = {
  read(key: string): Promise<string | undefined>
  write(key: string, value: string): Promise<void>
}

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !relayPinKeyPattern.test(key)) throw new Error("Desktop refused an invalid relay pin key")
}

function assertValue(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumRelayPinValueLength) {
    throw new Error("Desktop refused an invalid relay pin value")
  }
}

async function load(path: string): Promise<PinFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return { version: 1, pins: {} }
    const record = parsed as { version?: unknown; pins?: unknown }
    if (record.version !== 1 || typeof record.pins !== "object" || record.pins === null) return { version: 1, pins: {} }
    const pins: Record<string, string> = {}
    for (const [key, value] of Object.entries(record.pins as Record<string, unknown>)) {
      if (relayPinKeyPattern.test(key) && typeof value === "string") pins[key] = value
    }
    return { version: 1, pins }
  } catch {
    return { version: 1, pins: {} }
  }
}

export function createRelayPinFile(path: string): RelayPinFile {
  // Writes are serialised in this process; the main process is the only writer.
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
    async write(key, value) {
      assertKey(key)
      assertValue(value)
      await exclusive(async () => {
        const file = await load(path)
        file.pins[key] = value
        await mkdir(dirname(path), { recursive: true })
        const temporary = join(dirname(path), `.${relayPinFileName}.${process.pid}.${Date.now()}.tmp`)
        await writeFile(temporary, JSON.stringify(file), { mode: 0o600 })
        await rename(temporary, path)
      })
    },
  }
}
