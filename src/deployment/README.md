# Deployment execution

This directory contains the deployment engine and the immutable deployment
evidence it produces:

| File | Responsibility |
| --- | --- |
| `engine.ts` | deploy one logical contract from the frozen resolved spec |
| `bootstrap.ts` | run declared initialization calls and their read-only assertions |
| `bindings.ts` | shared resolution of typed bindings against observed runtime facts |
| `execution-spec.ts` | materialize constructor bindings into the hashed execution spec |
| `record.ts` | the durable deployment record (reconciliation + `--resume` state) |
| `manifest.ts` | immutable manifest + registry-binding candidate, with the completeness gate |
| `live-verification.ts` | read-only re-verification of a sealed manifest against a live chain |

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
→ read chain id → read signer nonce → construct unsigned tx
→ estimate/determine gas → sign → eth_sendRawTransaction
→ wait receipt → verify success → eth_getCode → verify runtime bytecode → write deployment fact
```

Deployment is deliberately serial and nonce-boring (one tx, wait, next). No
parallel deployments, no speculative nonces, no tx replacement. CREATE2 is
disabled until a concrete factory protocol is implemented end-to-end, so there
is no address derivation step.

## Resolved vs deployment record

- `deployments/<env>.resolved.json` — the **frozen resolved deployment intent**
  (never mutated by execution).
- `deployments/<env>.deployment.json` — the **deployment record** (observed
  facts: addresses, txs, blocks, applied parameter values), linked by `specHash`.

A deployment fact stores the resolved parameter values applied at deploy time.
A later governance change never overwrites the original deployment fact.
