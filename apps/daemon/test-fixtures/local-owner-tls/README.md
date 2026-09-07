# Local discovery TLS fixture

This key is public test data, not a credential. Never use it for a running daemon outside tests.
The self-signed P-256 certificate is valid from 2020-01-01 through 2120-01-01 and names only
`localhost`, not `127.0.0.1`. That mismatch is the negative hostname-verification case.

The fixtures keep discovery tests independent of an OpenSSL installation. Tests copy them into
their temporary profile, restrict the key there, and exercise a real TLS listener and client.
They still validate certificate dates and hostnames normally.

`localhost-chain.pem` contains a localhost leaf certificate and its issuing intermediate, without
the root certificate. This matches the chain shape supplied by certificate issuers such as
Let's Encrypt. Both certificates are valid from 2020-01-01 through 2120-01-01. The leaf uses
the same public test key as the self-signed fixture. The intermediate was signed by a synthetic
fixture root; neither signing key is retained or trusted outside these fixtures.

`expired-chain.pem` contains an otherwise equivalent leaf that expired on 2021-01-01, followed
by the same valid intermediate. It proves that trusting a configured intermediate does not
disable certificate expiry checks. None of these certificates names `127.0.0.1`.
