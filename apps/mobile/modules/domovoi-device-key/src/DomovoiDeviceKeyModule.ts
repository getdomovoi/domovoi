import { NativeModule, requireNativeModule } from "expo"

import type { DomovoiDeviceKeyApi, StaticKeyReport } from "./DomovoiDeviceKey.types"

declare class DomovoiDeviceKeyModule extends NativeModule<Record<string, never>> implements DomovoiDeviceKeyApi {
  isSupported(): boolean
  createStaticKey(alias: string, requireHardware: boolean): Promise<StaticKeyReport>
  getStaticKey(alias: string): Promise<StaticKeyReport | null>
  agree(alias: string, peerPublicKey: string): Promise<string>
  deleteStaticKey(alias: string): Promise<boolean>
  randomBytes(count: number): string
}

export default requireNativeModule<DomovoiDeviceKeyModule>("DomovoiDeviceKey")
