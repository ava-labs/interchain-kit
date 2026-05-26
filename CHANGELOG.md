# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-26

Initial public release.

### Added
- Foundry harness for running real, unmodified icm-contracts (Teleporter + ICTT v1.0.9) inside a single EVM via an etched Warp precompile
- `tmpnetjs` — JS analog of avalanchego's `tmpnet`. Boots a local Avalanche network (primary nodes + L1s) with Teleporter, ICTT, `icm-relayer`, and `signature-aggregator` via one command
- Producer SDK (`up`, `down`, `clean`, `captureSnapshot`, …) and consumer SDK (`loadNetwork`, `makeClients`, `pickL1`, `pollUntil`, `blockchainIdToBytes32`)
- `@interchain-kit/icm-services-installer` — pinned download + checksum verification of `icm-relayer v1.7.5` and `signature-aggregator v0.5.4`
- Four end-to-end examples: ICM hello-world, ICTT ERC20 round-trip, ValidatorManager deploy + upgrade + initializeValidatorSet, and L1 validator registration
- 18 harness tests across icm-basics (incl. non-zero fee paths and the universal-deployer assertion), ictt-erc20, ictt-native, and teleporter-patterns — all green

### Project state
- This is a developer dev-kit, intended for local iteration before deploying to Fuji or mainnet. Treat as v0 — APIs may change in 0.x releases.

[Unreleased]: https://github.com/ava-labs/interchain-kit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ava-labs/interchain-kit/releases/tag/v0.1.0
