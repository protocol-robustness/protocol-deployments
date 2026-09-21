# Protocol Deployments

Deployment composition and governance/deployment configuration for PRF, SEW,
and shared infrastructure. Consumes pinned deployable artifact packages from
the authoritative Solidity source repos (`prf-evm`, `sew-protocol`); it never
compiles their source.

See [docs/architecture.md](docs/architecture.md) for the full design and
[docs/assumptions.md](docs/assumptions.md) for assumptions and deferred work.

## Quick start

```bash
npm install
npm test                 # vitest: happy-path + adversarial validation
npm run typecheck        # tsc --noEmit

# Produce canonical resolved spec + deterministic spec hash
npm run resolve:local         # -> deployments/local.resolved.json
npm run resolve:base-sepolia  # -> deployments/base-sepolia.resolved.json
```

## Status

Phase 1 (schema + resolver) is complete and tested. No transactions are sent.
Phase 2 (real artifact bundle consumer) and Phase 3 (Hardhat execution +
ledger) are deferred.
