import { registerWebModule, NativeModule } from "expo"

import type { StaticKeyReport } from "./DomovoiDeviceKey.types"

// A browser has no platform key service that keeps a P-256 static key
// non-exportable, so the web build reports no support rather than falling back
// to a software key that would look like the same guarantee.
class DomovoiDeviceKeyModule extends NativeModule<Record<string, never>> {
  isSupported(): boolean {
    return false
  }

  async createStaticKey(): Promise<StaticKeyReport> {
    throw new Error("Domovoi device keys need a platform key service")
  }

  async getStaticKey(): Promise<StaticKeyReport | null> {
    return null
  }

  async agree(): Promise<string> {
    throw new Error("Domovoi device keys need a platform key service")
  }

  async deleteStaticKey(): Promise<boolean> {
    return false
  }

  randomBytes(count: number): string {
    if (count <= 0 || count > 1024) throw new Error("Ask for 1 to 1024 bytes")
    const bytes = new Uint8Array(count)
    crypto.getRandomValues(bytes)
    return btoa(String.fromCharCode(...bytes))
  }
}

export default registerWebModule(DomovoiDeviceKeyModule, "DomovoiDeviceKeyModule")
