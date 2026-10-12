# Base Sepolia successor-entitlement runbook

**Current status: blocked; no Base Sepolia deployment or transaction has been
made.** This document is an operator plan, not authority to broadcast. The
machine-readable inventory is
[`config/pro-rata-v2-entitlement/base-sepolia.profile.json`](../config/pro-rata-v2-entitlement/base-sepolia.profile.json).
Run its static integrity check with:

```bash
npm ci
npm run validate:base-sepolia-entitlement-profile
npm test -- --run test/successor-entitlement-profile.test.ts
```

This validates pinned artifact identity and the fail-closed blocked status. It
does not establish verifier admission or deployment qualification.

## Dependency map

```text
clean pinned prf-evm deployable bundle + successor SP1 program identity
        │
        ├─ deploy verifier and source-bound adapter
        │       └─ actual adapter address + immutable program fields
        │               └─ verifier registry root (deployment-derived)
        │                       └─ governed configuration transition
        │                               └─ immutable admission root/epoch
        │
        └─ deploy chain-instance genesis + authority
                └─ canonical genesis root from deployed addresses/code hashes
                        └─ genesis seal

admitted 288-byte statement + prepared operation + live reserve commitment
        └─ ratification/funding (atomic reserve → allocator)
                └─ deployed representation matches admitted root/count/total
                        └─ activation
                                └─ Requested/Required withdrawal
                                        └─ zero liability + closure
```

The current generic Base Sepolia environment is not this successor profile.
Its shared-token defaults previously described a newly deployed `PRF` token;
the Base overlay now binds `:shared/governance-token` to the existing SEW
contract and excludes that logical contract from deployment steps. External
dependencies are preflighted against chain ID, pinned runtime bytecode, and
declared capability assertions, then recorded in a V2 manifest observation.
The local environment still deploys its own `LOCAL` test token.

The generic Base environment remains intentionally **unqualified**. Its legacy
PRF verifier/admission declarations contain zero VKey, ELF, and configuration
root bindings, and privileged constructor roles are implicitly assigned to
the deployer. Public-network resolution now rejects those placeholders and
implicit authority bindings. Do not work around that guard or use the generic
Base command for the successor demo.

The Deployment Ledger owns pinned artifacts, deployment execution, immutable
deployment manifests, read-only runtime observations, and candidate artifacts.
It does not own governed verifier-registry admission or mutable configuration
state. Its current resolver/executor also cannot pause after deploying
address-dependent contracts, derive and seal the canonical chain-instance
genesis, compute the adapter-address-dependent registry root, obtain governed
selection, then construct admission with the selected immutable root/epoch.
That staged integration is a technical blocker; do not fill those roots with
synthetic constants.

## Pinned identities and controlled amounts

The inventory pins EVM deployables 0.4.0, bundle root
`566c4d62b254af86a687116faa50614b301065d3eef1052b3985418be54eb0ff`, from
clean source commit `353062b667e900b6735fea6fd7ef7a61fd5282e3`, and the successor
SP1 program, Groth16/Bn254 VKey, ELF SHA-256, and 288-byte public-values schema.
These are source/build pins only; actual Base runtime code and verifier
behavior remain unobserved.

The current generic topology expresses option B: it deploys a new
`GovGovernor` and `TimelockController` using SEW voting power. It does **not**
reuse an existing Sew Governor/Timelock deployment. The pinned Sew
`GovGovernor` artifact constructor accepts an `IVotes` token and timelock;
the current config sets a one-block voting delay, 50,400-block voting period,
50,000 SEW proposal threshold, and 4,000,000 SEW absolute quorum. The
TimelockController constructor is `(minDelay, proposers, executors, admin)`;
the config sets a one-day delay, an initially empty proposer set, open
execution, and the deployer as admin, then grants proposer role to the new
Governor. That leaves a second governance instance and an unresolved deployer
admin role. Token compatibility is not authorization to extend Sew governance
to PRF.

For the bounded controlled-shortfall demo, the least complex safe target is
option C: a separately named, explicitly approved configuration authority
(for example, an approved Safe) bound into PRF genesis/authority and the
verifier registry. No address is currently approved or pinned, so this is a
decision/blocker, not an active authority. Do not deploy the current generic
Governor/Timelock for PRF until its ownership and scope are approved. If
token-weighted governance is specifically required later, use the existing
SEW token only after the authority owner approves the governance instance,
quorum, threshold, timelock, and role-transfer plan.

