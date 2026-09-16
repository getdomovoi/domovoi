import { describe, expect, it } from "vitest"

import { certificateHostNames, pairingAddressFor } from "./pairing-address.js"

// Real certificates, generated for this test with openssl and trusted by
// nothing. The first names one host, the way `tailscale cert` writes one; the
// second names two, which is the case this command refuses to choose between.
const oneName = `-----BEGIN CERTIFICATE-----
MIIB0TCCAXigAwIBAgIUGNO8JFD59NjBSA5i/O3rE6rama4wCgYIKoZIzj0EAwIw
KTEnMCUGA1UEAwweZGpzLXRlc3QucmFwdG9yLXBvbXBhbm8udHMubmV0MB4XDTI2
MDkxNjE3NDI1OVoXDTM2MDkxMzE3NDI1OVowKTEnMCUGA1UEAwweZGpzLXRlc3Qu
cmFwdG9yLXBvbXBhbm8udHMubmV0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE
4SG3c4AvfccZvVgPx23/dHOBIzDEZ4IV3E9inxZjQsFMttBn18AuTAVDzfmdtQM/
3NcNg4TBrsYEYMFoodWo46N+MHwwHQYDVR0OBBYEFDhYTMbdaUKsuaBFhiUPsRq0
emXCMB8GA1UdIwQYMBaAFDhYTMbdaUKsuaBFhiUPsRq0emXCMA8GA1UdEwEB/wQF
MAMBAf8wKQYDVR0RBCIwIIIeZGpzLXRlc3QucmFwdG9yLXBvbXBhbm8udHMubmV0
MAoGCCqGSM49BAMCA0cAMEQCIHSvb9XoVzStMskWWNWLbKiLMneebwdELKOQLUoh
g1o2AiAAwx5qzo/uSOyz5JlYByVG1l28TPNAJDW+tDGGt23zww==
-----END CERTIFICATE-----
`
const twoNames = `-----BEGIN CERTIFICATE-----
MIIBvTCCAWKgAwIBAgIUfMUDbFvpm/3l8CJV+4tmI/K8N04wCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQYS5leGFtcGxlLnRzLm5ldDAeFw0yNjA5MTYxNzQzMTNaFw0z
NjA5MTMxNzQzMTNaMBsxGTAXBgNVBAMMEGEuZXhhbXBsZS50cy5uZXQwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAARIVBD4uT2avZQv85uFOWeJ5pXv3/3zs6ZVOiVg
ZIFzV7KGzy95ZyiBT8FWgmi/c41IAhZ5c06gHA2gSsa03H65o4GDMIGAMB0GA1Ud
DgQWBBT9ZLf3/yhkeP1OLvTc10uG3iOlHjAfBgNVHSMEGDAWgBT9ZLf3/yhkeP1O
LvTc10uG3iOlHjAPBgNVHRMBAf8EBTADAQH/MC0GA1UdEQQmMCSCEGEuZXhhbXBs
ZS50cy5uZXSCEGIuZXhhbXBsZS50cy5uZXQwCgYIKoZIzj0EAwIDSQAwRgIhAJAI
CIJLSMT7VIa02MpOFxWtYPHxCTD1T82O+xp2XcO8AiEA+YQNQz4psfsndicZGoRs
t+NFfYwmc7wvHFbdEZFfo4g=
-----END CERTIFICATE-----
`

describe("the address a pairing code tells a device to dial", () => {
  it("is the loopback listener itself when there is no certificate", () => {
    const address = pairingAddressFor({ host: "127.0.0.1", port: 47831 }, () => { throw new Error("no certificate") })
    expect(address).toEqual({ url: "ws://127.0.0.1:47831/rpc", loopback: true })
  })

  it("refuses a listener a device cannot verify", () => {
    expect(pairingAddressFor({ host: "100.80.185.103", port: 47831 }, () => "")).toEqual({
      problem: expect.stringContaining("serves no certificate"),
    })
  })

  it("says the certificate could not be read rather than naming the bind address", () => {
    const result = pairingAddressFor(
      { host: "100.80.185.103", port: 47831, tls: { certPath: "/missing.crt" } },
      () => { throw new Error("ENOENT") },
    )
    expect(result).toEqual({ problem: expect.stringContaining("/missing.crt") })
    expect(JSON.stringify(result)).not.toContain("100.80.185.103")
  })

  it("refuses a certificate that names no host, rather than guessing one", () => {
    expect(pairingAddressFor({ host: "100.80.185.103", port: 47831, tls: { certPath: "/c" } }, () => "not a certificate"))
      .toEqual({ problem: expect.stringContaining("names no host") })
  })

  it("carries the name on the certificate, not the address the daemon binds", () => {
    // The documented tailnet setup: bound to an IPv4 address, serving a
    // certificate for the DNS name. The code must say the name.
    expect(certificateHostNames(oneName)).toEqual(["djs-test.raptor-pompano.ts.net"])
    const address = pairingAddressFor(
      { host: "100.80.185.103", port: 47831, tls: { certPath: "/c" } },
      () => oneName,
    )
    expect(address).toEqual({
      url: "wss://djs-test.raptor-pompano.ts.net:47831/rpc",
      label: "djs-test.raptor-pompano.ts.net",
      loopback: false,
    })
  })

  it("will not choose between names when the certificate carries several", () => {
    expect(certificateHostNames(twoNames)).toEqual(["a.example.ts.net", "b.example.ts.net"])
    expect(pairingAddressFor({ host: "100.80.185.103", port: 47831, tls: { certPath: "/c" } }, () => twoNames))
      .toEqual({ problem: expect.stringContaining("more than one host") })
  })

  it("keeps wildcard names out, since they name no single host", () => {
    expect(certificateHostNames("")).toEqual([])
  })
})
