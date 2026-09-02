import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { publishEndpointFile, removeEndpointFile } from "./endpoint-file.js"

const directories: string[] = []

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "domovoi-endpoint-"))
  directories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe("publishEndpointFile", () => {
  it("writes where a distribution's own daemon is reachable", async () => {
    const path = await publishEndpointFile({
      home: await home(),
      host: "127.0.0.1",
      port: 47831,
      token: "daemon-token",
    })

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      host: "127.0.0.1",
      port: 47831,
      token: "daemon-token",
    })
  })

  it("puts the file where readDistroEndpoint looks for it", async () => {
    const directory = await home()
    const path = await publishEndpointFile({
      home: directory,
      host: "127.0.0.1",
      port: 47831,
      token: "daemon-token",
    })
    expect(path).toBe(join(directory, ".domovoi", "endpoint.json"))
  })

  it("keeps the credential readable only by the user who owns it", async () => {
    const path = await publishEndpointFile({
      home: await home(),
      host: "127.0.0.1",
      port: 47831,
      token: "daemon-token",
    })

    if (process.platform === "win32") return
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it("replaces an endpoint an earlier run left behind", async () => {
    const directory = await home()
    await publishEndpointFile({ home: directory, host: "127.0.0.1", port: 1234, token: "old" })
    const path = await publishEndpointFile({
      home: directory,
      host: "127.0.0.1",
      port: 47831,
      token: "new",
    })
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ port: 47831, token: "new" })
  })

  it("refuses to publish an endpoint that is not on loopback", async () => {
    for (const host of ["10.0.0.5", "0.0.0.0", "example.test"]) {
      await expect(publishEndpointFile({
        home: await home(),
        host,
        port: 47831,
        token: "daemon-token",
      })).rejects.toThrow(/loopback/)
    }
  })

  it("never repeats the credential when it refuses", async () => {
    await expect(publishEndpointFile({
      home: await home(),
      host: "10.0.0.5",
      port: 47831,
      token: "daemon-token",
    })).rejects.toThrow(expect.objectContaining({
      message: expect.not.stringContaining("daemon-token"),
    }))
  })

  it("refuses an endpoint with no credential to authenticate with", async () => {
    await expect(publishEndpointFile({
      home: await home(),
      host: "127.0.0.1",
      port: 47831,
      token: "",
    })).rejects.toThrow(/credential/)
  })
})

describe("removeEndpointFile", () => {
  it("takes the endpoint away when the daemon stops", async () => {
    const directory = await home()
    const path = await publishEndpointFile({
      home: directory,
      host: "127.0.0.1",
      port: 47831,
      token: "daemon-token",
    })

    await removeEndpointFile(directory, { host: "127.0.0.1", port: 47831, token: "daemon-token" })
    await expect(stat(path)).rejects.toThrow()
  })

  it("is content when there is no endpoint to take away", async () => {
    await expect(removeEndpointFile(await home())).resolves.toBeUndefined()
  })

  it("leaves an endpoint this daemon did not publish alone", async () => {
    const directory = await home()
    const path = await publishEndpointFile({
      home: directory,
      host: "127.0.0.1",
      port: 47831,
      token: "daemon-token",
    })
    await writeFile(path, JSON.stringify({ host: "127.0.0.1", port: 47999, token: "another" }))

    await removeEndpointFile(directory, { host: "127.0.0.1", port: 47831, token: "daemon-token" })
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ port: 47999 })
  })

  it("removes nothing when this daemon published nothing", async () => {
    const directory = await home()
    const path = await publishEndpointFile({
      home: directory,
      host: "127.0.0.1",
      port: 47831,
      token: "daemon-token",
    })

    await removeEndpointFile(directory)
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ port: 47831 })
  })

  it("leaves no half-written endpoint for a reader to find", async () => {
    const directory = await home()
    const path = await publishEndpointFile({
      home: directory,
      host: "127.0.0.1",
      port: 47831,
      token: "daemon-token",
    })

    const reads: string[] = []
    await Promise.all([
      publishEndpointFile({ home: directory, host: "127.0.0.1", port: 47900, token: "second" }),
      ...Array.from({ length: 40 }, async () => {
        try {
          reads.push(await readFile(path, "utf8"))
        } catch {
          // A rename is atomic, so a reader either sees the old file or the new
          // one. Missing the file entirely is not what this is checking.
        }
      }),
    ])

    for (const contents of reads) expect(() => JSON.parse(contents) as unknown).not.toThrow()
  })

  it("leaves a file it did not write alone", async () => {
    const directory = await home()
    const path = await publishEndpointFile({
      home: directory,
      host: "127.0.0.1",
      port: 47831,
      token: "daemon-token",
    })
    await writeFile(path, "not an endpoint this daemon wrote")

    await removeEndpointFile(directory, { host: "127.0.0.1", port: 47831, token: "daemon-token" })
    expect(await readFile(path, "utf8")).toBe("not an endpoint this daemon wrote")
  })
})