Use the existing Sew Base Sepolia token, SEW, for governance only if that
governance model is approved. Its address is
`0x62BD47154D0b5Fe435F220E1294405040102b2ba`. The Sew repository's
`scripts/verify-base-sepolia-source.sh` records this address. Read-only RPC
read-only observation at Base Sepolia block 48,019,450 (hash
`0x6283a0cdd2d79d479b6dd69021506741dcd4c17ab413b572d717e31ab2c8bc12`)
returned name `Sew Token`, symbol `SEW`, 18 decimals, total supply
`1000000000000000000000000000`, `getVotes(address(0)) == 0`, and runtime code
hash `0xf619796a635e17ba7eb61f4b62eabf61421aa39c1fd1f71daddf31af0b9e1fcb`.
The observed runtime is 7,171 bytes and does **not** match the currently pinned
SewToken artifact runtime of 7,292 bytes (artifact runtime keccak
`0x7e1d33574eb372bd906255664212cc29ba8480cd5f1626622811cb76e5a4fa89`). The
`getVotes` call confirms that selector responds, but does not establish the
full verified source or complete `IVotes` behavior. External verification
therefore rejects this address against the current artifact until the
historical deployment artifact/source is independently pinned and reconciled.
The inspected Sew checkout does not contain its referenced
`deployments/baseSepolia/` records, so refresh and independently cross-check
the address at a pinned block before use. The selected governance token does
not resolve the separate governance-contract, quorum, authority, or signer
questions. The token is selected as the intended SEW voting source, but its
full deployed implementation identity and complete `IVotes` behavior remain
unverified; current vote delegation, eligible voter distribution, and
governance authorization also remain unqualified.
Do not create or deploy a new PRF token.

For the protected-operation demo, prefer Circle USDC on Base Sepolia at
`0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals). This is an
externally documented token identity, not yet a pinned-block runtime
observation in this profile. It is not yet declared as an external dependency
in an executable successor environment. Before use, verify code, code hash,
name, symbol, and decimals at one pinned block, then record that observation.
No token is to be deployed or minted by this workflow.

For the controlled 35/21/14 USDC example, use 6-decimal base units: Alice 35
USDC (`35000000`); Bob 21 USDC (`21000000`); Carol 14 USDC (`14000000`); total
70 USDC (`70000000`); deposit 80 USDC (`80000000`); protected capital 10 USDC
(`10000000`); available capital 70 USDC (`70000000`). This is a new
operation/witness and requires a fresh deployment-bound proof; the local
Vector A proof is not reusable for it.

## Authority matrix

| Role | Current binding | Required authority | State |
|---|---|---|---|
| Deployer | None selected | Deploy only; no implicit governance power | Pending signer reference |
| Governance administrator | None selected | Reviewed Safe/timelock bootstrap and recovery policy | Pending decision |
| Registry governor | Intended to be governed execution authority | Register/seal verifier entry and propose configuration selection | Pending deployed address and governance path |
| Operator | None selected | Operation-bound preparation and withdrawal only | Pending address and operation policy |
| Reviewer | None selected | Independently checks artifact, proof, manifest and transaction projections; no contract privilege | Pending reviewer identity/process |
| Funding authority | None selected | Fund approved token balance/allowance; reserve remains allocator's bound funding authority | Pending funded account and approvals |
| Beneficiaries | None selected | Stable smart-account or explicit immutable-address profile | Pending three recipient addresses |

No address may be copied from a local Anvil run or treated as a Base identity.
No private key belongs in this profile or the evidence package.

## 1. Preflight — read-only

From a fresh checkout of the pinned `protocol-deployments` revision:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm run validate:base-sepolia-entitlement-profile
```

Set `BASE_SEPOLIA_RPC_URL` through the operator's secret manager or shell; do
not put it in public artifacts. These calls are read-only:

