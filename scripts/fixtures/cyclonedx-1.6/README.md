# CycloneDX 1.6 validation fixtures

Unmodified JSON schemas from the upstream [CycloneDX 1.6 specification](https://github.com/CycloneDX/specification/tree/1.6/schema),
retrieved 2026-09-05. The upstream schemas declare Apache-2.0 licensing, the same license
included in this repository's [LICENSE](../../../LICENSE).

`scripts/cyclonedx-validation.mjs` pins each file's SHA-256 and registers every reference
locally. Release generation and tests never fetch a schema. Review a schema update as an
explicit validation change, including its digest and format support.

| File | SHA-256 |
| --- | --- |
| bom-1.6.schema.json | 3e92dddbc30cf7f6a02b80f0942b1a4cfd4fb1c26f1dfc4310afa9d613cafb93 |
| jsf-0.82.schema.json | 8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae |
| spdx.schema.json | baa9d3bd1ed57b6751b0887edead6b5063ff53ff7429cf85d476c6c94af0166e |

Schema validation establishes format conformance, not inventory completeness or package
authenticity. The real-release test separately compares coordinates and hashes with the
lock extracted from the packed daemon archive.
