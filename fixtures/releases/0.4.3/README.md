# PRF-EVM deployables 0.4.3 local V3 candidate

This 32-artifact bundle adds the `OnchainShortfallReserveV3` artifact needed
by the controlled Partial Fill V3 example. Bundle root:

`d416816527400fcc7bc7455a1486c1bc20cb94ed556473d0c695a83ea09e2dba`

The source revision recorded in its manifest is
`f23fcfc2d0f58e2be5732c0c37ddb179c323d513`. It was exported from a local JJ
workspace using an explicit `GIT_SHA` override (`commitSource: env`,
`commitOverride: true`). The source revision is not published as a clean Git
release. This is therefore a review fixture only; non-local deployment policy
must reject it. It is not a deployment approval, Base Sepolia qualification,
or pre-mainnet release.

The default Foundry profile used Solidity 0.8.33, optimizer runs 200, and
`viaIR: true`. The exporter validator passed 32/32 artifacts and its
repeat-export/tamper tests passed 10/10. A fresh-checkout build from the
published source revision is still required before this can be used as a
pinned non-local package.
