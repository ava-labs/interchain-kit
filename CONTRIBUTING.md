# Contributing to interchain-kit

Thanks for your interest in improving interchain-kit. This kit boots a local Avalanche network with ICM, ICTT, the validator manager, an icm-relayer, and a signature aggregator — contributions that make those flows faster, clearer, or more reliable are very welcome.

## Prerequisites

See the [Prerequisites section in the README](./README.md#prerequisites) for the full toolchain (Node 20+, pnpm 9+, Foundry, an `avalanchego` binary, etc.). Please don't open a PR until you can run the harness locally.

## Development

```sh
pnpm install
pnpm test:harness   # boots the local network and runs the end-to-end flows
pnpm up             # bring the network up for manual exploration
```

If you're touching Solidity, run `forge build` and `forge test` from the relevant contracts package.

## Issues

### Security

**Do not** open a public GitHub issue for a security vulnerability. Follow the process in [SECURITY.md](./SECURITY.md) instead.

### Bugs and features

- Search [existing issues](https://github.com/ava-labs/interchain-kit/issues) before filing a new one.
- For bugs, use the bug report template and include logs plus your environment (OS, Node, pnpm, `avalanchego` commit, Foundry version).
- For non-trivial features, open an issue first to align on scope before writing code.

## Pull requests

- Target the `main` branch.
- Branch naming: `docs/`, `feature/`, `fix/`, or `refactor/` followed by a short slug (e.g. `feature/ictt-erc20-flow`).
- All commits must be [GPG-signed](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits). Do not bypass signing or commit hooks.
- Keep PRs focused. One logical change per PR makes review and bisecting much easier.
- Update or add tests for behavior you change. The harness flows are the source of truth for end-to-end behavior.
- Fill out the PR template — Summary, What changed, How to verify, Linked issues.
- Draft PRs are welcome for early feedback.

## Questions

For usage questions, prefer [GitHub Discussions](https://github.com/ava-labs/interchain-kit/discussions) over issues.
