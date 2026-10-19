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
verified by the existing external-contract checker. Same-plan `stage-output`
sources use the existing v1 receipt graph. A cross-plan stage output may instead
pin its producer plan hash, execution root, deployment manifest root, live
verification root, output root, evidence package root, and deployed address in
the consumer plan. `--cross-plan-stage-output-evidence <dir>` supplies the
retained producer plan, execution receipt, manifest, verification report, and
nested producer evidence. The resolver reconstructs those roots and rejects
missing, substituted, incomplete, cyclic, or wrong-chain evidence; before any
transaction the CLI also rechecks the producer deployment transaction, block,
historical runtime, and current runtime against the consumer's selected pinned
artifact. Cross-plan evidence is recorded in its own `evidenceRoot` field and
does not reinterpret the same-plan v1 `receiptRoot`. Admitted-release sources
remain fail-closed pending the authoritative downstream release format.
Legacy flat execution remains available only with the explicit
`--legacy-flat` flag. Fresh selected-plan deployment also checks stage
prerequisites before signer/runtime use and refuses if a selected deployment
depends on a stage with no executor. For this plan the first blocker is
`derive-genesis-roots` before `prf/genesis`; the static local EDN profile still
uses placeholder roots and cannot satisfy that stage.

The successor plan now separates predeployment roots from the initial
configuration root. `derive-genesis-roots` supplies only the protocol root,
initial authority-state root, and canonical empty verifier-registry root.
`derive-initial-configuration` is ordered after the local token and verifier
adapter deployments so address-bound module-registry inputs can be taken from
verified deployment outputs; it uses the empty registry root. The later
`derive-registry-roots` stage remains the source of the successor registry
root for the governed transition. This is a dependency-order correction, not
semantic approval: the initial configuration's complete policy artifact and
approval are still absent, and the CLI still refuses to execute derivation,
sealing, or configuration stages.
The machine-readable root inventory and dependency map is
[`genesis-dependency-graph.v1.json`](../config/pro-rata-v2-entitlement/genesis-dependency-graph.v1.json).

`npm run validate:successor-fork-plan` checks the plan, both architecture
inventories, unit ownership, stage ordering, output references, selected
source kind, and authorization target ordering. A plan-selected deployment is
recorded as the existing immutable deployment manifest plus a
`protocol-deployment-plan-execution/v1` receipt. The receipt binds selected
sources and per-deploy-stage results; dependency-blocked stages cannot be
reported as verified. `verify-plan-execution` reconstructs the plan and
manifest binding, then replays retained PRF approval and root-derivation
commands from the input files under `--prf-root`; verifying a sealed genesis
also rechecks its seal transaction and historical reads through `--rpc-url`.
The caller supplies approval trust material separately through
`--trusted-context-root`; the verifier uses it instead of trusting the copy
inside the deployment bundle. Its directory layout mirrors the retained
trusted-context paths and each file must match the digest in the approval.
The plan verifier also invokes live verification against `--resolved`, the
caller-selected pinned `--fixtures` bundle and `--rpc-url`; it does not accept
a producer-supplied live-verification success flag. It can persist a deterministic, immutable
`protocol-deployment-independent-verification/v4` report with `--out`; the report
binds the plan receipt, its complete/partial status, manifest, final
resolved-spec digest, replay count and recomputed live-verification root, and
states the remaining trust assumptions. A verified partial prefix remains
explicitly marked partial. The report labels itself as local verification
evidence rather than approval. Its verifier continues to accept retained v3 reports using their original
fixed trust-assumption list and digest, so a later trust-list update cannot
invalidate historical evidence. The optional `--capital-flow-evidence` input
supplies a `protocol-capital-flow-execution/v6`
bundle. The verifier checks the complete ordered set of six positive actions,
including prepared-operation creation before admission,
and nine negative cases against RPC transaction targets, selectors, receipt
statuses and canonical block hashes. For every required state domain it checks
historical calls immediately before and after the action, and requires isolated
single-transaction blocks so reverted cases can be checked for unchanged state.
It also enforces a fixed chronology: wrong-instance preparation precedes valid
operation creation; proof failures precede admission; repeated admission follows
the admitted receipt; wrong-operation follows assurance preparation; and repeat
ratification/withdrawal follow their successful capital actions. Negative-case
calldata must preserve all bindings other than the specific identity under
test.
The repeated-admission case is explicitly expected to succeed with the same
calldata, preserving generic receipt identity, while its capital-bound state
assertions remain unchanged; the other negative cases must revert.
The stale-C0 case first admits public values that commit to a C0-prepared
operation under the active C1 verifier, then requires assurance preparation to
revert against the C1 operation. The bundle includes the independently derived
C0 root and complete prepared-operation tuple; replay recomputes its root and
checks that only the configuration root and epoch differ from the active
operation. This tests the assurance boundary, since statement admission does
not itself establish that an operation was prepared under the active
configuration.
The unauthorized-configuration case must be a well-formed direct-target
next-epoch request and records an absent decision authorization and proof-mode
assignment before and after its revert, so the rejection is attributable to the
authorization gate rather than zero roots or malformed target data.
Prepared reserve, token and allocator addresses are checked against the
deployment manifest. Getter argument counts are fixed, and token-balance and
consumed-claim reads are bound to the decoded withdrawal beneficiary and claim
identity. Expected historical state values still require qualification review
against the approved operation. Replay regression tests load the retained
v0.4.1 artifact ABIs for action and getter selector checks, and observed action
calldata must decode and re-encode byte-for-byte through the pinned ABI. The
verifier also checks intervening blocks for unreported transactions, with a
bounded gap, so external state changes cannot be omitted from the flow bundle.
The report binds the evidence digest, transaction count and state-assertion
count. Action targets and selectors are checked against the profile's fixed
action map, deployment manifest and pinned resolved ABI. State read-call
targets and selectors are checked against fixed getter mappings and pinned
view ABIs. The evidence binds its configuration root/epoch to the verified C1
application stage and checks those values before and after every action. State
call arguments and expected values remain evidence inputs that require
qualification review; the bundle does not itself establish proof validity or a
correct expected outcome. The
`verify:plan-report` command checks the report schema, fixed trust-assumption
list and report digest; it does not replay deployment evidence, so consumers
must use `verify:plan-execution` for that check. For example:
`npm run verify:plan-execution -- --plan <plan.json> --manifest <manifest.json>
--receipt <plan-execution.json> --prf-root <PRF checkout>
--trusted-context-root <independent trust-context directory>
--resolved <resolved.json> --fixtures <pinned fixture root> --rpc-url <URL>`.
To check a retained report's integrity, run
`npm run verify:plan-report -- --report <verification-report.json>`.
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
