import { p256 } from "@noble/curves/nist.js"

import type { DomovoiDeviceKeyApi, KeySecurityLevel } from "../../modules/domovoi-device-key"

export type ProbeStep = {
  name: string
  ok: boolean
  detail: string
}

export type ProbeReport = {
  supported: boolean
  securityLevel: KeySecurityLevel | "none"
  steps: ProbeStep[]
}

const probeAlias = "domovoi.probe.static"
const sharedSecretBytes = 32
const uncompressedPointBytes = 65

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

// The platform holds the static key and will never hand it back, so the only
// way to check its arithmetic is to agree with a key this side does hold: run
// the same ECDH in software against the platform's public point and require the
// two shared secrets to be identical.
export async function probeDeviceKey(module: DomovoiDeviceKeyApi): Promise<ProbeReport> {
  const steps: ProbeStep[] = []
  const supported = module.isSupported()
  steps.push({
    name: "Platform key service",
    ok: supported,
    detail: supported ? "Reports key agreement support" : "No platform key agreement on this device",
  })
  if (!supported) return { supported, securityLevel: "none", steps }

  const entropy = module.randomBytes(32)
  const entropyBytes = decode(entropy)
  const distinct = new Set(entropyBytes).size
  steps.push({
    name: "System entropy",
    ok: entropyBytes.length === 32 && distinct > 8,
    detail: `${entropyBytes.length} bytes, ${distinct} distinct values`,
  })

  await module.deleteStaticKey(probeAlias)
  const created = await module.createStaticKey(probeAlias, false)
  const devicePublicKey = decode(created.publicKey)
  steps.push({
    name: "Static key generation",
    ok: devicePublicKey.length === uncompressedPointBytes && devicePublicKey[0] === 4,
    detail: `${devicePublicKey.length} byte public point, level ${created.securityLevel}`,
  })

  const reopened = await module.getStaticKey(probeAlias)
  steps.push({
    name: "Handle survives a reopen",
    ok: reopened?.publicKey === created.publicKey,
    detail: reopened ? "Same public point returned" : "The key could not be reopened",
  })

  const softwarePrivateKey = p256.utils.randomSecretKey()
  const softwarePublicKey = p256.getPublicKey(softwarePrivateKey, false)
  const deviceSecret = decode(await module.agree(probeAlias, encode(softwarePublicKey)))
  // A compressed agreement result is the 32 byte x coordinate behind one prefix
  // byte, which is the value both ECDH implementations are expected to produce.
  const softwareSecret = p256.getSharedSecret(softwarePrivateKey, devicePublicKey, true).slice(1)
  const agreed =
    deviceSecret.length === sharedSecretBytes &&
    softwareSecret.length === sharedSecretBytes &&
    deviceSecret.every((byte, index) => byte === softwareSecret[index])
  steps.push({
    name: "Key agreement matches software",
    ok: agreed,
    detail: agreed
      ? `${deviceSecret.length} byte shared secret, identical both sides`
      : "The platform and software secrets differ",
  })

  const removed = await module.deleteStaticKey(probeAlias)
  steps.push({
    name: "Key removal",
    ok: removed,
    detail: removed ? "Probe key deleted" : "The probe key could not be deleted",
  })

  return { supported, securityLevel: created.securityLevel, steps }
}
