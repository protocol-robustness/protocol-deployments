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

The current generic Base Sepolia environment configures the broader PRF/SEW
stack, not this successor profile. Its governance parameters also currently
set quorum to 4,000,000 PRF while the declared initial token supply is
1,000,000 PRF. That environment is not a usable governance authority plan for
this demonstration and is intentionally not modified here.

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

The proposed existing token candidate is Base Sepolia USDC at
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, read-only observed with 6
decimals and runtime code hash
`0xedc5281a85c0efecd49999a1ef668390c59b88702f2d4a07029d7f5d63059d6c` at
block 48017581. Refresh the observation at a chosen block and obtain explicit
asset/funding approval before using it. No balance, allowance, sponsorship or
token-owner approval is assumed. Do not deploy or mint a token on Base Sepolia.

For a human-readable 35/21/14 USDC example, the proof and reserve inputs must
use token base units: Alice 35,000,000; Bob 21,000,000; Carol 14,000,000; total
70,000,000; deposit 80,000,000; protected capital 10,000,000; available
capital 70,000,000. This is a new operation/witness and requires a fresh
deployment-bound proof; the local Vector A proof is not reusable for it.

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
cast code "$BASE_USDC_ADDRESS" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast codehash "$BASE_USDC_ADDRESS" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$BASE_USDC_ADDRESS" 'name()(string)' --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$BASE_USDC_ADDRESS" 'symbol()(string)' --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$BASE_USDC_ADDRESS" 'decimals()(uint8)' --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Expected chain ID is `84532`; token code hash/metadata must be recorded at the
same block and reviewed. These checks do not check balance/allowance or prove
the issuer/asset is approved for this operation.

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

## 3–5. Deployment, registry selection, entitlement contracts

There is currently **no safe Base successor-entitlement resolve/deploy
command**. The existing `resolve:base-sepolia` / `deploy:base-sepolia` commands
deploy the general PRF/SEW topology; the local entitlement profile is
31337-only, contains local topology assumptions, and has no-governance
placeholder roots. Do not run either as a substitute.

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
