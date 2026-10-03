# Assumptions and Deferred Work

## Assumptions

- **Artifact boundary is a pinned package, not a git submodule.** Source repos
  (`prf-evm`, `sew-protocol`) remain authoritative for Solidity source and
  compilation. This repo consumes versioned deployable artifact packages and
  never recompiles.
- **The consumer reads the real exporter bundle format** emitted by the SEW/PRF
  exporters (`deployables/manifest.json` with `packageName`/`bundleVersion`/
  `source`/`build`/`artifacts`/`bundleRoot`). Canonical JSON and hash
  conventions are byte-for-byte aligned with those exporters. Local bundles are
  copied into `fixtures/packages/` for development; production uses an
  immutable pinned package identity.
- **Logical `:shared` contracts may have their Solidity source in `sew-protocol`.**
  Architectural ownership (scope) is independent of repository placement.
- **EDN is data, not code.** Only the small, explicit vocabulary is supported;
  unknown constructs are rejected by the reader.
- **CamelCase keys** are the single convention shared between EDN and the
  TypeScript schemas/canonical output.
- **BigInt (`N` suffix) for all exact wei-like quantities** to avoid floating
  point loss; plain integers are JS numbers.
- **Explicit deployment order is authoritative.** Dependencies must be satisfied
  by it; no implicit reordering.
- **Governance token is a voting source only**, never a direct executor.
- **Chain binding is per-environment and checked against the connected RPC** at
  execution time via `assertChainIdMatches`. Chain identity (environment) is
  kept separate from runtime/provider (`runtime/<env>.edn`); the runtime never
  affects `specHash`.
- **Secrets are never serialized.** Runtime config references secrets by env-var
  name; the ledger records only the deployer address, never signer configuration.
- **`@sew/deployables` and `@protocol-robustness/prf-evm-deployables` package
  names are provisional.** The artifact-source abstraction is stable regardless
  of final package names.
- **Spec hash excludes observed/ledger state.** Intended and observed state are
  kept strictly separate.
- **Deployment is serial and nonce-boring** (one tx, wait, next) — no parallel
  deployments, no speculative nonces, no tx replacement.
- **A successful receipt is not enough** — the engine requires deployed runtime
  code to match the expected artifact bytecode.

## Testnet readiness decisions

The code paths for a Base Sepolia deployment are in place (live fees,
configurable receipt timeout, funding preflight, pinned-artifact provenance
gate, fork rehearsal, env-file loading). The following inputs/decisions are
still required before a real testnet run, and are intentionally not invented
here:

- **SP1 verifier identity** — the canonical `SP1VerifierGroth16` address (or a
  decision to deploy it from the pinned artifact as the pro-rata-v2 profile
  does) plus the real `programVKey_`/`programElfSha256_` for the realized
  allocation adapter. Until supplied, `prf/allocation-verifier` binds the
  verifier to the deployer and all-zero program identity.
- **Ownership/role model** — whether escrow module management and resolution
  ownership move to the timelock/governor, and whether the deployer retains
  `DEFAULT_ADMIN_ROLE`. Only the timelock `PROPOSER_ROLE` grant is currently
  wired.
- **Artifact release** — tagged `@sew/deployables` /
  `@protocol-robustness/prf-evm-deployables` packages with clean git
  provenance. Current fixtures are `dirty=true` (and the SEW one is jj-sourced),
  so `deploy:base-sepolia` fails closed until they are released.

On-chain source verification (Basescan/Sourcify) is intentionally out of scope:
this repo consumes compiled artifact bundles and holds no Solidity source; source
verification belongs to the source repositories that emit the bundles.

## Deferred work

- **Shared governance proposal tooling** (later, where appropriate).- **Topological ordering** as a diagnostics/test aid only (never to silently
  replace the explicit plan).
- **On-chain CREATE2 deployment test** (address derivation + assertion are
  implemented and unit-tested; a live factory deploy test is deferred).
- **Live fork / remote-network execution tests** (require network/RPC secrets;
  the runtime model supports them; the local Anvil path is fully tested).
- **PRF proofs / deployment-conformance proofs.** Design choices only keep the
  path open; nothing is implemented.
- **Non-goals:** Hardhat Ignition, generic DAG systems, arbitrary ABI-call
  configuration, UI/service/database, or any generic deployment product.
