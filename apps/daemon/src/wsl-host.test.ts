import { describe, expect, it } from "vitest"

import { wslHostFacts } from "./wsl-host.js"

const wsl2 = { WSL_DISTRO_NAME: "Ubuntu-24.04", WSL_INTEROP: "/run/WSL/8_interop" }
const wsl2Kernel = () => "5.15.167.4-microsoft-standard-WSL2\n"
const wsl1Kernel = () => "4.4.0-19041-Microsoft\n"
const plainKernel = () => "6.12.4-arch1-1\n"

describe("wslHostFacts", () => {
  it("names the distribution a Linux daemon runs in under WSL 2", () => {
    expect(wslHostFacts({ platform: "linux", environment: wsl2, readOsRelease: wsl2Kernel }))
      .toEqual({ distribution: "Ubuntu-24.04", version: 2 })
  })

  it("reports WSL 1 where no interop socket is offered and the kernel is Microsoft's", () => {
    expect(wslHostFacts({
      platform: "linux",
      environment: { WSL_DISTRO_NAME: "Legacy" },
      readOsRelease: wsl1Kernel,
    })).toEqual({ distribution: "Legacy", version: 1 })
  })

  it("reads the version from the kernel when the environment names only the distribution", () => {
    expect(wslHostFacts({
      platform: "linux",
      environment: { WSL_DISTRO_NAME: "Ubuntu-24.04" },
      readOsRelease: wsl2Kernel,
    })).toEqual({ distribution: "Ubuntu-24.04", version: 2 })
  })

  it("trusts the interop socket for the version when the kernel string cannot be read", () => {
    expect(wslHostFacts({
      platform: "linux",
      environment: wsl2,
      readOsRelease: () => {
        throw new Error("EACCES")
      },
    })).toEqual({ distribution: "Ubuntu-24.04", version: 2 })
  })

  it("reports nothing on a Linux machine outside WSL", () => {
    expect(wslHostFacts({ platform: "linux", environment: {}, readOsRelease: plainKernel })).toBeUndefined()
  })

  it("reports nothing off Linux, whatever the environment says", () => {
    for (const platform of ["win32", "darwin"] as const) {
      expect(wslHostFacts({ platform, environment: wsl2, readOsRelease: wsl2Kernel })).toBeUndefined()
    }
  })

  it("does not invent a distribution from the kernel alone", () => {
    expect(wslHostFacts({ platform: "linux", environment: {}, readOsRelease: wsl2Kernel })).toBeUndefined()
  })

  it("does not invent a distribution from a blank name", () => {
    expect(wslHostFacts({
      platform: "linux",
      environment: { WSL_DISTRO_NAME: "   ", WSL_INTEROP: "/run/WSL/8_interop" },
      readOsRelease: wsl2Kernel,
    })).toBeUndefined()
  })

  it("keeps a name too long for a fleet fact out of the facts", () => {
    expect(wslHostFacts({
      platform: "linux",
      environment: { ...wsl2, WSL_DISTRO_NAME: "u".repeat(129) },
      readOsRelease: wsl2Kernel,
    })).toBeUndefined()
  })
})