```bash
cast chain-id --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast block-number --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast code "$BASE_SEW_GOVERNANCE_TOKEN_ADDRESS" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast codehash "$BASE_SEW_GOVERNANCE_TOKEN_ADDRESS" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$BASE_SEW_GOVERNANCE_TOKEN_ADDRESS" 'name()(string)' --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$BASE_SEW_GOVERNANCE_TOKEN_ADDRESS" 'symbol()(string)' --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$BASE_SEW_GOVERNANCE_TOKEN_ADDRESS" 'decimals()(uint8)' --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast code "$BASE_USDC_TOKEN_ADDRESS" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast codehash "$BASE_USDC_TOKEN_ADDRESS" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$BASE_USDC_TOKEN_ADDRESS" 'name()(string)' --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$BASE_USDC_TOKEN_ADDRESS" 'symbol()(string)' --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$BASE_USDC_TOKEN_ADDRESS" 'decimals()(uint8)' --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Expected chain ID is `84532`; each token's code hash/metadata must be recorded
at the same block and reviewed. These checks do not check balance/allowance or
prove the asset is approved for this operation.

Before any signed action, freeze full source revisions, clean/dirty state,
package lock, artifact bundle root, contract artifact hashes, SP1 program/VKey/
ELF/schema, and operation witness inputs. The validator above only checks the
currently pinned local release. It is not a fresh-checkout proof replay.

## 2. Authority and signer readiness — decision required

Agree a deployer, a non-deployer governance administrator, registry governor,
operator, reviewer, funded account and three stable beneficiaries. Decide
whether a Safe/timelock is the bootstrap and ongoing authority. Resolve the
Base governance-token/quorum mismatch by a dedicated entitlement governance
profile or an approved existing governance instance; do not change the general
PRF/SEW environment in this profile. Confirm the authority can execute both
the registry transition and configuration transition, with delayed/reviewed
activation appropriate to the selected lane.

**Approval point:** governance owners approve the authority matrix and
configuration proposal. No approval is implied by this runbook.

### Contract and authority audit

The generic architecture is a mixed Sew/PRF deployment template. It is not the
successor Shortfall deployment profile. Constructor inputs below were checked
against the checked-in pinned artifact ABIs:

| Logical contract | Pinned constructor shape / authority | Status for controlled Shortfall |
|---|---|---|
| `:shared/governance-token` | Sew `SewToken(name, symbol, initialOwner, initialSupply)` | Base declares external SEW and omits token deployment; external runtime currently mismatches the pinned artifact, so preflight rejects it. Local still deploys `LOCAL`. |
| `:shared/governor` | Sew `GovGovernor(token, timelock, votingDelay, votingPeriod, proposalThreshold, quorum, nonCirculating[])` | The generic Base plan creates a second Governor; it is neither a reference to nor authorization from an existing Sew Governor. Not selected for this demo. |
| `:shared/timelock` | `TimelockController(minDelay, proposers[], executors[], admin)` | Generic plan creates a new one-day Timelock, grants the new Governor proposer role, and leaves deployer as admin. Not selected for this demo. |
| `:prf/verifier-registry` | `PrfVerifierRegistry(governor_)`; only the exact configured governor can register/seal | Artifact is pinned in the general bundle; a demo registry must instead bind the approved explicit PRF configuration authority. No Base instance exists. |
| `:prf/allocation-verifier` | Legacy `PrfRealizedAllocationVerifierAdapter(sp1Verifier_, programVKey_, programElfSha256_, statementSchemaVersion_, publicValuesSchema_)` | Legacy generic declaration has zero VKey/ELF and binds the deployer EOA as `sp1Verifier_`. Not the successor adapter and not public-network qualified. |
| `:prf/statement-admission` | `PrfStatementAdmission(genesis_, configurationExecutor_, verifierRegistry_, expectedConfigurationRoot_, expectedConfigurationEpoch_)` | Legacy generic declaration binds genesis/configuration executor to deployer and uses zero expected root. It is invalid for public deployment and is excluded by the resolver guard. |
| `:sew/escrow-vault` | Sew `EscrowVault`; fee and module-management roles are constructor-bound | Broader Sew system component; not required for controlled Shortfall. Generic Base roles remain unqualified. |
| `:sew/decentralized-resolution-module` | Sew resolution module with separate ownership and PRF-verifier dependencies | Broader Sew system component; not required for controlled Shortfall. Not part of the successor topology. |

The successor artifacts themselves are pinned in the readiness inventory, but
none of the SP1 verifier, successor adapter, PRF genesis/authority, registry,
configuration executor, admission, prepared controller, allocator, reserve,
assurance, ratification controller, or entitlement representation has a
qualified Base deployment. Registry and configuration roots depend on actual
deployed identities and an approved authority, so they remain absent rather
than filled with guessed values.

Recommended bounded-demo authority is one explicitly approved configuration
Safe bound as the `governor` for both `PrfLocalAuthorityAdapter` and
`PrfVerifierRegistry`. The adapter grants no voting or timelock semantics; it
records decisions only from that exact configured authority. The Safe address
and signer policy are unresolved. SEW remains the selected token if a later
decision specifically requires token-weighted voting, but its use does not
authorize a new Sew Governor or PRF governance scope.

| Dependency | Classification | Identity / evidence | Gate |
|---|---|---|---|
| SEW token | External | `0x62BD47154D0b5Fe435F220E1294405040102b2ba`; Base Sepolia chain 84532; observation block/hash and code hash above | Current code fails pinned SewToken runtime comparison; resolve historical artifact/source first |
| USDC | External candidate | Circle Base Sepolia address `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Not yet runtime-observed or bound in successor deployment environment |
| Approved configuration Safe | Missing | No address or signer policy approved | Required before public configuration/registry changes |
| SP1 verifier, successor adapter, registry, genesis, authority, configuration executor, admission | Missing deployments; 0.4.0 artifacts pinned | Inventory in `base-sepolia.profile.json` | Deploy only after authority and staged root derivation are available |
| Controller, allocator, reserve, assurance, ratification, entitlements | Missing deployments; artifacts pinned | Successor 0.4.0 inventory | Bind/verify against the same deployment-derived operation |
| Sew Governor, Sew Timelock, Sew escrow, Sew resolution module | Not required | Present only in the generic Sew/PRF topology | Exclude from bounded Shortfall topology unless a separate Sew use is approved |

