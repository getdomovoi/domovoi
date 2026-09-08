"""Independent fixture derivation, not a connection implementation.

Requires Python cryptography 50.0.1. CI reads the checked-in JSON, not this script.
Run from any directory, with no arguments to check or --write to regenerate.
The published A and B vectors must match before a derived C result is accepted.
"""

import hashlib
import hmac
import json
from pathlib import Path
import sys

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, x25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM, ChaCha20Poly1305


HERE = Path(__file__).resolve().parent
P256_SUITE = "Noise_IK_P256_AESGCM_SHA256"


def derive(source, suite):
    p256 = "_P256_" in suite
    aes = "_AESGCM_" in suite

    def private(field):
        raw = bytes.fromhex(source[field])
        if p256:
            return ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())
        return x25519.X25519PrivateKey.from_private_bytes(raw)

    def public(key):
        if p256:
            return key.public_key().public_bytes(
                serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
            )
        return key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )

    def dh(own, other):
        if p256:
            return own.exchange(ec.ECDH(), other.public_key())
        return own.exchange(other.public_key())

    def hkdf(chaining, material):
        temp = hmac.digest(chaining, material, "sha256")
        first = hmac.digest(temp, b"\x01", "sha256")
        return first, hmac.digest(temp, first + b"\x02", "sha256")

    def encrypt(key, counter, plaintext, ad):
        nonce = bytes(4) + counter.to_bytes(8, "big" if aes else "little")
        cipher = AESGCM(key) if aes else ChaCha20Poly1305(key)
        return cipher.encrypt(nonce, plaintext, ad)

    name = suite.encode("ascii")
    transcript = name.ljust(32, b"\x00") if len(name) <= 32 else hashlib.sha256(name).digest()
    chaining = transcript
    key = None

    def mix_hash(data):
        nonlocal transcript
        transcript = hashlib.sha256(transcript + data).digest()

    def mix_key(secret):
        nonlocal chaining, key
        chaining, key = hkdf(chaining, secret)

    def encrypt_hash(data):
        # Every handshake encryption in IK follows a fresh MixKey, nonce zero.
        ciphertext = encrypt(key, 0, data, transcript)
        mix_hash(ciphertext)
        return ciphertext

    si, ei = private("init_static"), private("init_ephemeral")
    sr, er = private("resp_static"), private("resp_ephemeral")
    payloads = [bytes.fromhex(message["payload"]) for message in source["messages"]]
    mix_hash(bytes.fromhex(source["init_prologue"]))
    mix_hash(public(sr))

    mix_hash(public(ei))
    mix_key(dh(ei, sr))
    encrypted_static = encrypt_hash(public(si))
    mix_key(dh(si, sr))
    frames = [public(ei) + encrypted_static + encrypt_hash(payloads[0])]

    mix_hash(public(er))
    mix_key(dh(ei, er))
    mix_key(dh(si, er))
    frames.append(public(er) + encrypt_hash(payloads[1]))
    sending_keys = hkdf(chaining, b"")
    for index, payload in enumerate(payloads[2:]):
        frames.append(encrypt(sending_keys[index % 2], index // 2, payload, b""))

    result = {key: value for key, value in source.items() if key != "_source"}
    result.update(
        protocol_name=suite,
        init_remote_static=public(sr).hex(),
        handshake_hash=transcript.hex(),
        messages=[
            {"payload": payload.hex(), "ciphertext": frame.hex()}
            for payload, frame in zip(payloads, frames, strict=True)
        ],
    )
    return result


def main():
    if sys.argv[1:] not in ([], ["--write"]):
        raise SystemExit("Usage: python3 derive-p256-fixture.py [--write]")
    reference = None
    for filename in ("cacophony-ik.json", "cacophony-ik-aesgcm.json"):
        reference = json.loads((HERE / filename).read_text())
        expected = {key: value for key, value in reference.items() if key != "_source"}
        if derive(reference, reference["protocol_name"]) != expected:
            raise SystemExit(f"Published reference mismatch: {filename}")
    assert reference is not None
    output = {
        "_source": {
            **reference["_source"],
            "derivation": "Cacophony inputs, locally derived P-256 outputs; not a published Cacophony vector",
            "profile": "Snow 0.10.0 P256: 65-byte uncompressed SEC1 public key, 32-byte big-endian ECDH x coordinate",
            "profile_commit": "4bb43f50370bdb3e8b1b57814ac662864db2704f",
            "generator": "derive-p256-fixture.py; Python cryptography 50.0.1; checked against published A and B first",
            "private_key_interpretation": "The same public fixture bytes interpreted as big-endian P-256 scalars",
        },
        **derive(reference, P256_SUITE),
    }
    path = HERE / "cacophony-derived-p256.json"
    if sys.argv[1:] == ["--write"]:
        path.write_text(json.dumps(output, indent=2) + "\n")
    elif json.loads(path.read_text()) != output:
        raise SystemExit("Derived P-256 fixture mismatch")
    print("Published A and B match; derived P-256 fixture matches.")


if __name__ == "__main__":
    main()
