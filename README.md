# Protocol Deployments

Deployment composition and governance/deployment configuration for PRF, SEW,
and shared infrastructure. Consumes pinned deployable artifact packages from
the authoritative Solidity source repos (`prf-evm`, `sew-protocol`); it never
compiles their source.

See [docs/architecture.md](docs/architecture.md) for the full design and
[docs/assumptions.md](docs/assumptions.md) for assumptions and deferred work.

## Quick start

```bash
npm install
npm test                 # vitest: happy-path + adversarial validation
npm run typecheck        # tsc --noEmit

# Produce canonical resolved spec + deterministic spec hash
npm run resolve:local         # -> deployments/local.resolved.json
npm run resolve:base-sepolia  # -> deployments/base-sepolia.resolved.json

# Local end-to-end: start a persisted Anvil devnet, deploy, then stop it
npm run devnet:start
npm run deploy:local
npm run devnet:stop
```

## Base Sepolia testnet

Prerequisites: a funded deployer key and an RPC endpoint. Copy `.env.example` to
`.env` (gitignored) and fill it in, or export the variables in your shell.

```bash
npm run typecheck && npm test
npm run resolve:base-sepolia         # inspect the resolved spec + specHash
npm run deploy:base-sepolia-fork     # rehearse the exact topology on a Base Sepolia Anvil fork
npm run deploy:base-sepolia -- --dry-run
npm run deploy:base-sepolia          # prompts for confirmation (use --yes in CI)
npm run deploy:base-sepolia:resume   # resume a partial run from the ledger
npm run verify:live -- \
  --manifest deployments/base-sepolia.<root>.deployment-manifest.v1.json \
  --resolved deployments/base-sepolia.resolved.json \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Behaviour on a live chain:

- Fees are read from the chain (`eth_feeHistory`/`eth_gasPrice`) and can be
  overridden with `--max-fee`/`--priority-fee` (wei).
- Receipts are waited for up to 180s by default; override with
  `--receipt-timeout-ms`.
- A funding preflight runs before the first transaction; `--dry-run` stops there.
- Non-local deploys require explicit confirmation (`--yes` in CI) and **pinned
  artifacts**: fixture bundles are refused and every bundle must come from a
  clean, committed git checkout (`BUNDLE_PROVENANCE_UNPINNED` otherwise).

Before the first real testnet deploy these must be supplied (tracked in
`CHANGELOG.md`): the real SP1 verifier address and program VKey/ELF, the full
ownership/role wiring for the testnet governance model, and tagged
`dirty=false` artifact packages.

## Status

Schemas, resolver, and deterministic spec hashing are complete and tested.
Execution is live: real exporter artifact bundles are consumed, and the
deployment engine sends ordinary raw-signed JSON-RPC transactions to a
local Anvil devnet (or a configured external chain), verifies deployed runtime
code against the pinned artifact, runs bootstrap actions and final assertions,
and emits an immutable deployment manifest plus a registry-binding candidate.

`npm run verify:live` re-checks a sealed manifest against a running chain —
read-only, failing closed on any mismatch.

Deliberately out of scope for now: CREATE2 (until a factory protocol exists)
and protocol governance actions (bootstrap-only; later governance changes are
not part of the deployment ledger).


### Qualified successor local topology

`pnpm resolve:pro-rata-v2-entitlement-local` and `pnpm deploy:pro-rata-v2-entitlement-local` select the isolated `fixtures/releases/0.4.0/packages` artifact bundle. The profile binds successor VKey `0x00d90efa52d17e54670a4248f001e4da443a938f12c55d0d414c125ba68087b9` and ELF SHA-256 `0x636330de8e7af3485aba50bd3ca4b5e024cc4f977a2bf0f2c005f711e5ffacf8`, with the current stale-assurance recovery interfaces. Older profiles and the original fixture directory retain their release pins. Generic deployment commands can select another fixture directory using `--fixtures <dir>`.

This is a local topology profile. Its placeholder registry/configuration roots do not establish governed successor admission. The deployment-derived real-proof Gate E path in `prf-evm` remains the qualification path for verification, admission, ratification, funding, activation, withdrawal and refund. No package publication or Base Sepolia deployment is implied by this local bundle.
