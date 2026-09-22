# Pro-rata V2 optimistic Shortfall local profile

This profile deploys the independent V2 source-bound Shortfall family. It does
not replace or reinterpret `config/pro-rata`, which remains the V1 production
allocation profile.

```bash
npm run resolve:pro-rata-v2-ratification-local
npm run devnet:reset
npm run deploy:pro-rata-v2-ratification-local
```

The local profile deploys and runtime-verifies:

- a synthetic settlement token and local-only upstream `SP1MockVerifier`;
- the PRF genesis, verifier registry, configuration executor, and statement
  admission contracts;
- the V2 source-bound verifier adapter and prepared-operation controller;
- the V2 allocator, reserve, assurance, and ratification controller;
- the allocator → reserve, assurance → ratification-controller, and reserve →
  ratification-controller one-time bindings.

Its registry-binding candidate contains only the V2 assurance, ratification
controller, reserve, and allocator roots, and is marked `localOnly: true`.

## Deliberate limit

The profile does not claim that the V2 verifier entry is active in the PRF
verifier-registry snapshot. That snapshot root commits the deployed adapter
address, while the configuration executor receives its initial root before the
adapter can be deployed. Registering, sealing, and selecting that root is a
later governed configuration transition, not a Deployment Ledger bootstrap
action. The local mock verifier is therefore solely a topology/proof-format
fixture and never a production verifier selection.
