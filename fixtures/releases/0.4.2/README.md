# PRF-EVM deployables 0.4.2 local candidate fixture

This directory retains the locally rebuilt 30-artifact PRF-EVM bundle used by
bounded-configuration candidate v6. It is a review fixture, not a published
release or an authorization to deploy. Its source provenance is a Jujutsu
revision (`8ba7628bdfa46c1673aa15ba6205443ac1750ea9`), so non-local deployment
policy requiring a clean Git release continues to reject it.

- Bundle root: `5b9da0dfc6b1a2864d0ae174faef3ddf0095dab21b4a158de25aef677235b7ba`
- Manifest SHA-256: `2ecd59e9963fa4ae745b15a7b03c7f263806083717b2750bd689e562021425de`
- Source tree: candidate v6 lock `1ce2108ce7c2cda3e1ff7cdcfea351b4b2f5a689622aae0fa05b3a950f429523`
- Export validation: two identical bundle roots; core genesis, admission and authority artifacts loaded and validated by `BundleConsumer`
