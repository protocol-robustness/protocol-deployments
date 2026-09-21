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

## Deferred work

- **Shared governance proposal tooling** (later, where appropriate).
- **Topological ordering** as a diagnostics/test aid only (never to silently
  replace the explicit plan).
- **On-chain CREATE2 deployment test** (address derivation + assertion are
  implemented and unit-tested; a live factory deploy test is deferred).
- **Live fork / remote-network execution tests** (require network/RPC secrets;
  the runtime model supports them; the local Anvil path is fully tested).
- **PRF proofs / deployment-conformance proofs.** Design choices only keep the
  path open; nothing is implemented.
- **Non-goals:** Hardhat Ignition, generic DAG systems, arbitrary ABI-call
  configuration, UI/service/database, or any generic deployment product.
