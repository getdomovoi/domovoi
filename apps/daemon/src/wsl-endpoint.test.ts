import { describe, expect, it, vi } from "vitest"

import { readDistroEndpoint, type DistroEndpointInput } from "./wsl-endpoint.js"

const distribution = "Ubuntu-24.04"
const token = "s3cr3t-daemon-token"

function reader(answer: string | (() => never)) {
  return vi.fn<NonNullable<DistroEndpointInput["run"]>>(
    async () => (typeof answer === "string" ? answer : answer()),
  )
}

describe("readDistroEndpoint", () => {
  it("reads the endpoint the distribution's own daemon wrote", async () => {
    const run = reader(JSON.stringify({ host: "127.0.0.1", port: 47831, token }))
    expect(await readDistroEndpoint({ distribution, run })).toEqual({
      host: "127.0.0.1",
      port: 47831,
      token,
    })
  })

  it("asks the distribution for the file instead of reading it through the share", async () => {
    const run = reader(JSON.stringify({ host: "127.0.0.1", port: 47831, token }))
    await readDistroEndpoint({ distribution, run })
    expect(run).toHaveBeenCalledWith("wsl.exe", [
      "-d",
      distribution,
      "--cd",
      "~",
      "--",
      "cat",
      ".domovoi/endpoint.json",
    ], { timeoutMs: expect.any(Number) })
  })

  it("reports nothing when the distribution has no daemon endpoint", async () => {
    const run = reader(() => {
      throw Object.assign(new Error("cat: .domovoi/endpoint.json: No such file or directory"), {
        code: 1,
        stderr: "cat: .domovoi/endpoint.json: No such file or directory\n",
      })
    })
    expect(await readDistroEndpoint({ distribution, run })).toBeUndefined()
  })

  it("does not call a distribution it cannot reach a missing endpoint", async () => {
    const run = reader(() => {
      throw Object.assign(new Error("There is no distribution with the supplied name."), {
        code: 1,
        stderr: "There is no distribution with the supplied name.\n",
      })
    })
    await expect(readDistroEndpoint({ distribution, run })).rejects.toThrow(/no distribution/)
  })

  it("does not call a denied read a missing endpoint, and says it was denied", async () => {
    const run = reader(() => {
      throw Object.assign(new Error("cat: .domovoi/endpoint.json: Permission denied"), {
        code: 1,
        stderr: "cat: .domovoi/endpoint.json: Permission denied\n",
      })
    })
    const refused = readDistroEndpoint({ distribution, run })
    await expect(refused).rejects.toThrow(/Permission denied/)
    await expect(refused).rejects.toMatchObject({ kind: "denied" })
  })

  it("does not call a missing wsl.exe a missing endpoint", async () => {
    const run = reader(() => {
      throw Object.assign(new Error("spawn wsl.exe ENOENT"), { code: "ENOENT" })
    })
    const refused = readDistroEndpoint({ distribution, run })
    await expect(refused).rejects.toThrow(/not installed/)
    await expect(refused).rejects.toMatchObject({ kind: "absent" })
  })

  it("names a distribution wsl.exe could not start as unavailable, not as one with no daemon", async () => {
    const run = reader(() => {
      throw Object.assign(new Error("Command failed: wsl.exe"), {
        code: -1,
        stderr: "The Windows Subsystem for Linux instance has terminated.\nError code: Wsl/Service/E_FAIL\n",
      })
    })
    const refused = readDistroEndpoint({ distribution, run })
    await expect(refused).rejects.toMatchObject({ kind: "unavailable" })
    await expect(refused).rejects.toThrow(/Ubuntu-24\.04.*instance has terminated/s)
  })

  it("gives up on a wsl.exe that never answers, and says it timed out", async () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn<NonNullable<DistroEndpointInput["run"]>>(() => new Promise<string>(() => {}))
      const reading = readDistroEndpoint({ distribution, run, timeoutMs: 1_000 })
      const settled = Promise.all([
        expect(reading).rejects.toThrow(/did not answer within 1 seconds.*Ubuntu-24\.04/s),
        expect(reading).rejects.toMatchObject({ kind: "timed-out" }),
      ])
      await vi.advanceTimersByTimeAsync(1_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not treat an unrelated missing file as a missing endpoint", async () => {
    const run = reader(() => {
      throw Object.assign(new Error("/bin/wslpath: No such file or directory"), {
        code: 1,
        stderr: "/bin/wslpath: No such file or directory\n",
      })
    })
    await expect(readDistroEndpoint({ distribution, run })).rejects.toThrow(/wslpath/)
  })

  it("gives the child a real deadline even when asked for none", async () => {
    const run = reader(JSON.stringify({ host: "127.0.0.1", port: 47831, token }))
    await readDistroEndpoint({ distribution, run, timeoutMs: 0 })
    const options = run.mock.calls[0]?.[2] as { timeoutMs: number } | undefined
    expect(options?.timeoutMs).toBeGreaterThan(0)
  })

  it("tells the runner how long it is allowed to take", async () => {
    const run = reader(JSON.stringify({ host: "127.0.0.1", port: 47831, token }))
    await readDistroEndpoint({ distribution, run, timeoutMs: 3_000 })
    expect(run).toHaveBeenCalledWith("wsl.exe", expect.any(Array), { timeoutMs: 3_000 })
  })

  it("reports a file it cannot read as corrupt, not as a missing daemon", async () => {
    for (const contents of ["not json at all", "[]", "42", "null", ""]) {
      const refused = readDistroEndpoint({ distribution, run: reader(contents) })
      await expect(refused).rejects.toMatchObject({ kind: "corrupt" })
      await expect(refused).rejects.toThrow(/endpoint file in Ubuntu-24\.04.*domovoid/s)
    }
  })

  it("never repeats a truncated file in the error, since it may hold part of the credential", async () => {
    const truncated = JSON.stringify({ host: "127.0.0.1", port: 47831, token }).slice(0, -6)
    await expect(readDistroEndpoint({ distribution, run: reader(truncated) })).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(token.slice(0, 8)) }),
    )
  })

  it("classifies an endpoint it refuses as corrupt", async () => {
    const run = reader(JSON.stringify({ host: "10.0.0.5", port: 47831, token }))
    await expect(readDistroEndpoint({ distribution, run })).rejects.toMatchObject({ kind: "corrupt" })
  })

  it("refuses an endpoint that would send the credential off the machine", async () => {
    for (const host of ["10.0.0.5", "example.test", "0.0.0.0"]) {
      const run = reader(JSON.stringify({ host, port: 47831, token }))
      await expect(readDistroEndpoint({ distribution, run })).rejects.toThrow(/loopback/)
    }
  })

  it("never repeats the credential in the error it raises", async () => {
    const run = reader(JSON.stringify({ host: "10.0.0.5", port: 47831, token }))
    await expect(readDistroEndpoint({ distribution, run })).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(token) }),
    )
  })

  it("refuses a port that is not a port", async () => {
    for (const port of [0, 70000, -1, 1.5, "47831", undefined]) {
      const run = reader(JSON.stringify({ host: "127.0.0.1", port, token }))
      await expect(readDistroEndpoint({ distribution, run })).rejects.toThrow(/port/)
    }
  })

  it("refuses an endpoint with no credential to authenticate with", async () => {
    for (const value of [undefined, "", 7]) {
      const run = reader(JSON.stringify({ host: "127.0.0.1", port: 47831, token: value }))
      await expect(readDistroEndpoint({ distribution, run })).rejects.toThrow(/credential/)
    }
  })

  it("accepts the IPv6 loopback the daemon may bind instead", async () => {
    const run = reader(JSON.stringify({ host: "::1", port: 47831, token }))
    expect(await readDistroEndpoint({ distribution, run })).toMatchObject({ host: "::1" })
  })

  it("refuses a distribution name wsl.exe would read as an option", async () => {
    const run = reader(JSON.stringify({ host: "127.0.0.1", port: 47831, token }))
    await expect(readDistroEndpoint({ distribution: "--exec", run })).rejects.toThrow(/distribution/)
    expect(run).not.toHaveBeenCalled()
  })
})
