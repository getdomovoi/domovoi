import { p256 } from "@noble/curves/nist.js"
import { describe, expect, it } from "vitest"

import { probeDeviceKey } from "./device-key"
import type { DomovoiDeviceKeyApi, StaticKeyReport } from "../../modules/domovoi-device-key"

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

type FakeOptions = {
  supported?: boolean
  corruptAgreement?: boolean
  entropy?: Uint8Array
}

// A software stand-in for the platform key service. It is not evidence about a
// device; it exists so the probe's own logic is tested, including that a wrong
// shared secret is reported as wrong.
function fakeModule(options: FakeOptions = {}): DomovoiDeviceKeyApi {
  const keys = new Map<string, Uint8Array>()
  return {
    isSupported: () => options.supported ?? true,
    createStaticKey: async (alias: string): Promise<StaticKeyReport> => {
      const secretKey = p256.utils.randomSecretKey()
      keys.set(alias, secretKey)
      return {
        publicKey: encode(p256.getPublicKey(secretKey, false)),
        securityLevel: "trusted-environment",
      }
    },
    getStaticKey: async (alias: string) => {
      const secretKey = keys.get(alias)
      if (!secretKey) return null
      return {
        publicKey: encode(p256.getPublicKey(secretKey, false)),
        securityLevel: "trusted-environment",
      }
    },
    agree: async (alias: string, peerPublicKey: string) => {
      const secretKey = keys.get(alias)
      if (!secretKey) throw new Error(`No static key under ${alias}`)
      const shared = p256.getSharedSecret(secretKey, decode(peerPublicKey), true).slice(1)
      if (options.corruptAgreement) shared.set([(shared.at(0) ?? 0) ^ 0xff], 0)
      return encode(shared)
    },
    deleteStaticKey: async (alias: string) => keys.delete(alias),
    randomBytes: (count: number) => encode(options.entropy ?? p256.utils.randomSecretKey().slice(0, count)),
  }
}

describe("device key probe", () => {
  it("agrees on the same secret as a software key", async () => {
    const report = await probeDeviceKey(fakeModule())
    expect(report.supported).toBe(true)
    expect(report.securityLevel).toBe("trusted-environment")
    expect(report.steps.filter((step) => !step.ok)).toEqual([])
    expect(report.steps.map((step) => step.name)).toEqual([
      "Platform key service",
      "System entropy",
      "Static key generation",
      "Handle survives a reopen",
      "Key agreement matches software",
      "Key removal",
    ])
  })

  it("reports a platform whose agreement disagrees with software", async () => {
    const report = await probeDeviceKey(fakeModule({ corruptAgreement: true }))
    const agreement = report.steps.find((step) => step.name === "Key agreement matches software")
    expect(agreement?.ok).toBe(false)
    expect(agreement?.detail).toBe("The platform and software secrets differ")
  })

  it("stops at the first step when the platform has no key service", async () => {
    const report = await probeDeviceKey(fakeModule({ supported: false }))
    expect(report.securityLevel).toBe("none")
    expect(report.steps).toHaveLength(1)
    expect(report.steps.at(0)?.ok).toBe(false)
  })

  it("fails the entropy step when the source repeats one byte", async () => {
    const report = await probeDeviceKey(fakeModule({ entropy: new Uint8Array(32) }))
    const entropy = report.steps.find((step) => step.name === "System entropy")
    expect(entropy?.ok).toBe(false)
    expect(entropy?.detail).toBe("32 bytes, 1 distinct values")
  })
})
