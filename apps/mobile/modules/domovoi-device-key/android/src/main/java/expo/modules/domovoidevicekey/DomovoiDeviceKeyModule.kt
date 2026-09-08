package expo.modules.domovoidevicekey

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.KeyAgreement

private const val KEYSTORE = "AndroidKeyStore"
private const val CURVE = "secp256r1"
private const val COORDINATE_BYTES = 32
private const val UNCOMPRESSED_POINT_BYTES = 65

class DeviceKeyUnsupportedException(message: String) :
  CodedException("ERR_DEVICE_KEY_UNSUPPORTED", message, null)

class DeviceKeyMissingException(alias: String) :
  CodedException("ERR_DEVICE_KEY_MISSING", "No static key is stored under $alias", null)

class DeviceKeyPeerException(message: String) :
  CodedException("ERR_DEVICE_KEY_PEER", message, null)

class DomovoiDeviceKeyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DomovoiDeviceKey")

    Function("isSupported") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.S }

    AsyncFunction("createStaticKey") { alias: String, requireHardware: Boolean ->
      requireAgreementSupport()
      val store = openStore()
      if (store.containsAlias(alias)) store.deleteEntry(alias)
      generate(alias, strongBox = true)
      val report = report(alias)
      if (requireHardware && report["securityLevel"] == "software") {
        openStore().deleteEntry(alias)
        throw DeviceKeyUnsupportedException("This device generated the static key in software")
      }
      report
    }

    AsyncFunction("getStaticKey") { alias: String ->
      if (!openStore().containsAlias(alias)) null else report(alias)
    }

    AsyncFunction("agree") { alias: String, peerPublicKey: String ->
      requireAgreementSupport()
      val privateKey = openStore().getKey(alias, null) as? PrivateKey
        ?: throw DeviceKeyMissingException(alias)
      val agreement = KeyAgreement.getInstance("ECDH", KEYSTORE)
      agreement.init(privateKey)
      agreement.doPhase(decodePeer(peerPublicKey), true)
      Base64.encodeToString(agreement.generateSecret(), Base64.NO_WRAP)
    }

    AsyncFunction("deleteStaticKey") { alias: String ->
      val store = openStore()
      val existed = store.containsAlias(alias)
      if (existed) store.deleteEntry(alias)
      existed
    }

    Function("randomBytes") { count: Int ->
      if (count <= 0 || count > 1024) throw DeviceKeyPeerException("Ask for 1 to 1024 bytes")
      val bytes = ByteArray(count)
      SecureRandom().nextBytes(bytes)
      Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
  }

  private fun openStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

  private fun requireAgreementSupport() {
    // PURPOSE_AGREE_KEY, and so a non-exportable P-256 agreement key, starts at API 31.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      throw DeviceKeyUnsupportedException("Key agreement in the platform key store needs Android 12")
    }
  }

  private fun generate(alias: String, strongBox: Boolean) {
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE)
    val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_AGREE_KEY)
      .setAlgorithmParameterSpec(ECGenParameterSpec(CURVE))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .also { if (strongBox) it.setIsStrongBoxBacked(true) }
      .build()
    try {
      generator.initialize(spec)
      generator.generateKeyPair()
    } catch (error: Exception) {
      // A device without StrongBox refuses the request rather than quietly downgrading it.
      if (!strongBox) throw error
      generate(alias, strongBox = false)
    }
  }

  private fun report(alias: String): Map<String, Any> {
    val store = openStore()
    val privateKey = store.getKey(alias, null) as? PrivateKey
      ?: throw DeviceKeyMissingException(alias)
    val certificate = store.getCertificate(alias) ?: throw DeviceKeyMissingException(alias)
    val point = (certificate.publicKey as ECPublicKey).w
    val encoded = ByteArray(UNCOMPRESSED_POINT_BYTES)
    encoded[0] = 4
    writeCoordinate(point.affineX, encoded, 1)
    writeCoordinate(point.affineY, encoded, 1 + COORDINATE_BYTES)
    val info = KeyFactory.getInstance(privateKey.algorithm, KEYSTORE)
      .getKeySpec(privateKey, KeyInfo::class.java)
    return mapOf(
      "publicKey" to Base64.encodeToString(encoded, Base64.NO_WRAP),
      "securityLevel" to securityLevel(info),
    )
  }

  private fun securityLevel(info: KeyInfo): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      return when (info.securityLevel) {
        KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
        KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "trusted-environment"
        KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
        else -> "unknown"
      }
    }
    @Suppress("DEPRECATION")
    return if (info.isInsideSecureHardware) "trusted-environment" else "software"
  }

  private fun writeCoordinate(coordinate: BigInteger, target: ByteArray, offset: Int) {
    // BigInteger.toByteArray is signed and variable length; the wire format is a fixed 32 bytes.
    val source = coordinate.toByteArray()
    val trimmed = if (source.size > COORDINATE_BYTES) {
      source.copyOfRange(source.size - COORDINATE_BYTES, source.size)
    } else {
      source
    }
    System.arraycopy(trimmed, 0, target, offset + (COORDINATE_BYTES - trimmed.size), trimmed.size)
  }

  private fun decodePeer(peerPublicKey: String): PublicKey {
    val bytes = try {
      Base64.decode(peerPublicKey, Base64.NO_WRAP)
    } catch (error: IllegalArgumentException) {
      throw DeviceKeyPeerException("The peer public key is not base64")
    }
    if (bytes.size != UNCOMPRESSED_POINT_BYTES || bytes[0].toInt() != 4) {
      throw DeviceKeyPeerException("The peer public key must be a 65 byte uncompressed P-256 point")
    }
    val x = BigInteger(1, bytes.copyOfRange(1, 1 + COORDINATE_BYTES))
    val y = BigInteger(1, bytes.copyOfRange(1 + COORDINATE_BYTES, UNCOMPRESSED_POINT_BYTES))
    val parameters = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec(CURVE)) }
    val spec = parameters.getParameterSpec(ECParameterSpec::class.java)
    return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), spec))
  }
}
