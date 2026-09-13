import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises"
import { dirname, resolve } from "node:path"

export interface Keyring {
  available(): Promise<boolean>
  cause?(): Error | undefined
  get(account: string): Promise<string | undefined>
  set(account: string, secret: string): Promise<void>
  delete(account: string): Promise<void>
}

export class CredentialStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "CredentialStoreError"
  }
}

type FileOptions = { maximumBytes?: number; checkOnly?: boolean }
const symlinkError = (path: string) => new CredentialStoreError(`${path} is a symlink. A credential file must be a regular file you own.`)
const sizeError = (path: string, maximum: number) => new CredentialStoreError(`${path} exceeds the credential file limit of ${maximum} bytes.`)

function validateMaximumBytes(maximum: number | undefined): void {
  if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 1)) throw new CredentialStoreError("Credential byte limit must be a positive safe integer")
}

async function closeFile(handle: FileHandle | undefined, failure?: { error: unknown }): Promise<void> {
  let cleanup: { error: unknown } | undefined
  try { await handle?.close() } catch (error) { cleanup = { error } }
  if (cleanup) {
    if (failure) throw new AggregateError([failure.error, cleanup.error], "Credential operation and file close failed", { cause: failure.error })
    throw cleanup.error
  }
}

export async function readPrivateFile(path: string, options: FileOptions = {}): Promise<string | undefined> {
  validateMaximumBytes(options.maximumBytes)
  let handle
  let failure: { error: unknown } | undefined
  try {
    // lstat also protects platforms without O_NOFOLLOW. Compare the opened
    // descriptor before reading, so a replacement between these calls refuses.
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) throw symlinkError(path)
    if (!entry.isFile()) throw new CredentialStoreError(`${path} is not a regular file.`)
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const status = await handle.stat()
    if (!status.isFile() || status.dev !== entry.dev || status.ino !== entry.ino) throw new CredentialStoreError(`${path} changed while opening the credential file.`)
    if (process.platform !== "win32" && (status.mode & 0o077) !== 0) {
      throw new CredentialStoreError(`${path} is readable by other users. Set it to mode 0600 before using it as a credential file.`)
    }
    const maximum = options.maximumBytes
    if (maximum !== undefined && status.size > maximum) throw sizeError(path, maximum)
    if (options.checkOnly) return undefined
    if (maximum === undefined) return await handle.readFile("utf8")
    // A file can grow after fstat. Read at most the cap plus one byte, not an
    // unbounded readFile followed by a size check on an already allocated value.
    const buffer = Buffer.alloc(maximum + 1)
    let offset = 0
    try {
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      if (offset > maximum) throw sizeError(path, maximum)
      return buffer.subarray(0, offset).toString("utf8")
    } finally { buffer.fill(0) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Only a missing path is absence. Permission, I/O and loop failures refuse.
    if (code === "ENOENT" && handle === undefined) return undefined
    failure = { error: code === "ELOOP" || code === "EMLINK" ? symlinkError(path) : error }
    throw failure.error
  } finally { await closeFile(handle, failure) }
}

async function syncDirectory(path: string): Promise<void> {
  // Windows directory flushing is not implemented here. File contents are
  // flushed there; power-loss name durability is not promised. POSIX flush
  // errors, including unsupported filesystems, refuse.
  if (process.platform === "win32") return
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  let failure: { error: unknown } | undefined
  try { await handle.sync() } catch (error) { failure = { error }; throw error } finally { await closeFile(handle, failure) }
}

export async function writePrivateFile(path: string, content: string, options: {
  maximumBytes?: number
  publish?: typeof rename
} = {}): Promise<void> {
  validateMaximumBytes(options.maximumBytes)
  if (options.maximumBytes !== undefined && Buffer.byteLength(content, "utf8") > options.maximumBytes) throw sizeError(path, options.maximumBytes)
  await readPrivateFile(path, { ...options, checkOnly: true })
  const directory = resolve(dirname(path))
  const firstCreated = await mkdir(directory, { recursive: true, mode: 0o700 })
  if (firstCreated !== undefined && process.platform !== "win32") {
    // Make the new directory chain persistent before it can hold a credential.
    const existingParent = dirname(firstCreated)
    for (let at = directory; ; at = dirname(at)) {
      await syncDirectory(at)
      if (at === existingParent) break
    }
  }
  const staging = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(staging, "wx", 0o600)
  let published = false
  try {
    let failure: { error: unknown } | undefined
    try {
      await handle.chmod(0o600)
      await handle.writeFile(content, "utf8")
      await handle.sync()
    } catch (error) { failure = { error }; throw error } finally { await closeFile(handle, failure) }
    await (options.publish ?? rename)(staging, path)
    published = true
    await syncDirectory(directory)
  } catch (error) {
    if (published) throw new Error(`Credential is published at ${path}, but directory synchronization did not complete. The file may not survive a system failure.`, { cause: error })
    let cleanup: { error: unknown } | undefined
    try { await unlink(staging) } catch (failure) { cleanup = { error: failure } }
    if (cleanup && (cleanup.error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AggregateError([error, cleanup.error], `Credential publication failed and staging cleanup failed at ${staging}. This file may contain a credential.`, { cause: error })
    }
    throw error
  }
}

export type CredentialBackend =
  | { where: "keyring"; keyring: Keyring }
  | { where: "file"; path: string; read(): Promise<string | undefined>; write(content: string): Promise<void> }

export async function openCredentialBackend(options: {
  keyring: Keyring
  credentialFile?: string
  warn(message: string): void
  fileWarning(path: string): string
  unavailable(cause?: Error): string
  maximumBytes?: number
  publish?: typeof rename
}): Promise<CredentialBackend> {
  if (options.credentialFile !== undefined) {
    const path = options.credentialFile
    await readPrivateFile(path, { ...options, checkOnly: true })
    options.warn(options.fileWarning(path))
    return { where: "file", path, read: () => readPrivateFile(path, options), write: (content) => writePrivateFile(path, content, options) }
  }
  if (await options.keyring.available()) return { where: "keyring", keyring: options.keyring }
  throw new CredentialStoreError(options.unavailable(options.keyring.cause?.()))
}

type NativeModule = { Entry: new(service: string, account: string) => {
  getPassword(): string | null
  setPassword(secret: string): void
  deletePassword(): unknown
} }

export function nativeKeyring(options: { service: string; probeAccount: string; load?: () => Promise<NativeModule> }): Keyring {
  let loading: Promise<NativeModule> | undefined
  let failure: Error | undefined
  const entry = async (account: string) => {
    const module = await (loading ??= (options.load ?? (() => import("@napi-rs/keyring")))())
    return new module.Entry(options.service, account)
  }
  return {
    async available() {
      try { (await entry(options.probeAccount)).getPassword(); failure = undefined; return true } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
        return false
      }
    },
    cause: () => failure,
    async get(account) { return (await entry(account)).getPassword() ?? undefined },
    async set(account, secret) { (await entry(account)).setPassword(secret) },
    async delete(account) { (await entry(account)).deletePassword() },
  }
}
