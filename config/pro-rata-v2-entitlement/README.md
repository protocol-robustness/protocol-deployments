# Pro-rata V2 source-bound entitlement local topology profile

This additive profile deploys the successor 288-byte source-bound entitlement
contracts from `@protocol-robustness/prf-evm-deployables@0.4.0`. The existing
`config/pro-rata-v2-ratification` profile remains the historical 192-byte V2
profile and is not reinterpreted. The successor scripts select the isolated
`fixtures/releases/0.4.0/packages` bundle with clean source provenance and
stale-assurance recovery interfaces.

```bash
npm run validate:successor-fork-plan
npm run resolve:pro-rata-v2-entitlement-local
```

The fresh deployment command is currently expected to stop before transaction
submission at the missing genesis-root stage. Do not use the earlier retained
topology deployment as proof-admission or operation qualification.

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

The bounded local deployment composition is declared in
`successor-fork.plan.v1.json`, checked against `config/deployment-units.v1.json`.
The resolve/deploy commands pass this plan explicitly, so only its selected
13 contracts enter the resolved graph. When all selected stage prerequisites
are executable, deployment emits a plan execution receipt bound to its
manifest. Resume rechecks each recorded creation receipt, block and live
runtime bytecode.

The plan validator reports the first missing prerequisite, and fresh
`deploy.ts --plan` runs refuse before sending transactions when a selected
deployment stage depends on an unimplemented root/configuration stage. A local
deployment was exercised before this guard was added; its retained receipt
marks dependent stages blocked and is deployment-topology evidence only. It is
not a qualified staged-genesis or proof-admission run.

Plan validation command:

```bash
npm run validate:successor-fork-plan
```

This checks plan structure and unit/source ownership.

Release source commit: `353062b667e900b6735fea6fd7ef7a61fd5282e3`.
Bundle root: `566c4d62b254af86a687116faa50614b301065d3eef1052b3985418be54eb0ff`.
These identify the exported contract bundle; the guest ELF/VKey remain separate proof-program identities.
