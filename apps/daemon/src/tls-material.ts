import { readFile, stat } from "node:fs/promises"

export type TlsMaterialPaths = {
  certPath: string
  keyPath: string
}

export type TlsMaterial = {
  cert: Buffer
  key: Buffer
}

async function readPrivateFile(path: string, description: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (error) {
    // The path is named so an operator can fix it; the file contents never are.
    throw new Error(
      `Domovoi could not read the ${description} at ${path}: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}`,
      { cause: error },
    )
  }
}

export async function loadTlsMaterial(paths: TlsMaterialPaths): Promise<TlsMaterial> {
  const cert = await readPrivateFile(paths.certPath, "TLS certificate")
  const key = await readPrivateFile(paths.keyPath, "TLS private key")

  if (process.platform !== "win32") {
    const { mode } = await stat(paths.keyPath)
    // A key any other account can read is already disclosed, so the daemon
    // refuses it rather than serving with it.
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `TLS private key must not be readable by other users: ${paths.keyPath}`,
      )
    }
  }

  if (!cert.toString("utf8").includes("BEGIN CERTIFICATE")) {
    throw new Error(`TLS certificate is not PEM encoded: ${paths.certPath}`)
  }
  if (!key.toString("utf8").includes("PRIVATE KEY")) {
    throw new Error(`TLS private key is not PEM encoded: ${paths.keyPath}`)
  }

  return { cert, key }
}
