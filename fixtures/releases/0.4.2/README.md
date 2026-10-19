# PRF-EVM deployables 0.4.2 local candidate fixture

This directory retains the locally rebuilt 31-artifact PRF-EVM bundle used by
bounded-configuration candidate v8. It is a review fixture, not a published
release or an authorization to deploy. Its source provenance is a local
integrated revision (`0dad4c2790a60ecca9a41c5d518f99522eab94ce`), so non-local
deployment policy requiring a clean tagged Git release continues to reject it.

- Bundle root: `1c040be8f3364d303dc66cabd0bb676994c836eb4021e9216862dc991a9c3bae`
- Manifest SHA-256: `04b5b96971cb91b59adb294c3fc06ebf5de5061fabbe6328971702ebdcae3c41`
- Source revision: `0dad4c2790a60ecca9a41c5d518f99522eab94ce`
- Export validation: 31 allow-listed artifacts, including the immutable EIP-191 authority-transition validator; `pnpm deployables:test` passes 10/10
