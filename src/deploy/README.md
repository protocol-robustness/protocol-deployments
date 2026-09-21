# Deployment execution

This directory contains the deployment engine (`engine.ts`) and the immutable
deployment record (`record.ts`).

The engine executes the **frozen resolved spec** against an ordinary
**JSON-RPC** endpoint via a thin transport and a local signer. It is:

- Hardhat-independent
- Forge-independent
- Anvil-independent
- provider-independent

The canonical submission path is `eth_sendRawTransaction` (the node never holds
the signing key). viem is used for the mechanical Ethereum primitives (ABI/
constructor encoding, transaction serialization, signing, keccak, receipt
normalization) — never for orchestration.

## Pipeline

```
load artifact → verify identity/hashes → resolve constructor args → encode init code
→ derive/validate expected address (CREATE2) → read chain id → read signer nonce
→ construct unsigned tx → estimate/determine gas → sign → eth_sendRawTransaction
→ wait receipt → verify success → eth_getCode → verify runtime bytecode → write deployment fact
```

Deployment is deliberately serial and nonce-boring (one tx, wait, next). No
parallel deployments, no speculative nonces, no tx replacement.

## Resolved vs deployment record

- `deployments/<env>.resolved.json` — the **frozen resolved deployment intent**
  (never mutated by execution).
- `deployments/<env>.deployment.json` — the **deployment record** (observed
  facts: addresses, txs, blocks, applied parameter values), linked by `specHash`.

A deployment fact stores the resolved parameter values applied at deploy time.
A later governance change is recorded as a separate governance action and never
overwrites the original deployment fact.
