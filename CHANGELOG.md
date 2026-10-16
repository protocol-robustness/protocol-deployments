# Changelog

## Unreleased

### Changed

- Plan-selected deployments reject repeated-byte sentinel values in constructor root bindings before producing a deployable configuration; canonical root derivation and semantic approval remain separate requirements.
- Stage-output verification now authenticates contract facts against their producing stage and live deployment evidence. Auxiliary values are retained only when declared and unconsumed, under the receipt commitment; they cannot be used as downstream authority without a stage-specific verifier.
- Stage-output consumption now requires `--source-revision` to equal the executing checkout's Git HEAD and refuses a dirty checkout; a caller-supplied revision string alone is no longer accepted as source identity.

### Added

- Successor genesis planning now derives the protocol, authority, empty-registry and initial-configuration roots before any deployment. Initial configuration binds the canonical empty verifier-registry root; deployed addresses and code observations enter only chain-instance genesis and the later successor configuration transition. This changes the plan's canonical hash; execution remains blocked pending approved semantic inputs and a derive-stage executor.

- Stage-output consumers now require predecessor receipts to have passed independent verification in the current resolution chain; receipt shape and a matching root alone are insufficient.

- Plan-selected deployments can consume cross-plan contract outputs pinned by producer plan, execution, manifest, live-verification, output, and contract identities using `--cross-plan-stage-output-evidence <dir>`. Producer evidence is independently checked before resolution and the consumer rechecks the producer transaction, block, historical runtime, and current runtime. A producer that itself pins upstream cross-plan outputs carries that evidence recursively; every upstream producer must satisfy the same checks and share the consumer's chain. Cross-plan evidence is recorded separately from the existing same-plan v1 receipt commitment.

- Plan-selected deployment can consume a `stage-output` contract from `--stage-output-receipts <dir>`. Before any deployment transaction, the CLI verifies the receipt chain against the selected plan, environment, chain, source revision and bundle roots, then checks the producing transaction, block hash, historical runtime and current runtime against the selected pinned artifact. `--source-revision <id>` is required for this path. Stage-output addresses are recorded as consumed external observations and their receipt/output roots are bound into plan-execution evidence. This does not implement canonical-root/configuration stages or admitted-release resolution.

- Added `protocol-deployment-stage-output/v1` receipts that bind stage definitions, plan/chain/source/artifact identity, declared predecessor outputs, produced values, observations, and independently rechecked output commitments. Initial-genesis plan dependencies now distinguish the empty verifier registry used by the initial configuration from the later successor registry root. Canonical semantic approval and stage execution remain required before the plan can deploy.

- Successor-plan validation now rejects cyclic stage dependencies explicitly before checking topological order.

- Added versioned deployment-unit ownership/dependency classifications and plan-driven resolver/deployment selection. The local controlled-shortfall plan selects 13 PRF/protected-operation/successor contracts, uses only the explicitly local test token fixture, and excludes Sew. `deploy.ts` now requires either `--plan <file>` or explicit `--legacy-flat`; a fresh staged plan refuses before transactions when it depends on an unimplemented root/configuration stage. Admitted-release resolution remains fail-closed and unimplemented.
- Deployment resumption now rechecks each recorded successful creation receipt, block identity, and current runtime bytecode before reusing the address. Plan execution receipts bind selected sources and deployment-stage outputs to the immutable manifest and have an independent verifier.

- Added first-class externally deployed contract dependencies. Public deployment preflight checks chain identity, pinned runtime code, and declared external-contract assertions; immutable manifest/v2 and live-verification/v2 roots include the observed address, artifact identity, code hash, and block identity. Base Sepolia now binds the existing SEW token and does not deploy a second governance token; unqualified public configurations with placeholder roots or implicit privileged deployer bindings fail during resolution.
- Added a Base Sepolia successor-entitlement readiness profile and fail-closed validator. It pins the current clean 0.4.0 EVM bundle and successor Groth16 identity, excludes SEW/Governor/Timelock from the bounded demo, selects Circle Base Sepolia testnet USDC as the operation asset, and blocks deployment/admission until authority, deployment-derived roots, funded token authority, and a fresh deployment-bound proof are established.
- Added a Base Sepolia successor-entitlement runbook separating read-only preflight from signing/broadcast steps and recording current deployment-ledger boundaries.
- Refined the bounded successor topology: SEW, `GovGovernor`, and Timelock are not contract dependencies; an explicitly approved Safe can be bound directly through existing authority checks. Recorded a pinned-block observation of Circle Base Sepolia test USDC proxy/implementation and marked its artifact binding, Safe approval, and staged genesis/configuration runner as unresolved. No public deployment is enabled.

- Deployment CLI accepts `--fixtures <dir>`; the successor local profile uses an isolated 0.4.0 bundle with stale-assurance recovery interfaces and the locally qualified successor VKey/ELF. Existing profiles retain their original artifact pins.

