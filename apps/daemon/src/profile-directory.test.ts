import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parseDaemonEnvironment } from "./config.js"
import { createServiceConfiguration, parseServiceConfiguration, serializeServiceConfiguration, serviceEnvironment } from "./service/configuration.js"

describe("explicit daemon profile directory", () => {
  const home = resolve("test-home")
  const profile = resolve("test-profiles", "isolated profile")

  it("defaults to the real home's Domovoi directory", () => {
    expect(parseDaemonEnvironment({}, home)).toMatchObject({
      profileDirectory: join(home, ".domovoi"),
    })
  })

  it("moves default credentials and identity without changing HOME", () => {
    const environment = { HOME: home, DOMOVOI_PROFILE_DIR: profile }
    expect(parseDaemonEnvironment(environment, home)).toMatchObject({
      profileDirectory: profile,
      credentialPath: join(profile, "daemon.token"),
      machineIdentityPath: join(profile, "machine.json"),
    })
    expect(environment.HOME).toBe(home)
  })

  it.each(["", "relative/profile", "~/profile", "bad\0path", "bad\npath", `${profile}\n`, `${profile}\r`, `${profile}\0`])("refuses an invalid profile path: %j", (value) => {
    expect(() => parseDaemonEnvironment({ DOMOVOI_PROFILE_DIR: value }, home)).toThrow("DOMOVOI_PROFILE_DIR")
  })

  it("retains explicit per-file overrides", () => {
    const credentialPath = join(home, "private", "token")
    const machineIdentityPath = join(home, "private", "identity.json")
    expect(parseDaemonEnvironment({ DOMOVOI_PROFILE_DIR: profile,
      DOMOVOI_CREDENTIAL_PATH: credentialPath, DOMOVOI_MACHINE_IDENTITY_PATH: machineIdentityPath,
    }, home)).toMatchObject({ profileDirectory: profile, credentialPath, machineIdentityPath })
  })

  it("saves the chosen profile separately from the provider home", () => {
    const config = createServiceConfiguration({ DOMOVOI_PROFILE_DIR: profile }, {
      homeDirectory: home, workingDirectory: home, platform: process.platform,
    })
    const restored = parseServiceConfiguration(serializeServiceConfiguration(config))
    expect(restored).toMatchObject({ homeDirectory: home, profileDirectory: profile })
    expect(serviceEnvironment(restored)).toMatchObject({ DOMOVOI_PROFILE_DIR: profile })
  })

  it("keeps legacy service configurations bound to the saved home", () => {
    const { profileDirectory: _profile, ...legacy } = createServiceConfiguration({}, {
      homeDirectory: home, workingDirectory: home, platform: process.platform,
    })
    expect(serviceEnvironment(parseServiceConfiguration(JSON.stringify(legacy))).DOMOVOI_PROFILE_DIR)
      .toBe(join(home, ".domovoi"))
  })
})
