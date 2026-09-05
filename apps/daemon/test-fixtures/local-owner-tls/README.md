# Local discovery TLS fixture

This key is public test data, not a credential. Never use it for a running daemon outside tests.
The self-signed P-256 certificate is valid from 2020-01-01 through 2120-01-01 and names only
`localhost`, not `127.0.0.1`. That mismatch is the negative hostname-verification case.

The fixtures keep discovery tests independent of an OpenSSL installation. Tests copy them into
their temporary profile, restrict the key there, and exercise a real TLS listener and client.
They still validate certificate dates and hostnames normally.
