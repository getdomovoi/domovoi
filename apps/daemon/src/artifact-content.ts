import { open } from "node:fs/promises"

import { maximumPreviewSourceBytes } from "@getdomovoi/protocol"

export class ArtifactContentLimitError extends Error {
  constructor(maximumBytes: number) {
    super(`Preview exceeds ${maximumBytes} bytes`)
    this.name = "ArtifactContentLimitError"
  }
}

export async function readBoundedArtifactContent(
  path: string,
  maximumBytes = maximumPreviewSourceBytes,
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("Preview byte limit must be a positive safe integer")
  }
  const handle = await open(path, "r")
  try {
    const content = Buffer.allocUnsafe(maximumBytes + 1)
    let offset = 0
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maximumBytes) throw new ArtifactContentLimitError(maximumBytes)
    return content.subarray(0, offset).toString("utf8")
  } finally {
    await handle.close()
  }
}
