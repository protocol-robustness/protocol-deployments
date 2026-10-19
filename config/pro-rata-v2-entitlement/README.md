# Pro-rata V2 source-bound entitlement local topology profile

This additive profile deploys the successor 288-byte source-bound entitlement
contracts from the local `@protocol-robustness/prf-evm-deployables@0.4.2`
candidate bundle. The existing
`config/pro-rata-v2-ratification` profile remains the historical 192-byte V2
profile and is not reinterpreted. The successor scripts select the isolated
`fixtures/releases/0.4.2/packages` bundle with the local authority-transition
validator artifact and stale-assurance recovery interfaces. This bundle was
reproducibly exported from PRF-EVM Jujutsu revision
`8ba7628bdfa46c1673aa15ba6205443ac1750ea9`; it is a local candidate, not a
published release.

```bash
npm run validate:successor-fork-plan
npm run resolve:pro-rata-v2-entitlement-local
```

The fresh deployment command requires authenticated initial-input approval.
It executes a dependency-safe prefix, independently seals genesis, derives
the successor registry root from the deployed adapter, checks the root against
Solidity at a pinned block, seals the approved empty registry, and then deploys
the configuration executor. PRF independently derives C1 and records it in the
partial receipt. A resumed run can verify a separate transition approval using
`--successor-transition-manifest`, `--successor-verifier-registry`,
`--successor-transition-trusted-context`, and `--successor-transition-approval`.
With approved transition inputs, the resumed executor continues through
successor registry mutations and configuration application, then deploys the
successor admission and entitlement contracts and runs their configured
authority bindings. This does not qualify proof admission or capital
operations.

When the separate successor-transition approval and PRF-verified signed
authority-transition request are supplied, the resumed executor can continue:
it registers and seals the approved successor verifier, atomically applies the
authority-state transition, then applies C1 through the configuration
executor. Each send is guarded by exact approved arguments and followed by
receipt and state readbacks; the plan receipt exposes both transition stages
only when those checks pass. The resumed run can then deploy the downstream
contracts and execute their configured one-time controller bindings. Supply the request with
`--authority-transition-request` and its independent trust context with
`--authority-transition-trusted-context`, alongside the four successor
transition review files above. Proof admission, protected-operation execution,
entitlement claims and independent reconciliation still require their own
evidence-producing executors and remain unqualified.

The profile binds the successor adapter to the committed real Groth16 fixture
identity (VKey and ELF SHA-256), wires the allocator's live proof-mode source
to the configuration executor, and installs the one-time allocator/reserve,
assurance/ratification, and prepared-controller/ratification bindings.

## Scope and limitation

This is a local deployment-topology profile, not a proof-admission-ready
configuration. The adapter address is only known after deployment, while the
canonical verifier-registry root commits to that address and is supplied to the
configuration executor at construction. The deployment plan derives the
registry root from the deployed adapter and requires PRF/Solidity root equality,
then independently derives C1 from approved C0 and the sealed instance. With
the separate approvals and transition request, the executor can perform the
successor registry selection and configuration transition. Admission and
production configuration remain unqualified until the composed proof/capital
flow has been observed.

Gate E remains the deployment-derived proof integration path: it creates and
seals the registry snapshot and configuration binding from the actual deployed
adapter. The committed Vector A proof fixture is a verifier regression vector,
not a replacement for a deployment-derived Gate E witness/proof.

The operation-specific entitlement representation is deployed or constructed
by the operation flow and is not part of this static topology profile.

The bounded local deployment composition is declared in
`successor-fork.plan.v1.json`, checked against `config/deployment-units.v1.json`.
The resolve/deploy commands pass this plan explicitly, so only its selected
14 contracts enter the resolved graph. When all selected stage prerequisites
are executable, deployment emits a plan execution receipt bound to its
manifest. Resume rechecks each recorded creation receipt, block and live
runtime bytecode.

The plan validator reports the first missing prerequisite and executable
deployment prefix. Fresh `deploy.ts --plan` runs retain evidence through
genesis sealing and registry-root derivation. With authenticated transition
inputs, resume continues through successor registry governance, C1 application,
downstream contract deployment and configured bootstrap bindings. Proof
admission, capital execution and independent reconciliation remain unsupported
by the deployment executor. The local run is deployment and configuration-
transition evidence only; it does not claim a proof-admission or capital-flow
run.

Plan validation command:

```bash
npm run validate:successor-fork-plan
```

This checks plan structure and unit/source ownership.

The local 0.4.2 bundle root is
`1c040be8f3364d303dc66cabd0bb676994c836eb4021e9216862dc991a9c3bae`; its
manifest SHA-256 is
`04b5b96971cb91b59adb294c3fc06ebf5de5061fabbe6328971702ebdcae3c41`.
Thirty-one artifact records are pinned in `fixtures/releases/0.4.2/packages`,
including `PrfEcdsaAuthorityTransitionValidator`.
The historical 0.4.1 bundle remains preserved for older profile and replay
tests; it is not the bundle selected by this bounded local deployment.
