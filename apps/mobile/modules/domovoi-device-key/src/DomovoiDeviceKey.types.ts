// Where the private key actually lives, as the platform reports it rather than
// as the app hopes. "software" means the key is not protected by hardware.
export type KeySecurityLevel =
  | "secure-enclave"
  | "strongbox"
  | "trusted-environment"
  | "software"
  | "unknown"

export type StaticKeyReport = {
  // Base64 of the 65 byte uncompressed P-256 point, which is what the Noise IK
  // responder pin carries.
  publicKey: string
  securityLevel: KeySecurityLevel
}

export type DomovoiDeviceKeyApi = {
  isSupported(): boolean
  createStaticKey(alias: string, requireHardware: boolean): Promise<StaticKeyReport>
  getStaticKey(alias: string): Promise<StaticKeyReport | null>
  agree(alias: string, peerPublicKey: string): Promise<string>
  deleteStaticKey(alias: string): Promise<boolean>
  randomBytes(count: number): string
}
