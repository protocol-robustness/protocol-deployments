# deployments/

Everything in this directory is **generated and gitignored** (see
`.gitignore`) — only this README is tracked. It is the working area for
resolved deployment specifications and the immutable deployment ledger of
observed results.

Generated here:

- `<environment>.resolved.json` — the canonical resolved deployment spec plus
  its deterministic `specHash`.
- `<environment>.deployment.json` — the durable execution ledger containing
  submitted, confirmed, and verified deployment records.
- `<environment>.<manifest-prefix>.deployment-manifest.v1.json` — the
  immutable, independently verifiable deployment facts.
- `<environment>.<manifest-prefix>.registry-binding-candidate.v1.json` — the
  minimal handoff candidate for PRF registry tooling.

The frozen resolved spec is separate from observed ledger state. The manifest
is produced only after all deployments, bootstrap actions, runtime-code checks,
and final assertions succeed.

## Reproduce the local pro-rata deployment

From the repository root:

```bash
npm run resolve:pro-rata-local   # -> deployments/pro-rata-local.resolved.json
npm run devnet:reset             # clear persisted local-chain state (does not start a chain)
npm run deploy:pro-rata-local    # -> deployments/pro-rata-local.deployment.json + manifest
```

`deploy` starts its own Anvil for the run when no devnet is already up, and
tears that one down afterwards. Start a devnet first with `npm run devnet:start`
if you want the chain to stay available for `npm run verify:live`.

The profile is fully local and synthetic. It deploys the PRF authority/genesis
and admission roots, a local snapshot token, the shortfall reserve, and the
pro-rata allocator. Its environment is explicitly marked `localOnly`, and the
registry candidate carries that marker so it cannot be mistaken for a
production registry release. The generated local addresses are deterministic
on a clean Anvil reset, but the deployment record and manifest remain ignored
working artifacts rather than canonical registry releases.

The registry candidate is intentionally not an index or lifecycle database. It
contains only roots that may be submitted to PRF registry tooling for separate
admission and publication. Its `candidateRoot` is derived from the sealed
manifest root plus the explicit projection/filter definition and selected roots;
it does not contain manually asserted protocol-state semantics.

## Retention of a sealed testnet deployment

This directory is local working state and is never committed, so a testnet
deployment is **not** retained here by default. For an auditable testnet run,
retain the sealed `<environment>.<root>.deployment-manifest.v1.json` and its
`protocol-deployment-verification/v1` artifact (from `verify:live`) outside this
working tree — for example in the environment's operational repo or an external
immutable store — and hand the `registry-binding-candidate/v1` to PRF registry
tooling for admission. The ledger that drives `--resume`
(`<environment>.deployment.json`) is transient execution state and need not be
retained once the manifest is sealed.
