# Protocol Deployments — Architecture

This repository owns **deployment composition and governance/deployment
configuration** for PRF, SEW, and shared infrastructure. It is **not** a
Solidity source monorepo: it never compiles `prf-evm` or `sew-protocol` source.
It consumes pinned, versioned deployable artifact packages exposed by those
authoritative source repositories.

```
EDN architecture/configuration
        ↓
strict TypeScript parsing + validation
        ↓
resolved canonical deployment specification
        ↓
deployment engine (JSON-RPC)
        ↓
immutable deployment record / observed results
```

## Runtime boundary

The **canonical world** (architecture/governance/verification/environment EDN →
resolved spec → specHash) never mentions `:anvil`, `:hardhat`, or `:forge`.
How a chain is provided is a **runtime** concern (`runtime/<env>.edn`), fully
outside the resolved spec, so choosing Anvil vs a hosted node never changes
`specHash`.

```
  canonical world                 runtime boundary
architecture.edn  ────────┐
governance.edn             ├─▶ resolved spec ─▶ specHash
verification.edn           │                          │
environment.edn  ─────────┘                          ▼
                                      [RpcTransport] ── JSON-RPC ──▶ Anvil | remote | fork | geth/reth
                                      [Signer]        (local key, eth_sendRawTransaction)
```

- **Transport** (`src/runtime/transport.ts`) — ordinary JSON-RPC; the canonical
  submission path is `eth_sendRawTransaction` (the node never holds the key).
- **Signer** (`src/runtime/signer.ts`) — local authorization; `PrivateKeySigner`
  for real deployments, `DeterministicLocalSigner` for dev.
- **Devnet** (`src/runtime/devnet.ts`) — local Anvil lifecycle with persisted
  state under gitignored `.devnet/anvil/` (a runtime cache, never the ledger).
- **Forks** — a fork is a runtime (`:provider :anvil-fork`), not a new chain
  identity; the execution environment stays the source chain's `chainId`.

viem supplies the mechanical primitives (ABI/constructor encoding, tx
serialization, signing, keccak, receipt normalization); orchestration is this
repo's own.

## Logical identities

Three distinct identities must never be conflated:

1. **logical contract identity** — e.g. `:shared/governor`, `:prf/verifier-registry`
2. **source artifact identity** — a named artifact within a pinned package (e.g.
   `SEWGovernor` in `@sew/deployables@0.1.0`)
3. **deployed instance identity** — an address on a chain, recorded in the ledger

A contract may be logically `:shared` even if its Solidity source lives in
`sew-protocol`. Repository placement does not determine architectural
ownership.

## Scope boundaries

| Concern | Owned by |
|---|---|
| PRF Solidity source, compilation, tests, deployable artifacts | `prf-evm` (authoritative) |
| SEW Solidity source, compilation, tests, deployable artifacts | `sew-protocol` (authoritative) |
| Deployment composition, config, classification, chain/env selection, governance topology, parameter config, execution, validation, ledger | **this repository** |

This repository defines the **consumer boundary** for deployable artifacts. It
consumes the real bundles emitted by the SEW/PRF exporters (local copies in
`fixtures/packages/` for development; an immutable pinned package identity for
production). The consumer validates bundle roots, per-artifact hashes, ABI, and
bytecode against the manifest before any deployment.

## Non-goals (explicitly out of scope)

- Move Solidity source here, or compile `prf-evm` / `sew-protocol`
- Git submodules as the artifact boundary
- Redesign existing Solidity governance or PRF verifier contracts
- Hardhat Ignition
- A generic DAG workflow engine or arbitrary ABI-call configuration
- A runtime synchronization system between EDN and contracts
- A UI, service, database, or generic deployment product

EDN is **configuration and architectural intent** — not a programming language,
not an execution engine, not a governance workflow engine, not a dynamic
runtime control plane. A configuration is **resolved and frozen** for a
deployment; later governance changes never mutate the original deployment
specification.

## Configuration model

### `architecture.edn`
- Logical contracts, with `:prf` / `:sew` / `:shared` scopes
- Pinned artifact sources
- A small, explicit relationship vocabulary:
  `:dependsOn`, `:uses`, `:registeredIn`, `:administeredBy`, `:guardedBy`, `:provides`
- Intended chains / logical chain roles

Relationships are intentionally small and useful — not a general ontology.

### `governance.edn`
Models governance explicitly:

```
voting source → governor → execution lane → operation group → governed operation / parameter
```

Semantic groups (`:sew/economics`, `:sew/architecture`, `:sew/resolution`,
`:prf/verifiers`, `:prf/registries`, `:shared/deployment`) may all share the
same token, Governor, and/or timelock. The governance **token is a voting
source only — never the direct executor/authority**.

### Parameters
A deliberately small mutability model: `:immutable` | `:governed`.
Governed parameters support only simple constraints: `:range`, `:one-of`.
No arbitrary expressions or policy DSLs.

