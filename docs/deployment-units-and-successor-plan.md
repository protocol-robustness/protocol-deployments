# Deployment units and the controlled-shortfall plan

`config/deployment-units.v1.json` records ownership and dependency classes;
`config/pro-rata-v2-entitlement/successor-fork.plan.v1.json` selects a bounded
composition. These declarations do not replace the existing EDN architecture,
artifact bundle, external-contract verification, or immutable deployment ledger.

## Dependency audit

| Unit | Logical dependencies | Dependency classes | Selection for controlled-shortfall |
|---|---|---|---|
| Sew Protocol | `shared/governance-token`, `shared/governor`, `shared/timelock`, `sew/escrow-vault`, `sew/decentralized-resolution-module` | artifact/build, constructor, configuration/authorization, runtime operational | Excluded |
| PRF assurance | verifier registry, allocation verifier, statement admission; successor authority, genesis, SP1 Groth16 verifier, entitlement adapter, configuration executor | artifact/build, constructor, configuration/authorization, runtime operational | Included |
| Protected operations | prepared-operation controller, V2 allocator, V2 reserve; local token fixture or verified Base Sepolia USDC | artifact/build, constructor, external contract, local fixture, runtime operational | Included |
| Pro-rata successor entitlements | successor assurance, ratification controller, immutable entitlement representation | artifact/build, constructor, configuration/authorization, runtime operational | Included |

Artifact/build dependencies resolve from the pinned `prf-evm` deployables
bundle. Contract sources and build authority remain in `prf-evm`; this
repository consumes exported artifacts. The successor path does not select
SEW, Governor, Timelock, or their constructor/configuration dependencies. The
existing local profile's mock token is a local fixture only; it is not a
Base Sepolia asset. The executable local plan selects `prf/local-token` as a
local-only fixture and uses the configured deterministic local signer as the
authority. It does not claim a Safe fixture or Base Sepolia USDC is part of
this local deployment run.

The constructor and authority edges are:

| Contract/dependency | Required edge |
|---|---|
| `PrfLocalAuthorityAdapter` | approved Safe/local fixture as governor; protocol and initial authority roots |
| `PrfVerifierRegistry` | same governor authority |
| `SP1VerifierGroth16` | no constructor dependency |
| successor verifier adapter | SP1 Groth16 verifier, VKey and ELF digest |
| verifier registry entry | successor adapter and program/schema identity; authorized register then seal |
| `PrfChainInstanceGenesis` | authority adapter, chain IDs, initial authority/configuration roots, sealer; later seal against actual code hashes and derived instance root |
| `SewConfigurationExecutor` | sealed genesis, authority, verifier registry and selected initial registry root |
| `PrfStatementAdmission` | sealed genesis, executor, registry, immutable configuration root/epoch |
| prepared-operation controller | no constructor dependency; one-time ratification-controller binding |
| V2 allocator | operation authority and live configuration executor |
| V2 reserve | verified external operation token, application authority, protected-capital amount and allocator |
| successor assurance | statement admission, successor adapter, prepared controller and operation authority |
| ratification controller | prepared controller, assurance and reserve; subsequent one-time authority bindings |
| immutable entitlement representation | operation-derived logical root/count/total after proof admission; not a genesis dependency |
| Base Sepolia USDC | external proxy and implementation identities, proxy implementation observation and ERC-20 metadata/capability checks |
| local Safe fixture | pinned Safe implementation/factory and explicit local owner/threshold configuration |

## Successor dependency graph

```text
Pinned PRF EVM artifacts ───────────────┐
                                       ├─> authority + SP1 verifier + adapter + registry
Local-only threshold Safe fixture ─────┘                   │
                                                           ├─ authorized empty/successor registry snapshots
                                                           └─> derive initial configuration and genesis roots
                                                                -> deploy/seal chain-instance genesis
                                                                -> deploy executor at C0/R0
                                                                -> Safe-authorized C0/R0 → C1/R1 transition
                                                                -> deploy admission bound to C1/epoch 1
Verified Base Sepolia USDC ─────────────────────────────────────┐
Configuration executor/admission ──────────────────────────────┼─> protected controller + allocator + reserve
                                                               └─> successor assurance + ratification
                                                                    -> operation-bound proof/admission
                                                                    -> ratify/fund
                                                                    -> entitlement representation/claims
```

The graph above records the full intended successor path. The current local
plan executor runs selected contract-deployment stages and the existing
bootstrap actions/assertions. It does not yet derive registry/genesis roots,
execute configuration transitions, admit proof, or run protected operations.
Those stages are recorded as `not-executed` in the plan execution receipt.

## Plan boundary

The versioned plan names each selected contract's source explicitly as
`deploy`, `external`, `stage-output`, `admitted-release`, or `local-fixture`.
It rejects unit/source mismatches, absent or later stage dependencies,
unknown outputs, unselected units, Sew selection, and public use of a local
fixture. It never chooses deploy-versus-external from whether an address
happens to be present.

`resolve.ts` and `deploy.ts` accept `--plan <file>` and project the EDN profile
to exactly the plan's contract set. Constructor/relationship references to an
unselected contract fail closed; explicit sources determine deployment order,
and only `deploy` and local-only `local-fixture` sources produce deployment
steps. External sources must be explicitly bound in the environment and are
verified by the existing external-contract checker. `stage-output` and
`admitted-release` sources currently fail closed because this repository does
not yet have verified stage-output receipts or admitted-release resolution.
Legacy flat execution remains available only with the explicit
`--legacy-flat` flag. Fresh selected-plan deployment also checks stage
prerequisites before signer/runtime use and refuses if a selected deployment
depends on a stage with no executor. For this plan the first blocker is
`derive-genesis-roots` before `prf/genesis`; the static local EDN profile still
uses placeholder roots and cannot satisfy that stage.

`npm run validate:successor-fork-plan` checks the plan, both architecture
inventories, unit ownership, stage ordering, output references, selected
source kind, and authorization target ordering. A plan-selected deployment is
recorded as the existing immutable deployment manifest plus a
`protocol-deployment-plan-execution/v1` receipt. The receipt binds selected
sources and per-deploy-stage results; dependency-blocked stages cannot be
reported as verified. `npm run verify:plan-execution` reconstructs its plan
and manifest binding. `verify-live` checks the manifest against the chain.
The retained local topology deployment predates the fresh-run stage guard and
is explicitly incomplete; it does not demonstrate staged genesis or proof
admission.

## Known qualification boundary

The plan is local-only and uses a deterministic local EOA signer; this does
not approve a public authority. Circle USDC remains a separate external
dependency whose proxy/implementation relationship still needs pinned
artifact and live upgrade-policy verification. No Base Sepolia transaction
has been submitted. The public profile remains blocked pending those checks,
public authority/funding approval, configuration-root execution, and a fresh
deployment-derived proof.
