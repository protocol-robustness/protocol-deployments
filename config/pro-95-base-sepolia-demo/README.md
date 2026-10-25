# PRO-95 Base Sepolia demonstration

**Status: preparation-only; blocked; no deployment or operation is enabled.**
**Classification: demonstration only, not a pre-mainnet release.**

This isolated profile records the approved Base Sepolia USDC scenario and its
evidence boundary. It does not select the existing generic Base Sepolia
SEW deployment, the USDC successor profile, or a V2 artifact package.

## Critical qualifications

1. **Finality:** No Base or Ethereum consensus finality is established. The
   intended maximum public-chain claim is receipt inclusion under an
   independently reviewed external header pin. That would not establish Base
   `safe`/`finalized` status or Ethereum L1 settlement/finality. No Base
   transaction or receipt currently exists, so even receipt inclusion has not
   yet been demonstrated.
2. **Execution:** The retained V3 run is local Foundry evidence on chain ID
   `31337`; it does not establish Base Sepolia execution. Deployment,
   operation, signing and broadcast remain disabled.
3. **Inputs and identity:** Source authentication has not been performed for
   the modelled inputs. Recipient addresses are pseudonymous test wallets and
   do not establish claimant identity or external obligations.
4. **Asset:** Circle Base Sepolia USDC is testnet-only, is not mainnet
   redeemable, and does not represent real-value liquidity. Read-only code and
   metadata observations do not authenticate issuer sources or test transfer
   behavior.
5. **Application and release scope:** This does not demonstrate an operating
   stablecoin, reserve backing, redemption, compliance, production readiness,
   or a pre-mainnet release.

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

## Current read-only token observation

[`observations/usdc-read-only-20261025.json`](./observations/usdc-read-only-20261025.json)
records matching reads from the Base public RPC and PublicNode at one common
block. It records the token proxy and implementation code hashes, pointer,
metadata, pause state, and the approved test payer's block-scoped balances.
This is an unqualified observation: matching responses do not establish
provider independence, issuer source authentication, transfer behavior,
finality, future funding, or approval to deploy or transact. Reproduce a fresh
observation with:

```bash
npm run observe:pro-95-base-sepolia-usdc -- /tmp/pro-95-usdc-observation.json
```

The command is read-only, fails if the two providers disagree, and refuses to
overwrite an existing output file. It does not sign or broadcast transactions.

## Files

- [`profile.v1.json`](./profile.v1.json) — scenario, source identity, exact
  candidate roots, boundaries and readiness blockers.
- [`README.md`](./README.md) — orientation and demo-only qualification scope.

The source-of-truth owner decisions, canonical root derivation outputs, and
Stage B verification remain in
the PRF workspace file `examples/partial-fill/pro-95-base-sepolia-demo/`. This directory is
the deployment repository’s organized intake record, not a second evidence
registry.
