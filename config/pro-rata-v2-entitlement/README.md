# Pro-rata V2 source-bound entitlement local topology profile

This additive profile deploys the successor 288-byte source-bound entitlement
contracts from `@protocol-robustness/prf-evm-deployables@0.2.0`. The existing
`config/pro-rata-v2-ratification` profile remains the historical 192-byte V2
profile and is not reinterpreted.

```bash
npm run resolve:pro-rata-v2-entitlement-local
npm run deploy:pro-rata-v2-entitlement-local
```

The profile binds the successor adapter to the committed real Groth16 fixture
identity (VKey and ELF SHA-256), wires the allocator's live proof-mode source
to the configuration executor, and installs the one-time allocator/reserve,
assurance/ratification, and prepared-controller/ratification bindings.

## Scope and limitation

This is a local deployment-topology profile, not a proof-admission-ready
configuration. The adapter address is only known after deployment, while the
canonical verifier-registry root commits to that address and is supplied to the
configuration executor at construction. The current declarative deployment
DSL cannot derive the registry root from a just-deployed adapter or perform the
subsequent governed registry-selection transition. The local registry/config
roots therefore remain placeholders, as in the legacy profile. Do not treat
this profile as enabling admission or as production configuration.

Gate E remains the deployment-derived proof integration path: it creates and
seals the registry snapshot and configuration binding from the actual deployed
adapter. The committed Vector A proof fixture is a verifier regression vector,
not a replacement for a deployment-derived Gate E witness/proof.

The operation-specific entitlement representation is deployed or constructed
by the operation flow and is not part of this static topology profile.
