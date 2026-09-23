# Changelog

## Unreleased

### Added

- Added a pro-rata-only local deployment profile covering the synthetic settlement token, PRF authority/genesis and admission roots, shortfall reserve, and pro-rata allocator.
- Added typed deployment bindings for contract addresses, deployer addresses, parameters, runtime code hashes, external addresses, literals, and arrays.
- Added deployment-derived runtime-code-hash bindings for bootstrap verification, including genesis sealing before dependent deployment.
- Added durable bootstrap transition records covering `planned`, `submitted`, `confirmed`, `verified`, and `failed` states.
- Added resumable deployment execution with `--resume`, preserving verified deployment facts and bootstrap actions.
- Added immutable `protocol-deployment-manifest/v1` output and consistency-checked `registry-binding-candidate/v1` output.
- Added explicit environment registry-root selection and `localOnly` labeling for synthetic candidates.
- Added the neutral `PrfLocalAuthorityAdapter` and `IPrfAuthority` compatibility surface for PRF-local deployments.

### Changed

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