- Added a separate local successor entitlement topology profile using the separately pinned 0.4.0 PRF EVM deployables bundle and the committed Groth16 program identity; the legacy 192-byte V2 profile remains unchanged. The new profile is explicitly topology-only because the declarative resolver cannot yet derive and govern the deployed adapter's verifier-registry root.
- Live-network hardening: EIP-1559 fees are read from the chain (with `--max-fee`/`--priority-fee` overrides), receipt waits are configurable (`--receipt-timeout-ms`) with distinct timeout codes, and a funding preflight (`--dry-run`/`--yes`) runs before the first transaction.
- Pinned artifact resolution: `NpmBundleLocator`/`SourceMapBundleLocator` and a `BUNDLE_PROVENANCE_UNPINNED` gate that refuses fixture or dirty bundles on non-local chains.
- A dependency-free `.env` loader (`.env.example` added) so `BASE_SEPOLIA_RPC_URL`/`BASE_SEPOLIA_DEPLOYER_KEY` need not be exported manually.
- A Base Sepolia fork rehearsal environment (`base-sepolia-fork`) plus `resolve:base-sepolia-pinned`, `deploy:base-sepolia:resume` scripts.
- Testnet governance bootstrap for `base-sepolia`: the governor is granted `PROPOSER_ROLE` on the timelock and the grant is asserted.
- Added a pro-rata-only local deployment profile covering the synthetic settlement token, PRF authority/genesis and admission roots, shortfall reserve, and pro-rata allocator.
- Added typed deployment bindings for contract addresses, deployer addresses, parameters, runtime code hashes, external addresses, literals, and arrays.
- Added deployment-derived runtime-code-hash bindings for bootstrap verification, including genesis sealing before dependent deployment.
- Added durable bootstrap transition records covering `planned`, `submitted`, `confirmed`, `verified`, and `failed` states.
- Added resumable deployment execution with `--resume`, preserving verified deployment facts and bootstrap actions.
- Added immutable `protocol-deployment-manifest/v1` output and consistency-checked `registry-binding-candidate/v1` output.
- Added explicit environment registry-root selection and `localOnly` labeling for synthetic candidates.
- Added the neutral `PrfLocalAuthorityAdapter` and `IPrfAuthority` compatibility surface for PRF-local deployments.

### Changed

- Updated existing PRF deployment profiles and resolver fixtures to consume deployables bundle 0.2.0, including the V2 allocator live proof-mode source constructor binding.
- Non-local (`testnet`/`mainnet`) deploys now refuse fixtures and unpinned bundles, require explicit confirmation (`--yes`), and use live chain fees instead of hardcoded constants.
- `runtime/base-fork.edn` (dead mainnet-fork config) was replaced by `runtime/base-sepolia-fork.edn` matched to a real environment.
- Real SEW/PRF exporter bundles under `fixtures/packages/**/artifacts/` are now tracked in git (previously ignored by the bare `artifacts/` rule), so a fresh clone can `resolve:*` against the SEW/PRF fixtures without re-running the exporters.

- Bootstrap actions are executed when their target and declared contract dependencies are available, rather than only after every deployment step.
- CREATE2 remains explicitly unsupported until a concrete, verified factory deployment protocol is implemented.

### Notes

- The Deployment Ledger ownership boundary is now explicitly frozen: it ends at bootstrap verification, immutable deployment evidence, and optional candidate production. Post-genesis protocol state is never maintained as mutable Ledger truth; observation for deployment verification does not transfer registry semantics or subsequent claims into this repository.
- Registry-binding candidates now commit their manifest root, explicit projection/filter definition, local-only classification, and selected roots in a deterministic candidate root. Registry admission, canonical selection, scope semantics, mutable chain-state projections, claims, attestations, and query/index infrastructure remain owned by PRF/registry tooling.
- The local pro-rata candidate is synthetic and must not be treated as a production registry release.
- Added a separately identified local-only V2 optimistic Shortfall deployment profile. It verifies the allocator/reserve, assurance/controller, and adapter/verifier topology and emits V2-only registry roots; it does not replace the existing V1 profile or activate a verifier-registry snapshot, which remains a later governed configuration transition.
- The V2 local profile now deploys the official `SP1VerifierGroth16` (sp1-contracts v6.1.0, sp1 release 6.3.1) and binds the V2 source-bound verifier adapter to it with the canonical program VKey/ELF rather than the upstream `SP1MockVerifier`. The previously emitted mock-profile manifest, candidate, and verification artifacts remain on disk as local/mock evidence and are not deleted. Registry snapshot activation remains the deferred `V2 governed verifier activation` work item outside Deployment Ledger ownership.
- Added read-only `verify:live` verification for sealed manifests: it checks chain identity, block identity, runtime bytecode (normalized against the pinned artifact's deployed bytecode and immutable/link reference ranges), and the resolved profile's typed bootstrap assertions at a pinned block, then emits an immutable `protocol-deployment-verification/v1` artifact without mutating deployment or protocol state.
- Added `:stateInterval` runtime configuration for periodic Anvil state persistence (`--state-interval`) during local devnet runs.
- Recorded the three completion levels explicitly: contract conformance, deployable local topology, and operational production proof-admission configuration. Named the remaining V2 work item `V2 governed verifier activation`; it remains outside Deployment Ledger ownership.
- Deferred multi-candidate-per-manifest composition until a concrete combined V1+V2 deployment requires it.
