import CryptoKit
import ExpoModulesCore
import Security

private let service = "sh.domovoi.device-key"
private let uncompressedPointBytes = 65

private func keychainQuery(_ alias: String) -> [String: Any] {
  [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: alias,
  ]
}

private func loadRepresentation(_ alias: String) -> Data? {
  var query = keychainQuery(alias)
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  var item: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
  return item as? Data
}

private func storeRepresentation(_ alias: String, _ representation: Data) throws {
  SecItemDelete(keychainQuery(alias) as CFDictionary)
  var query = keychainQuery(alias)
  query[kSecValueData as String] = representation
  query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
  let status = SecItemAdd(query as CFDictionary, nil)
  guard status == errSecSuccess else {
    throw DeviceKeyKeychainException("The key handle could not be stored, status \(status)")
  }
}

internal final class DeviceKeyUnsupportedException: GenericException<String> {
  override var reason: String { param }
}

internal final class DeviceKeyMissingException: GenericException<String> {
  override var reason: String { "No static key is stored under \(param)" }
}

internal final class DeviceKeyPeerException: GenericException<String> {
  override var reason: String { param }
}

internal final class DeviceKeyKeychainException: GenericException<String> {
  override var reason: String { param }
}

public class DomovoiDeviceKeyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DomovoiDeviceKey")

    Function("isSupported") { SecureEnclave.isAvailable }

    AsyncFunction("createStaticKey") { (alias: String, requireHardware: Bool) -> [String: Any] in
      if !SecureEnclave.isAvailable && requireHardware {
        throw DeviceKeyUnsupportedException("This device has no Secure Enclave")
      }
      if SecureEnclave.isAvailable {
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey()
        try storeRepresentation(alias, key.dataRepresentation)
        return report(key.publicKey, "secure-enclave")
      }
      let key = P256.KeyAgreement.PrivateKey()
      try storeRepresentation(alias, key.rawRepresentation)
      return report(key.publicKey, "software")
    }

    AsyncFunction("getStaticKey") { (alias: String) -> [String: Any]? in
      guard let representation = loadRepresentation(alias) else { return nil }
      if SecureEnclave.isAvailable,
        let key = try? SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: representation) {
        return report(key.publicKey, "secure-enclave")
      }
      guard let key = try? P256.KeyAgreement.PrivateKey(rawRepresentation: representation) else {
        return nil
      }
      return report(key.publicKey, "software")
    }

    AsyncFunction("agree") { (alias: String, peerPublicKey: String) -> String in
      guard let representation = loadRepresentation(alias) else {
        throw DeviceKeyMissingException(alias)
      }
      let peer = try decodePeer(peerPublicKey)
      let secret: SharedSecret
      if SecureEnclave.isAvailable,
        let key = try? SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: representation) {
        secret = try key.sharedSecretFromKeyAgreement(with: peer)
      } else {
        let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: representation)
        secret = try key.sharedSecretFromKeyAgreement(with: peer)
      }
      return secret.withUnsafeBytes { Data($0).base64EncodedString() }
    }

    AsyncFunction("deleteStaticKey") { (alias: String) -> Bool in
      let existed = loadRepresentation(alias) != nil
      SecItemDelete(keychainQuery(alias) as CFDictionary)
      return existed
    }

    Function("randomBytes") { (count: Int) -> String in
      if count <= 0 || count > 1024 {
        throw DeviceKeyPeerException("Ask for 1 to 1024 bytes")
      }
      var bytes = [UInt8](repeating: 0, count: count)
      let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
      guard status == errSecSuccess else {
        throw DeviceKeyKeychainException("The system random source failed, status \(status)")
      }
      return Data(bytes).base64EncodedString()
    }
  }

  private func report(_ publicKey: P256.KeyAgreement.PublicKey, _ level: String) -> [String: Any] {
    ["publicKey": publicKey.x963Representation.base64EncodedString(), "securityLevel": level]
  }

  private func decodePeer(_ peerPublicKey: String) throws -> P256.KeyAgreement.PublicKey {
    guard let bytes = Data(base64Encoded: peerPublicKey) else {
      throw DeviceKeyPeerException("The peer public key is not base64")
    }
    guard bytes.count == uncompressedPointBytes, bytes.first == 4 else {
      throw DeviceKeyPeerException("The peer public key must be a 65 byte uncompressed P-256 point")
    }
    do {
      return try P256.KeyAgreement.PublicKey(x963Representation: bytes)
    } catch {
      throw DeviceKeyPeerException("The peer public key is not a point on P-256")
    }
  }
}
