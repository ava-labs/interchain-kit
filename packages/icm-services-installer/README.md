# @interchain-kit/icm-services-installer

Pulls pinned prebuilt `icm-relayer` and `signature-aggregator` binaries from
[`ava-labs/icm-services`](https://github.com/ava-labs/icm-services) releases.

## Pinned versions

| Binary | Version | Release tag |
|---|---|---|
| `icm-relayer` | v1.7.5 | `icm-relayer-v1.7.5` |
| `signature-aggregator` | v0.5.4 | `signature-aggregator-v0.5.4` |

## Cache

Binaries land under `.interchain-kit/bin/<binary>-<version>` and are reused across runs.

To bump: update the constants in `src/index.ts` and commit.