### `verification.edn`
Distinguishes application → verification profile → verifier implementation →
deployed verifier instance. Multiple applications may share one verifier
implementation while using distinct statement/program/VK/profile identities.
Phase 1 establishes structure only; no proofs are produced.

### Environments
`environments/*.edn` describe **chain identity** only: `:logicalRole`,
`:chainId`, optional `:kind`. They carry parameter-value overlays and the
**explicit deployment order**. How the chain is obtained (provider, rpcUrl,
signer) lives separately in `runtime/<env>.edn` — never in the resolved spec.

## Deterministic resolution

The resolver (`src/resolver.ts`) converts parsed EDN + validated artifact
bundles into a fully explicit, canonical resolved spec (`src/canonical.ts`).
It contains no unresolved logical references required for deployment.

The canonical spec is serialized to **canonical JSON** (sorted keys, bigint as
decimal string, no whitespace) and frozen with a **deterministic spec hash**
(`src/spec-hash.ts`, keccak256 over a versioned domain + canonical JSON).

The spec carries **intended** state; **observed** results are recorded
separately and are never part of the frozen spec.

## Resolved intent vs deployment record

- `deployments/<env>.resolved.json` — the **frozen resolved deployment intent**
  (`specHash`, `environment`, `spec`). Never mutated by execution.
- `deployments/<env>.deployment.json` — the **deployment record** (observed
  facts), linked by `specHash`.

A deployment fact stores the resolved parameter values applied at deploy time
(e.g. `proposalThreshold = X`) as an immutable fact. A later governance change
(`= Y`) is recorded as a separate **governance action** and never overwrites
the original deployment fact — preserving the `:immutable`/`:governed` +
constraint semantics.

## Deployment ordering

No generic dependency-driven engine. The environment declares an **explicit
deployment order** which is authoritative; the resolver validates that declared
dependencies are satisfied by that order. A topological order may be computed
later for diagnostics/tests but must not silently replace the explicit plan.

## Safety validation

Resolution rejects, before any transaction could execute:

- unknown logical contract
- unknown artifact source
- artifact missing from pinned package
- artifact / component hash mismatch
- duplicate logical ID (incl. duplicate EDN map keys)
- unknown dependency / relationship target
- dependency cycles
- unknown governance group (lane) / unknown token / unknown governor
- unknown verifier profile / implementation
- immutable parameter assigned runtime governance
- governed parameter without authority
- initial parameter outside configured constraint
- configured chain id differing from connected RPC chain id (`assertChainIdMatches`,
  called by the execution layer)
- unresolved environment/chain binding

Security-sensitive values are never silently defaulted.

## Repository layout

```
config/                 EDN configuration (architecture, governance, verification, environments)
runtime/                per-environment runtime config (provider, signer env refs)
fixtures/packages/      local copies of the SEW/PRF exported bundles (dev)
scripts/                non-shipped tooling (fixture generation)
src/
  config/               EDN reader + raw zod schemas + loader
  artifacts/            bundle consumer + artifact types + hashing
  canonical.ts          resolved spec types
  canonical-json.ts     deterministic serialization
  spec-hash.ts          frozen spec hash
  resolver.ts           resolution + validation orchestration
  validate/checks.ts    standalone checks (chain id)
  runtime/              transport + signer + anvil lifecycle + devnet manager
  deployment/           deployment engine + deployment record
  cli/                  resolve / devnet / deploy CLIs
test/                   happy-path + adversarial + runtime + engine tests
deployments/            resolved specs + deployment records (gitignored)
.devnet/                local devnet runtime state (gitignored, never the ledger)
```

## Commands

```bash
npm run resolve:local      # produce deployments/local.resolved.json + specHash
npm run devnet:start       # start local Anvil (persisted under .devnet/anvil/local)
npm run devnet:status      # is it running?
npm run devnet:stop        # stop (dumps persisted state)
npm run devnet:reset       # stop + clear persisted state (clean chain)
npm run deploy:local       # resolve + deploy against the local runtime, write deployment record
```

## Phases

- **Phase 1:** EDN loading, schemas, logical IDs, artifact-source abstraction,
  environment overlays, governance/verification models, parameter mutability,
  deterministic resolution, canonical output, spec hash, adversarial tests.
- **Phase 2:** consume the real deployable-artifact bundles emitted by the
  `sew-protocol` and `prf-evm` exporters (schema/hash aligned).
- **Phase 3:** chain-vs-runtime separation; JSON-RPC transport + signer
  abstraction; Anvil local runtime with persistent state; deployment engine
  (raw signed txs, runtime-code verification, CREATE2 mode); immutable
  deployment record. Hardhat removed (independent path proven).

## PRF compatibility

Design choices preserve a path to PRF deployment assurance:
- authoritative/source fields are distinguished from derived fields;
- humans never specify values deterministically derivable from artifacts/config;
- a canonical resolved representation is produced;
- a deterministic deployment-spec hash/root is computed;
- code/artifact hashes and explicit authority/governance relationships are retained;
- intended vs observed state are kept separate.

No PRF proofs or deployment-conformance proofs are implemented in this task —
only made non-difficult later.
