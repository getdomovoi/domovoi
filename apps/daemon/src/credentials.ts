import { randomBytes } from "node:crypto"
import { chmod, mkdir, open, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const generatedTokenPattern = /^[A-Za-z0-9_-]{43}$/
const credentialReadAttempts = 20
const credentialReadDelayMs = 5

async function readDaemonToken(path: string): Promise<string> {
  for (let attempt = 0; attempt < credentialReadAttempts; attempt += 1) {
    const token = (await readFile(path, "utf8")).trim()
    if (generatedTokenPattern.test(token)) return token
    if (token) throw new Error("Daemon credential is malformed")
    await delay(credentialReadDelayMs)
  }
  throw new Error("Daemon credential is malformed")
}

export async function loadOrCreateDaemonToken(path: string): Promise<string> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(directory, 0o700)

  try {
    const handle = await open(path, "wx", 0o600)
    try {
      await handle.writeFile(`${randomBytes(32).toString("base64url")}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }

  if (process.platform !== "win32") await chmod(path, 0o600)
  return readDaemonToken(path)
}
