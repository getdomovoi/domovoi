import { describe, expect, it } from "vitest"

import { pairingAddressSchema } from "@getdomovoi/protocol"

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

// Thirty names, generated with openssl for the bound on a problem's length.
const thirtyNames = `-----BEGIN CERTIFICATE-----
MIIGHTCCBcKgAwIBAgIUeLuAFdE5PuMn2vEpI0Yqp1IBqAAwCgYIKoZIzj0EAwIw
LjEsMCoGA1UEAwwjaG9zdC0wMS5leGFtcGxlLXRhaWxuZXQtbmFtZS50cy5uZXQw
HhcNMjYwOTIzMjE1MDI5WhcNMzYwOTIwMjE1MDI5WjAuMSwwKgYDVQQDDCNob3N0
LTAxLmV4YW1wbGUtdGFpbG5ldC1uYW1lLnRzLm5ldDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABALS8zjE+WzscgQKPAqFOhEbj7M+IBhJtwFZ2sCwHPgQNFsquVsW
97tRpHv0zRoRGanBS+YoylkSN89IOT8OdTmjggS8MIIEuDAdBgNVHQ4EFgQUwWm+
34X+Xsr8rcsNM4B//okWtyowHwYDVR0jBBgwFoAUwWm+34X+Xsr8rcsNM4B//okW
tyowDwYDVR0TAQH/BAUwAwEB/zCCBGMGA1UdEQSCBFowggRWgiNob3N0LTAxLmV4
YW1wbGUtdGFpbG5ldC1uYW1lLnRzLm5ldIIjaG9zdC0wMi5leGFtcGxlLXRhaWxu
ZXQtbmFtZS50cy5uZXSCI2hvc3QtMDMuZXhhbXBsZS10YWlsbmV0LW5hbWUudHMu
bmV0giNob3N0LTA0LmV4YW1wbGUtdGFpbG5ldC1uYW1lLnRzLm5ldIIjaG9zdC0w
NS5leGFtcGxlLXRhaWxuZXQtbmFtZS50cy5uZXSCI2hvc3QtMDYuZXhhbXBsZS10
YWlsbmV0LW5hbWUudHMubmV0giNob3N0LTA3LmV4YW1wbGUtdGFpbG5ldC1uYW1l
LnRzLm5ldIIjaG9zdC0wOC5leGFtcGxlLXRhaWxuZXQtbmFtZS50cy5uZXSCI2hv
c3QtMDkuZXhhbXBsZS10YWlsbmV0LW5hbWUudHMubmV0giNob3N0LTEwLmV4YW1w
bGUtdGFpbG5ldC1uYW1lLnRzLm5ldIIjaG9zdC0xMS5leGFtcGxlLXRhaWxuZXQt
bmFtZS50cy5uZXSCI2hvc3QtMTIuZXhhbXBsZS10YWlsbmV0LW5hbWUudHMubmV0
giNob3N0LTEzLmV4YW1wbGUtdGFpbG5ldC1uYW1lLnRzLm5ldIIjaG9zdC0xNC5l
eGFtcGxlLXRhaWxuZXQtbmFtZS50cy5uZXSCI2hvc3QtMTUuZXhhbXBsZS10YWls
bmV0LW5hbWUudHMubmV0giNob3N0LTE2LmV4YW1wbGUtdGFpbG5ldC1uYW1lLnRz
Lm5ldIIjaG9zdC0xNy5leGFtcGxlLXRhaWxuZXQtbmFtZS50cy5uZXSCI2hvc3Qt
MTguZXhhbXBsZS10YWlsbmV0LW5hbWUudHMubmV0giNob3N0LTE5LmV4YW1wbGUt
dGFpbG5ldC1uYW1lLnRzLm5ldIIjaG9zdC0yMC5leGFtcGxlLXRhaWxuZXQtbmFt
ZS50cy5uZXSCI2hvc3QtMjEuZXhhbXBsZS10YWlsbmV0LW5hbWUudHMubmV0giNo
b3N0LTIyLmV4YW1wbGUtdGFpbG5ldC1uYW1lLnRzLm5ldIIjaG9zdC0yMy5leGFt
cGxlLXRhaWxuZXQtbmFtZS50cy5uZXSCI2hvc3QtMjQuZXhhbXBsZS10YWlsbmV0
LW5hbWUudHMubmV0giNob3N0LTI1LmV4YW1wbGUtdGFpbG5ldC1uYW1lLnRzLm5l
dIIjaG9zdC0yNi5leGFtcGxlLXRhaWxuZXQtbmFtZS50cy5uZXSCI2hvc3QtMjcu
ZXhhbXBsZS10YWlsbmV0LW5hbWUudHMubmV0giNob3N0LTI4LmV4YW1wbGUtdGFp
bG5ldC1uYW1lLnRzLm5ldIIjaG9zdC0yOS5leGFtcGxlLXRhaWxuZXQtbmFtZS50
cy5uZXSCI2hvc3QtMzAuZXhhbXBsZS10YWlsbmV0LW5hbWUudHMubmV0MAoGCCqG
SM49BAMCA0kAMEYCIQCYTs7IU7aj7kNez7GM4ZMezQVVgvTkdHCWr2z4abDgowIh
ANJ+5NnKvR9pysWc4WcT72EO/pxvdG/9w15K3uyfLZs3
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

  it("keeps every problem within the wire's bound, however many names the certificate carries", () => {
    expect(certificateHostNames(thirtyNames)).toHaveLength(30)
    const result = pairingAddressFor({ host: "100.80.185.103", port: 47831, tls: { certPath: "/c" } }, () => thirtyNames)
    expect(result).toEqual({ problem: expect.stringContaining("more than one host") })
    expect(pairingAddressSchema.safeParse(result).success).toBe(true)
    expect((result as { problem: string }).problem).toContain("host-01.example-tailnet-name.ts.net")
    expect((result as { problem: string }).problem).toContain("and 27 more")
    const longPath = `/${"deep/".repeat(200)}daemon.crt`
    const unreadable = pairingAddressFor({ host: "100.80.185.103", port: 47831, tls: { certPath: longPath } }, () => { throw new Error("ENOENT") })
    expect(pairingAddressSchema.safeParse(unreadable).success).toBe(true)
  })

  it("says only this machine can reach a TLS listener bound to loopback", () => {
    expect(pairingAddressFor({ host: "127.0.0.1", port: 47831, tls: { certPath: "/c" } }, () => oneName)).toEqual({
      url: "wss://djs-test.raptor-pompano.ts.net:47831/rpc",
      label: "djs-test.raptor-pompano.ts.net",
      loopback: true,
    })
  })
})
