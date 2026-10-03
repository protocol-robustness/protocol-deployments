# Pro-rata V2 optimistic Shortfall local profile

This profile deploys the independent V2 source-bound Shortfall family. It does
not replace or reinterpret `config/pro-rata`, which remains the V1 production
allocation profile.

```bash
npm run resolve:pro-rata-v2-ratification-local
npm run devnet:reset
npm run devnet:start
npm run deploy:pro-rata-v2-ratification-local

# The devnet started above is still running: `deploy` reuses an already-running
# devnet instead of spawning (and then killing) its own. Re-check the sealed
# manifest at a pinned live block and emit a separate immutable artifact.
npm run verify:live -- \
  --manifest deployments/<manifest>.deployment-manifest.v1.json \
  --resolved deployments/pro-rata-v2-ratification-local.resolved.json \
  --rpc-url http://127.0.0.1:8545

npm run devnet:stop
```

The local profile deploys and runtime-verifies:

- a synthetic settlement token and the official `SP1VerifierGroth16` (sp1-contracts
  v6.1.0 / sp1 release 6.3.1, canonical VKey/ELF below);
- the PRF genesis, verifier registry, configuration executor, and statement
  admission contracts;
- the V2 source-bound verifier adapter and prepared-operation controller;
- the V2 allocator, reserve, assurance, and ratification controller;
- the allocator → reserve, assurance → ratification-controller, and reserve →
  ratification-controller one-time bindings.

The resolved profile also carries typed read-only assertions for those bindings,
all V2 controller relationships, the adapter's verifier/program/schema identity,
and genesis sealing. `verify:live` evaluates those assertions against the exact
block recorded in its verification artifact; it does not update the deployment
manifest or create protocol lifecycle state.

Its registry-binding candidate contains only the V2 assurance, ratification
controller, reserve, and allocator roots, and is marked `localOnly: true`.

## Completion status

This profile is complete at the contract-conformance and deployable-local-topology
levels. It is not an operational production proof-admission configuration.

## Real-verifier identity

The profile deploys the official SP1 Groth16 verifier and binds the V2
source-bound verifier adapter to it with the canonical program identity:

```text
VKey:        0x0089abceac18acb8d0686b81ea542b933339353807924bc021a9fe3820888127
ELF SHA-256: 0x1994d8b67004de3d5dfffc176434ae63f3d7ac32ae875d72093943ff8e82247b
verifier:    SP1VerifierGroth16 (sp1-contracts v6.1.0, sp1 release 6.3.1, Groth16)
```

## Named follow-up: V2 governed verifier activation

The profile does not claim that the V2 verifier entry is active in the PRF
verifier-registry snapshot. That snapshot root commits the deployed adapter
address, while the configuration executor receives its initial root before the
adapter can be deployed. Registering, sealing, and selecting that root is a
later governed configuration transition, not a Deployment Ledger bootstrap
action. The adapter is bound to the real verifier as a topology/proof-format
fact, but real V2 proof admission also requires the governed configuration
selection; it is not merely a mock fixture.

The follow-up sequence is:

```text
adapter deployment fact
  → verifier-registry entry/snapshot
  → canonical registry root
  → governed configuration transition
  → sealed/selected registry state
  → real V2 proof admission
```

That work belongs to PRF/registry tooling and governed protocol operations, not
to Deployment Ledger bootstrap.
