# Vendored local-network staking keys

These are the **5 canonical local-network staker key sets** shipped by
[ava-labs/avalanchego](https://github.com/ava-labs/avalanchego) under
`staking/local/`, vendored here at tag **v1.14.0** (matching the pinned
avalanchego version in `@interchain-kit/icm-services-installer`).

- `staker{1..5}.crt` / `staker{1..5}.key` — TLS cert + key per node
- `signer{1..5}.key` — BLS signer key per node

## Why vendor them?

avalanchego's `--network-id=local` genesis stamps exactly these 5 NodeIDs into
the initial primary-network validator set. Without their key files, nodes boot
with ephemeral certs, hold NodeIDs that aren't in the genesis validator set, and
the primary network never leaves bootstrap. avalanchego **release tarballs do
not include these files** (they're embedded in the binary's genesis, not shipped
as files), so `tmpnetjs` vendors them to make `pnpm run up` work with zero setup.

## Are these secret?

**No.** They are public test fixtures committed in the open-source avalanchego
repo and are valid **only** for `--network-id=local`. They confer no authority
on Fuji or Mainnet. Never reuse them for anything but a local throwaway network.

`AVALANCHEGO_STAKING_KEYS_DIR` overrides this directory if you need different keys.