## 3–5. Deployment, registry selection, entitlement contracts

There is currently **no safe Base successor-entitlement resolve/deploy
command**. The generic Base resolver now fails closed on its zero roots and
deployer-bound authority roles. The local entitlement profile is 31337-only,
contains local topology assumptions, and has synthetic roots. Do not bypass
the resolver guard or treat the local profile as a Base deployment plan.

Required implementation before deployment:

1. Add a dedicated environment/profile using the exact artifacts pinned in the
   machine-readable inventory and the approved external token binding.
2. Add a staged deployment procedure: deploy genesis/authority and verifier /
   adapter / registry; derive canonical roots from actual deployed identities;
   seal genesis; construct or select governed configuration; then deploy
   `PrfStatementAdmission` with the exact active configuration root and epoch.
3. Use the existing registry and configuration contracts. Do not add a second
   registry or a deployment-ledger-owned mutable admission state.
4. Deploy controller, allocator, reserve, assurance and ratification contracts;
   verify constructor identities, runtime code, authority bindings, and exact
   token address at a pinned block. Bind each one-time controller relationship
   before admitting capital.
5. Deploy/construct the operation representation only from admitted table
   root/count/total and verify equality before activation.

**Signed transaction / governance approval points:** all contract deployments,
genesis sealing, registry registration/sealing, configuration proposal/queue/
execution, one-time authority bindings, token funding/allowance, and operation
preparation/ratification/activation. None is authorized or performed here.

## 6–10. Proof through closure — blocked on deployment

Materialize the witness only after the exact Base deployment manifest,
operation, configuration and live reserve snapshot exist. Recompute all
successor public values from raw/authenticated facts; reject caller-supplied
output roots. Generate a fresh Groth16 proof for that witness, verify locally
against the pinned successor VKey, and verify on-chain through the deployed
official SP1 verifier plus successor adapter and currently selected registry
snapshot. Convert it deterministically into the existing proof fixture shape;
do not manually duplicate VKey, ELF, roots, or public values.

Then exercise the protected route and retain submitted transaction hashes,
receipts, block identities, event projections, and independent state reads:

```text
proof → admission → prepared operation → live reserve freshness check
→ ratify + exact funding → representation root/count/total equality
→ activate → Requested withdrawal → Required withdrawal
→ claimed amount/count complete → zero liability → Closed
```

Also run the funded-but-not-activated `cancelAndRefund` branch and prove exact
refund accounting. Re-run adversarial cases for wrong proof/schema/VKey,
stale configuration/reserve, wrong operation/recipient, duplicate funding,
replay, over-withdrawal, route bypass, interruption/retry, and reentrancy. The
local independent replay report covers a fresh Anvil run only; it does not
substitute for a Base deployment-specific proof or chain observation.

## Failure handling and evidence

On stale assurance, use only the bound operation controller's stale-replacement
path and revalidate the live reserve commitment at ratification; never skip the
freshness check. On a failed atomic ratification/funding transaction, verify
both contract state and balances rolled back before retrying. Preserve
manifest, witness, proof fixture, verifier/config snapshots, signed
transactions, receipts and independent projections under a versioned evidence
bundle. Exclude RPC credentials, private keys, local absolute paths and unsigned
claims that imply trustless chain-state proof.

## Current gate assessment

- **Gate A — inventory:** completed for current local topology, artifact pins,
  proof identity, ledger boundary and known Base blockers. Not an independent
  Base deployment observation.
- **Gate B — Base deployment definition:** blocked profile and review runbook
  exist; executable Base profile and staged root derivation are missing.
- **Gate C — local deployment-specific qualification:** not tested by this
  task. The retained fresh-Anvil portable replay passed 4 Foundry tests and
  cross-linked 41 successful receipts, but its proof/deployment are local.
- **Base Sepolia:** not deployed or qualified; zero network transactions were
  submitted by this work.
