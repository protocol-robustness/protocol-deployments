# PRO-95 Base Sepolia demonstration

**Status: preparation-only; blocked; no deployment or operation is enabled.**
**Classification: demonstration only, not a pre-mainnet release.**

This isolated profile records the approved Base Sepolia USDC scenario and its
evidence boundary. It does not select the existing generic Base Sepolia
SEW deployment, the USDC successor profile, or a V2 artifact package.

## Scenario

- Requests: Alice 50, Bob 30, Carol 20 USDC (100 total; 6-decimal base units are 50,000,000 / 30,000,000 / 20,000,000).
- Deposit: 80 USDC (80,000,000 base units), including 10 USDC restricted refundable units.
- Allocation: 35 / 21 / 14 USDC (35,000,000 / 21,000,000 / 14,000,000 base units) from the 70 USDC allocatable amount.
- 30 USDC requested are unmet requests, not funded entitlements or recognized
  claimant liabilities.
- The claimant withdrawals total 70. Carol’s separate 10-unit restricted
  refund is a distinct action.

The asset is Circle Base Sepolia testnet USDC, `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, with 6 decimals. It is not mainnet-redeemable USDC, and this workflow will not mint it. The same address is referenced in the SEW Aave Base Sepolia integration sources; this PRO-95 workflow does not use Aave.
Recipients are approved pseudonymous test wallets. Their addresses do not
authenticate claimant identities. One dedicated test-only EOA is recorded for
deployment, USDC funding, configuration authority and relayed withdrawals. Its observed balance was zero; no private key is stored here.

## Why this profile is blocked

The retained V3 qualification is a local Foundry execution on chain ID 31337.
The deployment repository’s pinned 0.4.2 bundle does not contain the exact V3
reserve and demo token/operator composition. The V3 local proof is bound to
local addresses and cannot be reused on Base Sepolia. A separate clean,
committed artifact bundle, staged deployment plan, Base-bound witness/proof,
and dry-run are required. Do not replace these with the existing USDC/V2
profile or with a mock verifier.

The profile has no deployment plan or transaction budget. It explicitly keeps
deployment, operation and broadcast disabled. No gas cap or funding amount is
set. Base finality is not claimed; the intended future evidence class is
receipt inclusion under an independently reviewed external header pin.

## Files

- [`profile.v1.json`](./profile.v1.json) — scenario, source identity, exact
  candidate roots, boundaries and readiness blockers.
- [`README.md`](./README.md) — orientation and demo-only qualification scope.

The source-of-truth owner decisions, canonical root derivation outputs, and
Stage B verification remain in
the PRF workspace file `examples/partial-fill/pro-95-base-sepolia-demo/`. This directory is
the deployment repository’s organized intake record, not a second evidence
registry.
